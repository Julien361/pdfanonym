// Conversion d'un PDF en niveaux de gris SANS le rastériser : le texte reste du texte.
// Principe : on réécrit les opérateurs de couleur des flux de contenu (rg, k, sc, scn…), on convertit les images
// et les palettes indexées, récursivement dans les Form XObjects et les apparences d'annotations.
// Limites connues (signalées à l'appelant) : dégradés (sh, motifs de dégradé), couleurs d'accompagnement (Separation/DeviceN)
// et images en ligne (BI … EI) restent tels quels.

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %
const enc = new TextEncoder();
const dec = new TextDecoder("latin1");

// resolve() plante sur un objet nul dans mupdf.js : on le garde tel quel.
const R = (o) => (o && !o.isNull() ? o.resolve() : o);
const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;
const cmyk2gray = (c, m, y, k) => Math.max(0, 1 - Math.min(1, 0.3 * c + 0.59 * m + 0.11 * y + k));
const fmt = (v) => (Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000).toString();

// Découpe un flux de contenu en jetons { s, e, kind, v } (kind : num, name, str, hex, dict, array, op).
function* tokens(buf) {
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const c = buf[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && buf[i] !== 10 && buf[i] !== 13) i++; continue; } // commentaire
    const s = i;
    if (c === 47) { // nom
      i++;
      while (i < n && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
      yield { s, e: i, kind: "name", v: dec.decode(buf.subarray(s + 1, i)) };
    } else if (c === 40) { // chaîne littérale, parenthèses imbriquées et échappements
      let depth = 0;
      for (; i < n; i++) {
        const ch = buf[i];
        if (ch === 92) { i++; continue; }
        if (ch === 40) depth++;
        else if (ch === 41 && --depth === 0) { i++; break; }
      }
      yield { s, e: i, kind: "str" };
    } else if (c === 60 && buf[i + 1] === 60) { // dictionnaire << >>
      let depth = 0;
      for (; i < n; i++) {
        if (buf[i] === 40) { const t = tokens(buf.subarray(i)).next().value; i += t.e - 1; continue; }
        if (buf[i] === 60 && buf[i + 1] === 60) { depth++; i++; }
        else if (buf[i] === 62 && buf[i + 1] === 62) { i++; if (--depth === 0) { i++; break; } }
      }
      yield { s, e: i, kind: "dict" };
    } else if (c === 60) { // chaîne hexadécimale
      while (i < n && buf[i] !== 62) i++;
      i++;
      yield { s, e: i, kind: "hex" };
    } else if (c === 91) { // tableau (opérande de TJ, d…)
      let depth = 0;
      for (; i < n; i++) {
        const ch = buf[i];
        if (ch === 40) { const t = tokens(buf.subarray(i)).next().value; i += t.e - 1; continue; }
        if (ch === 91) depth++;
        else if (ch === 93 && --depth === 0) { i++; break; }
      }
      yield { s, e: i, kind: "array" };
    } else if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) {
      i++; // délimiteur isolé (contenu mal formé) : on l'ignore
    } else {
      while (i < n && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
      const word = dec.decode(buf.subarray(s, i));
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) yield { s, e: i, kind: "num", v: parseFloat(word) };
      else if (word === "true" || word === "false" || word === "null") yield { s, e: i, kind: "num", v: 0 };
      else {
        yield { s, e: i, kind: "op", v: word };
        if (word === "ID") { // données d'image en ligne : on saute jusqu'à « EI »
          i++;
          while (i < n - 2 && !(WS.has(buf[i - 1]) && buf[i] === 69 && buf[i + 1] === 73 && (i + 2 >= n || WS.has(buf[i + 2]) || DELIM.has(buf[i + 2])))) i++;
        }
      }
    }
  }
}

