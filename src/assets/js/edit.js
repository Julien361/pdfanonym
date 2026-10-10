// Ajouts sur les pages (texte, image, filigrane, numéros), sécurité, compression, conversions images ↔ PDF.
// Les positions sont exprimées dans le repère VISUEL de la page (origine en haut à gauche, y vers le bas, en points),
// celui que voit l'utilisateur : la conversion vers le repère PDF tient compte de /Rotate et de la CropBox.

const WINANSI = { 0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88,
  0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94,
  0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f };

// Texte → octets WinAnsi (police standard Helvetica) ; caractères hors jeu remplacés par « ? ».
export function winAnsi(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (WINANSI[c]) out.push(WINANSI[c]);
    else out.push(0x3f);
  }
  return out;
}
const hex = (bytes) => "<" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("") + ">";
const n = (v) => (Math.round(v * 1000) / 1000).toString();
const m6 = (m) => m.map(n).join(" ");

// Contexte d'ajout pour un document : police et ressources partagées.
export function stamper(mupdf, doc) {
  const fontObj = {};
  const helv = new mupdf.Font("Helvetica");
  const helvB = new mupdf.Font("Helvetica-Bold");
  const fontRef = (bold) => (fontObj[bold ? "b" : "r"] ||= doc.addSimpleFont(bold ? helvB : helv, "Latin"));
  const width = (text, size, bold) => {
    const f = bold ? helvB : helv;
    let w = 0;
    for (const ch of text) w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)));
    return w * size;
  };

  // Ressources propres à la page (les ressources héritées sont recopiées pour ne pas modifier les autres pages).
  function pageResources(pageObj) {
    let res = pageObj.get("Resources");
    if (res.isNull()) {
      const inh = pageObj.getInheritable("Resources");
      res = doc.newDictionary();
      if (!inh.isNull()) inh.forEach((v, k) => res.put(k, v));
      pageObj.put("Resources", res);
    }
    return res;
  }
  function addRes(res, kind, prefix, value) {
    let dict = res.get(kind);
    if (dict.isNull()) { dict = doc.newDictionary(); res.put(kind, dict); }
    let i = 1;
    while (!dict.get(prefix + i).isNull()) i++;
    dict.put(prefix + i, value);
    return prefix + i;
  }

  // Ajoute un flux de contenu en fin de page, l'original étant isolé entre q … Q.
  function append(pageIndex, build) {
    const page = doc.loadPage(pageIndex);
    const pageObj = page.getObject();
    const res = pageResources(pageObj);
    const toUser = mupdf.Matrix.invert(page.getTransform()); // repère visuel → repère PDF
    const body = build({ res, addRes: (k, p, v) => addRes(res, k, p, v), bounds: page.getBounds() });
    if (!body) return;
    const stream = `q ${m6(toUser)} cm\n${body}\nQ\n`;
    const contents = pageObj.get("Contents");
    const arr = doc.newArray();
    arr.push(doc.addStream("q\n", {}));
    if (contents.isArray()) contents.forEach((c) => arr.push(c));
    else if (!contents.isNull()) arr.push(contents);
    arr.push(doc.addStream("Q\n", {}));
    arr.push(doc.addStream(stream, {}));
    pageObj.put("Contents", arr);
  }

  const gs = (addRes, opacity) => (opacity < 1 ? `/${addRes("ExtGState", "PaGS", doc.addObject({ Type: "ExtGState", ca: opacity, CA: opacity }))} gs ` : "");

  // Texte : x, y = point d'ancrage visuel (ligne de base), align left|center|right, angle en degrés (sens horaire à l'écran).
  function text(pageIndex, { text, x, y, size = 12, color = [0, 0, 0], opacity = 1, angle = 0, align = "left", bold = false }) {
    if (!text) return;
    append(pageIndex, ({ addRes }) => {
      const f = addRes("Font", "PaF", fontRef(bold));
      const w = width(text, size, bold);
      const dx = align === "center" ? -w / 2 : align === "right" ? -w : 0;
      const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      // Repère visuel (y vers le bas) : on retourne l'axe y pour que le texte soit à l'endroit.
      const tm = [c, s, s, -c, x + dx * c, y + dx * s];
      return `${gs(addRes, opacity)}${color.map(n).join(" ")} rg BT /${f} ${n(size)} Tf ${m6(tm)} Tm ${hex(winAnsi(text))} Tj ET`;
    });
  }

  // Image (PNG/JPEG) : x, y = coin supérieur gauche visuel, w, h en points.
  function image(pageIndex, { bytes, x, y, w, h, opacity = 1 }) {
    const img = new mupdf.Image(bytes);
    const ref = doc.addImage(img);
    append(pageIndex, ({ addRes }) => {
      const name = addRes("XObject", "PaIm", ref);
      return `${gs(addRes, opacity)}q ${n(w)} 0 0 ${n(-h)} ${n(x)} ${n(y + h)} cm /${name} Do Q`;
    });
  }

  return { text, image, width };
}