export function createConverter(mupdf, doc) {
  const seen = new Set();          // objets déjà convertis (numéro d'objet)
  const report = { streams: 0, images: 0, palettes: 0, shadings: 0, spot: 0, inline: 0 };
  const DeviceGray = mupdf.ColorSpace.DeviceGray;

  const once = (obj) => {
    if (!obj.isIndirect()) return true;
    const k = obj.asIndirect();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };

  // Nature d'un espace couleur : { kind: gray|rgb|cmyk|lab|indexed|pattern|other }.
  function spaceKind(cs) {
    cs = cs.resolve();
    if (cs.isName()) {
      const n = cs.asName();
      if (n === "DeviceGray" || n === "CalGray" || n === "G") return "gray";
      if (n === "DeviceRGB" || n === "CalRGB" || n === "RGB") return "rgb";
      if (n === "DeviceCMYK" || n === "CMYK") return "cmyk";
      if (n === "Pattern") return "pattern";
      return "other";
    }
    if (cs.isArray()) {
      const fam = cs.get(0).asName();
      if (fam === "ICCBased") {
        const nComp = R(cs.get(1)).get("N");
        const N = nComp.isNull() ? 3 : nComp.asNumber();
        return N === 1 ? "gray" : N === 4 ? "cmyk" : "rgb";
      }
      if (fam === "CalRGB") return "rgb";
      if (fam === "CalGray") return "gray";
      if (fam === "Lab") return "lab";
      if (fam === "Indexed" || fam === "I") return "indexed";
      if (fam === "Pattern") return "pattern";
      return "other"; // Separation, DeviceN
    }
    return "other";
  }

  function toGray(kind, vals) {
    if (kind === "gray") return vals[0] ?? 0;
    if (kind === "rgb") return lum(vals[0] ?? 0, vals[1] ?? 0, vals[2] ?? 0);
    if (kind === "cmyk") return cmyk2gray(vals[0] ?? 0, vals[1] ?? 0, vals[2] ?? 0, vals[3] ?? 0);
    if (kind === "lab") return (vals[0] ?? 0) / 100;
    return null;
  }

  // Palette indexée → palette grise (sur place).
  function convertIndexed(cs) {
    cs = cs.resolve();
    if (!once(cs) && cs.isIndirect()) return;
    const baseKind = spaceKind(cs.get(1));
    if (baseKind === "gray" || baseKind === "other" || baseKind === "indexed") return;
    const hival = cs.get(2).asNumber();
    const lk = cs.get(3);
    const bytes = lk.isStream() ? lk.readStream().asUint8Array().slice() : lk.asByteString().slice();
    const N = baseKind === "cmyk" ? 4 : 3;
    const out = new Uint8Array(hival + 1);
    for (let i = 0; i <= hival; i++) {
      const v = [...bytes.subarray(i * N, i * N + N)].map((x) => x / 255);
      out[i] = Math.round((baseKind === "lab" ? v[0] : toGray(baseKind, v)) * 255);
    }
    cs.put(1, doc.newName("DeviceGray"));
    cs.put(3, doc.newByteString(out));
    report.palettes++;
  }

  function convertImage(ref) {
    const obj = ref; // garder la référence : un flux « résolu » n'est plus reconnu comme flux
    if (!once(ref)) return;
    if (obj.get("ImageMask").valueOf() === true) return;
    const csObj = obj.get("ColorSpace");
    if (!csObj.isNull() && spaceKind(csObj) === "gray") return;
    if (!csObj.isNull() && spaceKind(csObj) === "other") { report.spot++; return; }
    let img, pix, gray;
    try {
      img = doc.loadImage(ref);
      pix = img.toPixmap();
      if (pix.getNumberOfComponents() - pix.getAlpha() === 1) return;
      gray = pix.convertToColorSpace(DeviceGray, true);
    } catch { return; } finally { pix?.destroy?.(); img?.destroy?.(); }
    try {
      // Filtre d'origine (nom ou liste) : une source avec perte (JPEG, JPEG 2000) est réencodée en JPEG, sinon sans perte.
      const f = obj.get("Filter");
      const filters = f.isArray() ? Array.from({ length: f.length }, (_, k) => f.get(k).asName()) : f.isName() ? [f.asName()] : [];
      const lossy = filters.some((x) => ["DCTDecode", "DCT", "JPXDecode"].includes(x));
      const w = gray.getWidth(), h = gray.getHeight(), stride = gray.getStride(), px = gray.getPixels();
      const n = gray.getNumberOfComponents(); // 1, ou 2 si alpha (l'alpha reste porté par le SMask d'origine)
      const raw = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = px[y * stride + x * n];
      if (lossy) {
        const plain = new mupdf.Pixmap(DeviceGray, [0, 0, w, h], false);
        plain.getPixels().set(raw);
        obj.writeRawStream(plain.asJPEG(80, false));
        plain.destroy();
        obj.put("Filter", doc.newName("DCTDecode"));
      } else {
        obj.writeStream(raw);
        if (!obj.get("Filter").isNull()) obj.delete("Filter");
      }
    } finally { gray.destroy(); }
    obj.put("ColorSpace", doc.newName("DeviceGray"));
    obj.put("BitsPerComponent", 8);
    for (const k of ["DecodeParms", "Decode", "Intent"]) if (!obj.get(k).isNull()) obj.delete(k);
    if (obj.get("Mask").isArray()) obj.delete("Mask"); // masque par plage de couleurs, devenu invalide
    report.images++;
  }

  // Réécrit un flux de contenu ; resources = dictionnaire de ressources applicable.
  function rewrite(buf, resources) {
    const csRes = resources.isDictionary() ? R(resources.get("ColorSpace")) : null;
    const resolveSpace = (name) => {
      if (["DeviceGray", "DeviceRGB", "DeviceCMYK", "Pattern", "G", "RGB", "CMYK"].includes(name)) return spaceKind(doc.newName(name));
      const def = csRes && csRes.isDictionary() ? csRes.get(name) : null;
      if (!def || def.isNull()) return "other";
      const k = spaceKind(def);
      if (k === "indexed") convertIndexed(def);
      return k;
    };
    const out = [];
    let last = 0, ops = [];
    let gs = { fill: "gray", stroke: "gray" };
    const stack = [];
    const replace = (from, to, text) => { out.push(buf.subarray(last, from), enc.encode(text)); last = to; };
    for (const t of tokens(buf)) {
      if (t.kind !== "op") { ops.push(t); continue; }
      const op = t.v;
      const nums = ops.filter((o) => o.kind === "num").map((o) => o.v);
      const from = ops.length ? ops[0].s : t.s;
      switch (op) {
        case "q": stack.push({ ...gs }); break;
        case "Q": gs = stack.pop() || gs; break;
        case "rg": case "RG":
          replace(from, t.e, `${fmt(lum(nums[0], nums[1], nums[2]))} ${op === "rg" ? "g" : "G"}`); break;
        case "k": case "K":
          replace(from, t.e, `${fmt(cmyk2gray(nums[0], nums[1], nums[2], nums[3]))} ${op === "k" ? "g" : "G"}`); break;
        case "cs": case "CS": {
          const nameTok = ops.find((o) => o.kind === "name");
          const kind = nameTok ? resolveSpace(nameTok.v) : "other";
          const key = op === "cs" ? "fill" : "stroke";
          if (["rgb", "cmyk", "lab", "gray"].includes(kind)) { gs[key] = kind; replace(from, t.e, `/DeviceGray ${op}`); }
          else { gs[key] = kind; if (kind === "other") report.spot++; }
          break;
        }
        case "sc": case "scn": case "SC": case "SCN": {
          const kind = op === "sc" || op === "scn" ? gs.fill : gs.stroke;
          const g = toGray(kind, nums);
          if (g !== null && !ops.some((o) => o.kind === "name")) replace(from, t.e, `${fmt(g)} ${op}`);
          break;
        }
        case "sh": report.shadings++; break;
        case "BI": report.inline++; break;
        case "Do": {
          const nameTok = ops.find((o) => o.kind === "name");
          const xo = resources.isDictionary() ? R(resources.get("XObject")) : null;
          if (nameTok && xo && xo.isDictionary()) {
            const ref = xo.get(nameTok.v);
            if (!ref.isNull()) {
              const st = ref.get("Subtype");
              const sub = st.isName() ? st.asName() : "";
              if (sub === "Image") convertImage(ref);
              else if (sub === "Form") convertForm(ref, resources);
            }
          }
          break;
        }
      }
      ops = [];
    }
    if (!out.length) return null; // rien à changer dans ce flux
    out.push(buf.subarray(last));
    const total = out.reduce((a, b) => a + b.length, 0);
    const res = new Uint8Array(total);
    let o = 0;
    for (const b of out) { res.set(b, o); o += b.length; }
    return res;
  }

  function convertForm(ref, parentRes) {
    const obj = ref;
    if (!once(ref)) return;
    const own = obj.get("Resources");
    const res = own.isNull() ? parentRes : R(own);
    const nb = rewrite(obj.readStream().asUint8Array().slice(), res);
    if (nb) { obj.writeStream(nb); report.streams++; }
    const grp = obj.get("Group");
    if (grp.isDictionary() && !grp.get("CS").isNull()) grp.put("CS", doc.newName("DeviceGray"));
  }

  function convertPage(i) {
    const page = doc.findPage(i);
    const res = R(page.getInheritable("Resources"));
    const contents = page.get("Contents");
    const parts = contents.isArray() ? Array.from({ length: contents.length }, (_, k) => contents.get(k)) : contents.isStream() ? [contents] : [];
    if (parts.length) {
      // Les flux multiples sont concaténés (un opérande peut être dans un flux et l'opérateur dans le suivant).
      const chunks = parts.map((p) => p.readStream().asUint8Array().slice());
      const joined = new Uint8Array(chunks.reduce((a, c) => a + c.length + 1, 0));
      let o = 0;
      for (const c of chunks) { joined.set(c, o); o += c.length; joined[o++] = 10; }
      const nb = rewrite(joined, res);
      if (nb) { page.put("Contents", doc.addStream(nb, {})); report.streams++; }
    }
    const grp = page.get("Group");
    if (grp.isDictionary() && !grp.get("CS").isNull()) grp.put("CS", doc.newName("DeviceGray"));
    // Apparences des annotations (commentaires, tampons, champs)
    const annots = page.get("Annots");
    if (annots.isArray()) {
      annots.forEach((a) => {
        const ap = a.get("AP");
        if (!ap.isDictionary()) return;
        ap.forEach((v) => {
          if (v.isStream()) convertForm(v, res);
          else if (v.isDictionary()) v.forEach((s) => { if (s.isStream()) convertForm(s, res); });
        });
      });
    }
  }

  return {
    report,
    run() { for (let i = 0; i < doc.countPages(); i++) convertPage(i); return report; },
  };
}