/* ---------- Filigrane et numérotation ---------- */

export function watermark(mupdf, doc, { text, size = 0, opacity = 0.18, color = [0.5, 0.5, 0.5], angle = -45, pages = null }) {
  const st = stamper(mupdf, doc);
  const count = doc.countPages();
  for (let i = 0; i < count; i++) {
    if (pages && !pages.includes(i)) continue;
    const b = doc.loadPage(i).getBounds();
    const W = b[2] - b[0], H = b[3] - b[1];
    // Taille automatique : le texte occupe environ 70 % de la diagonale (ou de la largeur si horizontal).
    const span = angle ? Math.hypot(W, H) * 0.7 : W * 0.8;
    const fs = size || Math.max(12, Math.min(160, span / Math.max(1, st.width(text, 1, true))));
    st.text(i, { text, x: W / 2, y: H / 2 + fs * 0.35 * Math.cos((angle * Math.PI) / 180), size: fs, color, opacity, angle, align: "center", bold: true });
  }
}

export function pageNumbers(mupdf, doc, { position = "bottom-center", format = "{n}", start = 1, size = 11, margin = 28, skipFirst = false, color = [0, 0, 0] }) {
  const st = stamper(mupdf, doc);
  const total = doc.countPages();
  const shown = total - (skipFirst ? 1 : 0);
  for (let i = 0; i < total; i++) {
    if (skipFirst && i === 0) continue;
    const num = start + i - (skipFirst ? 1 : 0);
    const label = format.replaceAll("{n}", num).replaceAll("{total}", start + shown - 1);
    const b = doc.loadPage(i).getBounds();
    const W = b[2] - b[0], H = b[3] - b[1];
    const [v, h] = position.split("-");
    const y = v === "top" ? margin + size * 0.8 : H - margin;
    const x = h === "left" ? margin : h === "right" ? W - margin : W / 2;
    st.text(i, { text: label, x, y, size, color, align: h === "left" ? "left" : h === "right" ? "right" : "center" });
  }
}

/* ---------- Mot de passe ---------- */

export function protectOptions({ userPassword, ownerPassword, allowPrint = true, allowCopy = false, allowEdit = false }) {
  // Bits de permission PDF : 3 = imprimer, 4 = modifier, 5 = copier, 6 = annoter, 9 = remplir, 10 = accessibilité, 12 = impression HD.
  let p = 0xfffff0c0 | (1 << 9); // bits réservés + accessibilité toujours autorisée
  if (allowPrint) p |= (1 << 2) | (1 << 11);
  if (allowEdit) p |= (1 << 3) | (1 << 5) | (1 << 8) | (1 << 10);
  if (allowCopy) p |= 1 << 4;
  const owner = ownerPassword || Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  // Le moteur sépare ses options par des virgules, sans échappement : l'interface refuse les mots de passe qui en contiennent.
  if (/,/.test(userPassword) || /,/.test(owner)) throw new Error("comma");
  return `garbage=compact,compress,encrypt=aes-256,user-password=${userPassword},owner-password=${owner},permissions=${p | 0}`;
}

/* ---------- Compression ---------- */

// Réduction d'une image RGB/gris en JS (moyenne par zone) jusqu'à maxSide pixels.
function downscale(mupdf, pix, maxSide) {
  const w = pix.getWidth(), h = pix.getHeight();
  const k = Math.min(1, maxSide / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
  const comps = pix.getNumberOfComponents(), alpha = pix.getAlpha(), base = comps - alpha;
  const src = pix.getPixels().slice(), stride = pix.getStride();
  const cs = base === 1 ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
  const out = new mupdf.Pixmap(cs, [0, 0, nw, nh], false);
  const dst = new Uint8Array(nw * nh * base);
  const fx = w / nw, fy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      for (let c = 0; c < base; c++) {
        let sum = 0, cnt = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += src[yy * stride + xx * comps + c]; cnt++; }
        dst[(y * nw + x) * base + c] = sum / cnt;
      }
    }
  }
  out.getPixels().set(dst);
  return out;
}

export const COMPRESS_LEVELS = { light: { dpi: 220, q: 85 }, recommended: { dpi: 150, q: 72 }, strong: { dpi: 100, q: 55 } };

export function compress(mupdf, doc, level = "recommended") {
  const { dpi, q } = COMPRESS_LEVELS[level] || COMPRESS_LEVELS.recommended;
  const seen = new Set();
  const report = { images: 0, resized: 0 };
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const b = page.getBounds();
    // Une image n'est jamais affichée plus grande que la page : on borne sa résolution à celle de la page au dpi visé.
    const maxSide = Math.ceil((Math.max(b[2] - b[0], b[3] - b[1]) / 72) * dpi);
    const walk = (res) => {
      if (res.isNull()) return;
      const xo = res.get("XObject");
      if (!xo.isDictionary()) return;
      xo.forEach((ref) => {
        if (!ref.isIndirect() || seen.has(ref.asIndirect())) return;
        seen.add(ref.asIndirect());
        const st = ref.get("Subtype");
        if (!st.isName()) return;
        if (st.asName() === "Form") return walk(ref.get("Resources"));
        if (st.asName() !== "Image" || ref.get("ImageMask").valueOf() === true) return;
        const bpc = ref.get("BitsPerComponent");
        if (!bpc.isNull() && bpc.asNumber() < 8) return; // images 1 bit (scans N&B) : déjà compactes
        const f = ref.get("Filter");
        const filters = f.isArray() ? Array.from({ length: f.length }, (_, k) => f.get(k).asName()) : f.isName() ? [f.asName()] : [];
        if (filters.some((x) => ["JBIG2Decode", "CCITTFaxDecode"].includes(x))) return;
        const before = ref.readRawStream().asUint8Array().length;
        let img, pix, small;
        try {
          img = doc.loadImage(ref);
          pix = img.toPixmap();
          const comps = pix.getNumberOfComponents() - pix.getAlpha();
          if (comps === 4) { const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true); pix.destroy(); pix = rgb; }
          const needResize = Math.max(pix.getWidth(), pix.getHeight()) > maxSide * 1.1;
          const wasJpeg = filters.some((x) => ["DCTDecode", "DCT"].includes(x));
          // Un JPEG déjà à la bonne taille n'est réencodé qu'en compression forte (gain faible, perte de qualité).
          if (!needResize && wasJpeg && level !== "strong") return;
          if (pix.getAlpha()) { const flat = pix.convertToColorSpace(pix.getColorSpace(), false); pix.destroy(); pix = flat; }
          small = needResize ? downscale(mupdf, pix, maxSide) : pix;
          if (small === pix) pix = null; // évite une double libération
          const jpg = small.asJPEG(q, false).slice();
          report.images++;
          if (jpg.length >= before * 0.9) return; // pas de gain : on garde l'original
          ref.writeRawStream(jpg);
          ref.put("Filter", doc.newName("DCTDecode"));
          ref.put("ColorSpace", doc.newName(small.getNumberOfComponents() === 1 ? "DeviceGray" : "DeviceRGB"));
          ref.put("BitsPerComponent", 8);
          ref.put("Width", small.getWidth());
          ref.put("Height", small.getHeight());
          for (const k of ["DecodeParms", "Decode", "Intent"]) if (!ref.get(k).isNull()) ref.delete(k);
          if (ref.get("Mask").isArray()) ref.delete("Mask");
          if (needResize) report.resized++;
        } catch { /* image illisible : laissée telle quelle */ } finally { small?.destroy(); pix?.destroy(); img?.destroy(); }
      });
    };
    walk(page.getObject().getInheritable("Resources"));
  }
  try { doc.subsetFonts(); } catch { /* polices non réductibles */ }
  return report;
}

/* ---------- Conversions ---------- */

export function pageToImage(mupdf, doc, i, { dpi = 150, format = "jpg", quality = 85 }) {
  const s = dpi / 72;
  const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
  const bytes = (format === "png" ? pix.asPNG() : pix.asJPEG(quality, false)).slice();
  pix.destroy();
  return bytes;
}

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

// images : [{ bytes }] ; size : fit | a4 | letter ; margin en points.
export function imagesToPdf(mupdf, images, { size = "fit", margin = 0 } = {}) {
  const out = new mupdf.PDFDocument();
  for (const { bytes } of images) {
    const img = new mupdf.Image(bytes);
    let iw = img.getWidth(), ih = img.getHeight();
    const xr = img.getXResolution?.() || 96, yr = img.getYResolution?.() || 96;
    iw = (iw * 72) / (xr || 96); ih = (ih * 72) / (yr || 96);
    let W, H;
    if (size === "fit") { W = iw + 2 * margin; H = ih + 2 * margin; }
    else { [W, H] = PAGE_SIZES[size]; if (iw > ih) [W, H] = [H, W]; } // orientation selon l'image
    const k = Math.min((W - 2 * margin) / iw, (H - 2 * margin) / ih, size === "fit" ? 1 : Infinity);
    const w = iw * k, h = ih * k, x = (W - w) / 2, y = (H - h) / 2;
    const res = out.addObject({ XObject: { Im: out.addImage(img) } });
    out.insertPage(-1, out.addPage([0, 0, W, H], 0, res, `q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(y)} cm /Im Do Q`));
    img.destroy?.();
  }
  return out;
}

/* ---------- ZIP (sans compression : les JPEG le sont déjà) ---------- */

const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const nm = enc.encode(name), crc = crc32(bytes);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, bytes);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, nm.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nm);
    offset += 30 + nm.length + bytes.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const b of all) { out.set(b, o); o += b.length; }
  return out;
}
