// PDF → Word (.docx) sans envoi. MuPDF lit chaque caractère (police, taille, gras, couleur, position) et les images ;
// on recompose des paragraphes modifiables (lignes jointes, retraits, puces, alignement, tabulations) et on écrit
// le .docx nous-mêmes. Une section Word par page PDF (format et marges de la page). Indépendant du DOM : testable sous Node.
import { zip } from "./edit.js";

const TW = 20; // twips par point
const EMU = 12700; // EMU par point
const PUA = { "\uf0b7": "•", "\uf0a7": "▪", "\uf0d8": "➢", "\uf076": "❖", "\uf0fc": "✓", "\uf0a8": "□", "\uf06e": "■", "\uf0e8": "➔", "\uf02d": "–" };
const BULLET = /^[•●▪■◦○◆◇►▸➢➤❖✓✔□➔·*–—-]$/;
const NUMBERED = /^(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])$/;
const tw = (pt) => Math.round(pt * TW);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");

// Nom de police PDF → nom de famille que Word reconnaît (« ABCDEF+TimesNewRomanPS-BoldMT » → « Times New Roman »).
const KNOWN = { timesnewroman: "Times New Roman", couriernew: "Courier New", arialnarrow: "Arial Narrow", segoeui: "Segoe UI",
  bookantiqua: "Book Antiqua", centurygothic: "Century Gothic", trebuchetms: "Trebuchet MS", comicsansms: "Comic Sans MS",
  arialblack: "Arial Black", palatinolinotype: "Palatino Linotype", lucidaconsole: "Lucida Console", franklingothic: "Franklin Gothic",
  gillsans: "Gill Sans", opensans: "Open Sans", sourcesanspro: "Source Sans Pro", timesroman: "Times New Roman", times: "Times New Roman",
  helvetica: "Arial", helveticaneue: "Helvetica Neue", courier: "Courier New", symbol: "Symbol", zapfdingbats: "Wingdings" };
function family(name) {
  if (!name || /^Type3\b/.test(name)) return null;
  let n = (name || "").replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0].replace(/(PSMT|MT|PS)$/, "");
  const key = n.toLowerCase().replace(/[^a-z]/g, "");
  if (KNOWN[key]) return KNOWN[key];
  for (const [k, v] of Object.entries(KNOWN)) if (key.startsWith(k) && k.length > 6) return v;
  return n.replace(/([a-z])([A-Z])/g, "$1 $2").trim() || "Arial";
}

// Une image MuPDF → PNG (avec la transparence de son masque) ou JPEG pour les photos opaques.
function imageBytes(mupdf, image) {
  let pix = image.toPixmap();
  const n = pix.getNumberOfComponents() - pix.getAlpha();
  if (n !== 1 && n !== 3) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
  const mask = image.getMask();
  const w = pix.getWidth(), h = pix.getHeight();
  if (mask) {
    const mp = mask.toPixmap(), mw = mp.getWidth(), mh = mp.getHeight(), ms = mp.getPixels(), mn = mp.getNumberOfComponents();
    const src = pix.getPixels(), sn = pix.getNumberOfComponents();
    const rgb = pix.getNumberOfComponents() - pix.getAlpha() === 3;
    const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true);
    const dst = out.getPixels();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = (y * w + x) * sn, d = (y * w + x) * 4;
      const m = ms[(Math.min(mh - 1, Math.floor(y * mh / h)) * mw + Math.min(mw - 1, Math.floor(x * mw / w))) * mn];
      dst[d] = src[s]; dst[d + 1] = rgb ? src[s + 1] : src[s]; dst[d + 2] = rgb ? src[s + 2] : src[s]; dst[d + 3] = m;
    }
    return { ext: "png", bytes: out.asPNG().slice() };
  }
  if (!pix.getAlpha() && w * h > 160000) return { ext: "jpeg", bytes: pix.asJPEG(88).slice() };
  return { ext: "png", bytes: pix.asPNG().slice() };
}

// Lecture d'une page : blocs de texte (lignes → caractères stylés) et images, dans l'ordre de lecture de MuPDF.
let helv = null;
function readPage(mupdf, page, media, withImages = true) {
  helv ||= new mupdf.Font("Helvetica");
  const links = page.getLinks().filter((l) => l.isExternal()).map((l) => ({ r: l.getBounds(), uri: l.getURI() }));
  const st = page.toStructuredText("preserve-whitespace,preserve-images,vectors");
  const fonts = new Map();
  const blocks = [];
  const fills = []; // rectangles pleins colorés (fonds de cellules, bandeaux)
  let block = null, line = null;
  st.walk({
    onImageBlock(bbox, transform, image) {
      const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
      if (w < 2 || h < 2) return;
      if (!withImages) { blocks.push({ type: "image", bbox, id: 0 }); return; }
      try { const id = media.length + 1; media.push({ id, ...imageBytes(mupdf, image) }); blocks.push({ type: "image", bbox, id }); }
      catch (e) { console.warn("image ignorée", e); }
    },
    onVector(bbox, flags, color) {
      if (flags.isStroked || !flags.isRectangle || bbox[2] - bbox[0] < 3 || bbox[3] - bbox[1] < 3) return;
      const rgb = color.length === 3 ? color : color.length === 1 ? [color[0], color[0], color[0]] : color.length === 4 ? color.slice(0, 3).map((v) => 1 - Math.min(1, v + color[3])) : null;
      if (!rgb || rgb.every((v) => v > 0.94)) return;
      fills.push({ r: bbox, hex: rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase() });
    },
    beginTextBlock(bbox) { block = { type: "text", bbox, lines: [] }; },
    beginLine(bbox) { line = { bbox, chars: [] }; },
    onChar(c, origin, font, size, quad, color) {
      const name = font.getName();
      let f = fonts.get(name);
      if (!f) fonts.set(name, (f = { family: family(name), bold: font.isBold() || /bold|black|heavy|semibold|demi/i.test(name), italic: font.isItalic() || /italic|oblique/i.test(name), w: 0, a: 0, s: 0, n: 0 }));
      // Pour contrôler la taille annoncée : largeur réelle du caractère comparée à sa chasse en Helvetica.
      const g = c.trim() ? helv.encodeCharacter(c.codePointAt(0)) : 0;
      if (g > 0) { const adv = helv.advanceGlyph(g, 0); if (adv > 0.2) { f.w += Math.hypot(quad[2] - quad[0], quad[3] - quad[1]); f.a += adv; f.s += size; f.n++; } }
      if (c === "\ufffd") return; // glyphe sans équivalent Unicode (police symbole) : illisible, on l'omet
      const xs = [quad[0], quad[2], quad[4], quad[6]], cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = origin[1] - size / 3;
      const link = links.findIndex((l) => cx >= l.r[0] && cx <= l.r[2] && cy >= l.r[1] && cy <= l.r[3]);
      const rgb = color.length === 3 ? color : color.length === 1 ? [color[0], color[0], color[0]] : color.length === 4 ? color.slice(0, 3).map((v) => 1 - Math.min(1, v + color[3])) : [0, 0, 0];
      line.chars.push({ c: PUA[c] || c, x0: Math.min(...xs), x1: Math.max(...xs), y: origin[1], size, f,
        color: rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase(),
        link: link >= 0 ? links[link].uri : null });
    },
    endLine() { if (line.chars.some((ch) => ch.c.trim())) block.lines.push(line); },
    endTextBlock() { if (block.lines.length) blocks.push(block); },
  });
  // Certaines polices embarquées ont des métriques trompeuses (texte de 9 pt annoncé à 14 pt) : si la largeur réelle
  // contredit nettement la taille annoncée (écart > 20 %, hors polices étroites ou larges par nature), on retient la taille déduite.
  for (const [name, f] of fonts) {
    f.scale = 1;
    if (f.n >= 8 && !/narrow|condensed|compressed|extended|wide|mono|courier/i.test(name)) {
      const est = f.w / f.a, said = f.s / f.n;
      if (est / said < 0.8 || est / said > 1.25) f.scale = est / said;
    }
  }
  for (const b of blocks) if (b.type === "text") for (const l of b.lines) for (const ch of l.chars) ch.size *= ch.f.scale;
  blocks.fills = fills;
  return blocks;
}

// Ligne de caractères → mesures utiles.
function measure(chars) {
  const vis = chars.filter((c) => c.c.trim());
  const sizes = vis.map((c) => c.size).sort((a, b) => a - b);
  const size = sizes[Math.floor(sizes.length / 2)] || 10;
  const bold = vis.filter((c) => c.f.bold).length > vis.length / 2;
  return { chars, x0: vis[0].x0, x1: vis[vis.length - 1].x1, y: vis.reduce((a, c) => a + c.y, 0) / vis.length, size, maxSize: sizes[sizes.length - 1], bold, first: vis[0] };
}

// Lignes d'un bloc ayant la même ligne de base (colonnes d'un formulaire, « Libellé … Valeur ») → une ligne visuelle à segments.
// MuPDF ne les rend pas toujours de gauche à droite (« : » avant « Catégorie ») : on regroupe par ligne de base, puis on trie.
function visualLines(lines) {
  const out = [];
  for (const l of lines.map((l) => measure(l.chars))) {
    const same = out.find((v) => Math.abs(v.y - l.y) < Math.max(2, l.size * 0.3) && !v.segs.some((sg) => l.x0 < sg.x1 - 1 && l.x1 > sg.x0 + 1));
    if (same) same.segs.push(l);
    else out.push({ y: l.y, size: l.size, segs: [l] });
  }
  for (const v of out) {
    v.segs.sort((a, c) => a.x0 - c.x0);
    v.x0 = v.segs[0].x0; v.x1 = v.segs[v.segs.length - 1].x1; v.bold = v.segs[0].bold; v.maxSize = Math.max(...v.segs.map((s) => s.maxSize));
  }
  return out.sort((a, c) => a.y - c.y);
}

// Découpe des lignes visuelles d'un bloc en paragraphes.
function paragraphs(vlines, blockX1) {
  const paras = [];
  let cur = null;
  const pitch = (() => { const d = []; for (let i = 1; i < vlines.length; i++) d.push(vlines[i].y - vlines[i - 1].y); d.sort((a, b) => a - b); return d[Math.floor(d.length / 2)] || 0; })();
  vlines.forEach((v, i) => {
    const prev = vlines[i - 1];
    const startsItem = startsListItem(v.segs[0]);
    const newPara = !cur || v.segs.length > 1 || cur.lines[0].segs.length > 1 || startsItem
      || Math.abs(v.size - prev.size) > 0.8 || v.bold !== prev.bold
      || (pitch && v.y - prev.y > pitch * 1.45) || v.y - prev.y > v.size * 2.2
      || prev.x1 < blockX1 - Math.max(v.size * 3, (blockX1 - prev.x0) * 0.15)
      || (cur.lines.length > 1 && Math.abs(v.x0 - cur.lines[1].x0) > 3);
    if (newPara) paras.push((cur = { lines: [v] }));
    else cur.lines.push(v);
  });
  return paras;
}

function startsListItem(seg) {
  const vis = seg.chars.filter((c) => c.c.trim());
  if (vis.length < 2) return false;
  let tok = "", k = 0;
  while (k < vis.length && tok.length < 5 && vis[k + 1] && vis[k + 1].x0 - vis[k].x1 < 2) tok += vis[k++].c;
  tok += vis[k]?.c || "";
  const next = vis[k + 1];
  if (!next) return false;
  return (BULLET.test(tok) || NUMBERED.test(tok)) && next.x0 - vis[k].x1 > seg.size * 0.25;
}

// Runs Word à partir d'une suite de caractères ; style = police, gras, italique, taille, couleur, lien.
function runs(chars) {
  const out = [];
  for (const ch of chars) {
    const key = [ch.f.family, ch.f.bold, ch.f.italic, Math.round(ch.size * 2), ch.color, ch.link].join("|");
    const last = out[out.length - 1];
    if (last && last.key === key) last.text += ch.c;
    else out.push({ key, text: ch.c, f: ch.f, size: ch.size, color: ch.color, link: ch.link });
  }
  return out;
}

function runXml(r, rels) {
  if (!r.text) return "";
  const fam = r.f.family ? `<w:rFonts w:ascii="${esc(r.f.family)}" w:hAnsi="${esc(r.f.family)}" w:cs="${esc(r.f.family)}"/>` : "";
  const pr = `<w:rPr>${fam}${r.f.bold ? "<w:b/>" : ""}${r.f.italic ? "<w:i/>" : ""}`
    + `${r.color !== "000000" ? `<w:color w:val="${r.color}"/>` : ""}<w:sz w:val="${Math.max(2, Math.round(r.size * 2))}"/><w:szCs w:val="${Math.max(2, Math.round(r.size * 2))}"/></w:rPr>`;
  const body = r.text.split("\t").map((t) => (t ? `<w:t xml:space="preserve">${esc(t)}</w:t>` : "")).join("<w:tab/>");
  return `<w:r>${pr}${body}</w:r>`;
}

function runsXml(list, rels) {
  let xml = "", i = 0;
  while (i < list.length) {
    const r = list[i];
    if (!r.link) { xml += runXml(r, rels); i++; continue; }
    const id = rels.link(r.link);
    let inner = "";
    while (i < list.length && list[i].link === r.link) inner += runXml(list[i++], rels);
    xml += `<w:hyperlink r:id="${id}">${inner}</w:hyperlink>`;
  }
  return xml;
}

// Texte d'un paragraphe : lignes jointes par une espace (Word refait les retours à la ligne), segments séparés par une tabulation.
function paraChars(para) {
  const out = [];
  para.lines.forEach((v, li) => {
    v.segs.forEach((s, si) => {
      const chars = s.chars.slice();
      while (chars.length && !chars[chars.length - 1].c.trim()) chars.pop();
      while (chars.length && !chars[0].c.trim()) chars.shift();
      if (si > 0) out.push({ ...chars[0], c: "\t" });
      else if (li > 0) {
        const last = out[out.length - 1];
        if (last && last.c === "­") out.pop();
        else if (last && !/[\s-]$/.test(last.c)) out.push({ ...last, c: " ", link: last.link && last.link === chars[0]?.link ? last.link : null });
      }
      out.push(...chars);
    });
  });
  return out;
}

function pPr({ before, line, exact, ind, jc, tabs, sect, shd, frame }) {
  tabs = [...new Set((tabs || []).map((t) => tw(t)))].sort((a, b) => a - b).map((t) => t / TW); // Word exige des taquets croissants
  return `<w:pPr>${frame ? "@@PPR@@" : ""}${shd ? `<w:shd w:val="clear" w:color="auto" w:fill="${shd}"/>` : ""}${tabs.length ? `<w:tabs>${tabs.map((t) => `<w:tab w:val="left" w:pos="${tw(t)}"/>`).join("")}</w:tabs>` : ""}`
    + `<w:spacing w:before="${frame ? "@@BEFORE@@" : Math.max(0, tw(before))}" w:after="0" ${line ? `w:line="${tw(line)}" w:lineRule="${exact ? "exact" : "atLeast"}"` : 'w:line="240" w:lineRule="auto"'}/>`
    + (ind ? `<w:ind w:left="${tw(ind.left)}"${ind.right ? ` w:right="${tw(ind.right)}"` : ""}${ind.first > 0 ? ` w:firstLine="${tw(ind.first)}"` : ind.first < 0 ? ` w:hanging="${tw(-ind.first)}"` : ""}/>` : "")
    + (jc ? `<w:jc w:val="${jc}"/>` : "") + (sect || "") + `</w:pPr>`;
}

function imageRun(img, id, w, h) {
  const cx = Math.round(w * EMU), cy = Math.round(h * EMU);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Image ${id}"/>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.${img.ext}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rIdImg${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

// Grande image derrière le texte (fond de page, page scannée annotée) : ancrée à sa place exacte sur la page.
function anchoredImage(img, id, b) {
  const cx = Math.round((b[2] - b[0]) * EMU), cy = Math.round((b[3] - b[1]) * EMU);
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">`
    + `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(b[0] * EMU)}</wp:posOffset></wp:positionH>`
    + `<wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(b[1] * EMU)}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`
    + `<wp:docPr id="${id}" name="Image ${id}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.${img.ext}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rIdImg${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
}

// Une page PDF → paragraphes Word, la section (format + marges) étant portée par le dernier paragraphe.
// Les blocs qui se suivent de haut en bas forment le flux normal du texte ; un bloc placé À CÔTÉ de ce qui est déjà posé
// (valeur à droite d'un libellé, titre à côté d'un logo, colonne d'adresse) va dans un cadre positionné à sa place exacte.
function pageXml(blocks, W, H, media, rels, last) {
  const items = [];
  for (const b of blocks) items.push(b.type === "image" ? { kind: "image", b } : { kind: "text", b, v: visualLines(b.lines) });
  // Ordre haut → bas : MuPDF rend parfois le pied de page avant le corps, ce qui pousserait tout à la page suivante.
  const topOf = (it) => (it.kind === "text" ? it.v[0].y - it.v[0].maxSize * 0.95 : it.b.bbox[1]);
  items.sort((a, c) => (Math.abs(topOf(a) - topOf(c)) < 2 ? a.b.bbox[0] - c.b.bbox[0] : topOf(a) - topOf(c)));
  const fills = blocks.fills || [];
  const images = blocks.filter((b) => b.type === "image").map((b) => b.bbox);
  const inside = (r, x, y) => x >= r[0] - 1 && x <= r[2] + 1 && y >= r[1] - 1 && y <= r[3] + 1;
  const xs0 = [], xs1 = [], ys0 = [];
  for (const it of items) { xs0.push(it.b.bbox[0]); xs1.push(it.b.bbox[2]); ys0.push(it.b.bbox[1]); }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mL = clamp(Math.min(...xs0, W) - 1, 14, W * 0.3), mR = clamp(W - Math.max(...xs1, 0) - 1, 14, W * 0.3);
  const mT = clamp(Math.min(...ys0, H) - 2, 14, H * 0.3), mB = 14;
  const textW = W - mL - mR;
  const scan = blocks.length > 0 && blocks.every((b) => b.type === "image");
  const used = new Set();
  const body = [];
  let cursor = mT; // bas du flux déjà posé (points depuis le haut de la page)

  // Zone d'écriture : le flux (marges de la page) ou un cadre (position et largeur du bloc).
  const flow = () => ({ x: mL, w: textW, frame: "", local: null });
  const frameFor = (x0, y0, x1) => {
    const x = Math.max(0, x0 - 2), w = Math.min(W - x - 2, x1 - x0 + 10);
    return { x, w, local: y0, frame: `<w:framePr w:w="${tw(w)}" w:hRule="auto" w:wrap="around" w:vAnchor="page" w:hAnchor="page" w:x="${tw(x)}" w:y="${tw(y0)}"/>` };
  };
  const emit = (zone, inner, top, height) => {
    const ref = zone.frame ? zone.local : cursor;
    body.push(inner.replace("@@PPR@@", zone.frame).replace("@@BEFORE@@", String(Math.max(0, tw(top - ref)))));
    if (zone.frame) zone.local = Math.max(zone.local, top + height); else cursor = Math.max(cursor, top + height);
  };

  items.forEach((it, idx) => {
    if (used.has(idx)) return;
    if (it.kind === "image") {
      const b = it.b.bbox, img = media.find((m) => m.id === it.b.id);
      const w = b[2] - b[0], h = b[3] - b[1];
      if (!scan && w * h > W * H * 0.4) { body.push(`<w:p>${pPr({ before: 0, line: 1, exact: true })}${anchoredImage(img, img.id, b)}</w:p>`); return; }
      // Images côte à côte (logos d'en-tête…) : un seul paragraphe, chacune à sa position horizontale.
      const row = [it];
      items.forEach((o, j) => { if (j > idx && !used.has(j) && o.kind === "image" && o.b.bbox[1] < b[3] - h * 0.3 && o.b.bbox[3] > b[1] + h * 0.3) { row.push(o); used.add(j); } });
      row.sort((a, c) => a.b.bbox[0] - c.b.bbox[0]);
      const top = Math.min(...row.map((r) => r.b.bbox[1]));
      const zone = top < cursor - 2 ? frameFor(row[0].b.bbox[0], top, Math.max(...row.map((r) => r.b.bbox[2]))) : flow();
      const maxH = H - mT - mB - 4;
      let xml = "", height = 0;
      const tabs = [];
      row.forEach((r, k) => {
        const bb = r.b.bbox, m = media.find((mm) => mm.id === r.b.id);
        let iw = bb[2] - bb[0], ih = bb[3] - bb[1];
        const sc = Math.min(1, zone.w / iw, maxH / ih); iw *= sc; ih *= sc;
        if (k > 0) { tabs.push(Math.max(0, bb[0] - zone.x)); xml += "<w:r><w:tab/></w:r>"; }
        xml += imageRun(m, m.id, iw, ih);
        height = Math.max(height, ih);
      });
      const left = zone.frame ? 0 : row.length === 1 ? clamp(row[0].b.bbox[0] - mL, 0, Math.max(0, textW - w)) : clamp(row[0].b.bbox[0] - mL, 0, textW);
      emit(zone, `<w:p>${pPr({ before: 0, ind: { left }, tabs, frame: true })}${xml}</w:p>`, top, height);
      return;
    }
    const vlines = it.v;
    // Lignes isolées (blocs d'une ligne) sur la même ligne de base : réunies en une ligne à tabulations.
    if (vlines.length === 1) {
      const v0 = vlines[0];
      items.forEach((o, j) => {
        if (j <= idx || used.has(j) || o.kind !== "text" || o.v.length !== 1) return;
        const v = o.v[0];
        if (Math.abs(v.y - v0.y) < Math.max(2, v0.size * 0.3) && !v0.segs.some((sg) => v.x0 < sg.x1 && v.x1 > sg.x0)) { v0.segs.push(...v.segs); used.add(j); }
      });
      v0.segs.sort((a, c) => a.x0 - c.x0);
      v0.x0 = v0.segs[0].x0; v0.x1 = v0.segs[v0.segs.length - 1].x1;
      v0.maxSize = Math.max(...v0.segs.map((sg) => sg.maxSize));
    }
    const bx0 = Math.min(...vlines.map((v) => v.x0)), bx1 = Math.max(...vlines.map((v) => v.x1));
    const zone = topOf(it) < cursor - 2 ? frameFor(bx0, topOf(it), bx1) : flow();
    for (const para of paragraphs(vlines, it.b.bbox[2])) {
      const L = para.lines, v1 = L[0];
      const top = v1.y - v1.maxSize * 0.95;
      const pitchs = []; for (let i = 1; i < L.length; i++) pitchs.push(L[i].y - L[i - 1].y);
      const pitch = pitchs.length ? pitchs.sort((a, c) => a - c)[Math.floor(pitchs.length / 2)] : 0;
      const lineH = Math.max(L.length > 1 ? pitch : 0, v1.maxSize * 1.15);
      const height = lineH * L.length;
      const tabs = v1.segs.slice(1).map((sg) => Math.max(0, sg.x0 - zone.x));
      const chars = paraChars(para);
      let ind = { left: Math.max(0, (L[1] || v1).x0 - zone.x), first: 0, right: 0 };
      if (L.length > 1) ind.first = v1.x0 - L[1].x0;
      let jc = null;
      // Puce ou numéro : « •<tab>texte » avec retrait suspendu.
      if (startsListItem(v1.segs[0])) {
        const k = chars.findIndex((c, i) => i > 0 && c.c.trim() && c.x0 - chars[i - 1].x1 > c.size * 0.25 && !(chars[i - 1].c === " " && chars[i - 2] && c.x0 - chars[i - 2].x1 < c.size * 0.4));
        if (k > 0) {
          let st = k; while (st > 0 && !chars[st - 1].c.trim()) st--;
          const textX = chars[k].x0;
          chars.splice(st, k - st, { ...chars[st], c: "\t" });
          ind = { left: Math.max(0, textX - zone.x), first: -(textX - v1.x0), right: 0 };
          tabs.unshift(Math.max(0, textX - zone.x));
        }
      } else if (v1.segs.length === 1 && !zone.frame) {
        const mid = (v1.x0 + v1.x1) / 2;
        const lefts = L.map((l) => l.x0), rights = L.map((l) => l.x1);
        const centered = Math.abs(mid - (mL + textW / 2)) < 8 && v1.x0 - mL > 20 && L.every((l) => Math.abs((l.x0 + l.x1) / 2 - mid) < 8);
        const right = !centered && L.every((l) => Math.abs(l.x1 - (W - mR)) < 6) && v1.x0 - mL > textW * 0.35;
        const justified = L.length > 2 && rights.slice(0, -1).every((r) => Math.abs(r - rights[0]) < 2) && lefts.slice(1).every((x) => Math.abs(x - lefts[1]) < 2);
        if (centered) { jc = "center"; ind = { left: 0, first: 0, right: 0 }; }
        else if (right) { jc = "right"; ind = { left: 0, first: 0, right: Math.max(0, W - mR - Math.max(...rights)) }; }
        else if (justified) jc = "both";
        if (!centered && !right && L.length > 1) {
          const r = W - mR - Math.max(...rights) - 2;
          if (r > 18) ind.right = r; // paragraphe étroit (colonne, encadré) : même largeur que dans le PDF
        }
      }
      // Fond coloré sous la 1re ligne (en-tête de tableau, bandeau) → trame du paragraphe.
      const cy = v1.y - v1.size * 0.3;
      const fill = fills.filter((f) => inside(f.r, (v1.x0 + v1.x1) / 2, cy) || inside(f.r, v1.x0 + 1, cy)).sort((a, c) => (a.r[2] - a.r[0]) * (a.r[3] - a.r[1]) - (c.r[2] - c.r[0]) * (c.r[3] - c.r[1]))[0];
      const overImage = images.some((r) => inside(r, v1.x0 + 1, cy));
      if (!fill && !overImage) for (const c of chars) if (/^[EF][0-9A-F]([EF][0-9A-F]){2}$/.test(c.color)) c.color = "000000"; // blanc sans fond : illisible
      emit(zone, `<w:p>${pPr({ before: 0, line: lineH, exact: true, ind, jc, tabs, shd: fill?.hex, frame: true })}${runsXml(runs(chars), rels)}</w:p>`, top, height);
    }
  });

  const sect = `<w:sectPr><w:pgSz w:w="${tw(W)}" w:h="${tw(H)}"${W > H ? ' w:orient="landscape"' : ""}/>`
    + `<w:pgMar w:top="${tw(mT)}" w:right="${tw(mR)}" w:bottom="${tw(mB)}" w:left="${tw(mL)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
  if (last) return body.join("") + sect;
  // Saut de section (page suivante) porté par un paragraphe vide minuscule en fin de page.
  return body.join("") + `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${sect}</w:pPr></w:p>`;
}

// ---- Mode « mise en page fidèle » ----
// Fond de page = la page elle-même dont on a retiré le texte (même fonction que le caviardage : texte supprimé, images et
// tracés conservés), rendue en image et posée derrière. Par-dessus, une zone de texte Word par bloc, au point près,
// avec les retours à la ligne du PDF : bordures, cadres, logos et positions sont ceux de l'original, et le texte reste modifiable.
const BG_SCALE = 2; // 144 dpi
function backgroundOf(mupdf, copy, i, photoHeavy) {
  const page = copy.loadPage(i);
  const annot = page.createAnnotation("Redact");
  annot.setRect(page.getBounds());
  page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
  const pix = page.toPixmap(mupdf.Matrix.scale(BG_SCALE, BG_SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
  const px = pix.getPixels();
  let ink = false;
  for (let k = 0; k < px.length; k += 97) if (px[k] < 248) { ink = true; break; }
  if (!ink) return null; // page blanche une fois le texte retiré : pas de fond
  return photoHeavy ? { ext: "jpeg", bytes: pix.asJPEG(85).slice() } : { ext: "png", bytes: pix.asPNG().slice() };
}

// Texte invisible (couche OCR d'un scan) : la page rendue avec et sans texte est identique. On ne l'affiche pas par-dessus.
function textIsInvisible(mupdf, page, copyPage) {
  const m = mupdf.Matrix.scale(0.3, 0.3);
  const a = page.toPixmap(m, mupdf.ColorSpace.DeviceGray, false, true).getPixels();
  const b = copyPage.toPixmap(m, mupdf.ColorSpace.DeviceGray, false, true).getPixels();
  let diff = 0;
  for (let k = 0; k < Math.min(a.length, b.length); k++) diff += Math.abs(a[k] - b[k]);
  return diff / a.length < 0.15;
}

let shapeId = 5000;
function anchor({ x, y, w, h, behind, inner }) {
  const id = ++shapeId;
  return `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">`
    + `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(x * EMU)}</wp:posOffset></wp:positionH>`
    + `<wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(y * EMU)}</wp:posOffset></wp:positionV>`
    + `<wp:extent cx="${Math.round(w * EMU)}" cy="${Math.round(h * EMU)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`
    + `<wp:docPr id="${id}" name="${behind ? "Fond" : "Texte"} ${id}"/><wp:cNvGraphicFramePr/>${inner(id)}</wp:anchor>`;
}

function textBox(x, y, w, h, paras) {
  const cx = Math.round(w * EMU), cy = Math.round(h * EMU);
  return `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>` + anchor({ x, y, w, h, behind: false, inner: () =>
    `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/>`
    + `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>`
    + `<wps:txbx><w:txbxContent>${paras}</w:txbxContent></wps:txbx>`
    + `<wps:bodyPr rot="0" vert="horz" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic>` })
    + `</w:drawing></mc:Choice></mc:AlternateContent></w:r>`;
}

function backgroundPicture(img, W, H) {
  return `<w:r><w:drawing>` + anchor({ x: 0, y: 0, w: W, h: H, behind: true, inner: (id) =>
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="fond${img.id}.${img.ext}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rIdImg${img.id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(W * EMU)}" cy="${Math.round(H * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>` })
    + `</w:drawing></w:r>`;
}

function pageXmlExact(blocks, W, H, bg, showText, rels, last) {
  let runsXmlAll = bg ? backgroundPicture(bg, W, H) : "";
  if (showText) for (const b of blocks) {
    if (b.type !== "text") continue;
    const vlines = visualLines(b.lines);
    const bx = Math.min(...vlines.map((v) => v.x0)) - 0.5;
    const bw = Math.max(...vlines.map((v) => v.x1)) - bx;
    let paras = "", top0 = null, cursor = 0;
    const flush = () => { if (paras) runsXmlAll += textBox(bx, top0, bw * 1.15 + 6, cursor - top0 + 2, paras); paras = ""; top0 = null; };
    for (const v of vlines) {
      const lineH = v.maxSize * 1.2;
      const top = v.y - lineH * 0.8; // ligne de base à ~80 % de la hauteur de ligne, comme Word et LibreOffice
      if (top0 !== null && top < cursor - 1) flush(); // lignes qui se chevauchent : nouvelle zone, sinon elles seraient décalées
      if (top0 === null) { top0 = top; cursor = top; }
      const chars = paraChars({ lines: [v] });
      const tabs = v.segs.slice(1).map((sg) => Math.max(0, sg.x0 - bx));
      const ind = { left: Math.max(0, v.x0 - bx), first: 0, right: 0 };
      paras += `<w:p>${pPr({ before: Math.max(0, top - cursor), line: lineH, exact: true, ind, tabs })}${runsXml(runs(chars), rels)}</w:p>`;
      cursor = Math.max(cursor, top + lineH);
    }
    // Largeur avec marge : une police de remplacement un peu plus large ne doit pas couper la ligne.
    flush();
  }
  const sect = `<w:sectPr><w:pgSz w:w="${tw(W)}" w:h="${tw(H)}"${W > H ? ' w:orient="landscape"' : ""}/>`
    + `<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
  // Tout est ancré à la page : un seul paragraphe minuscule par page, qui porte le saut de section.
  const p = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${last ? "" : sect}</w:pPr>${runsXmlAll}</w:p>`;
  return last ? p + sect : p;
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
  + 'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';

// doc : Document MuPDF (PDF ouvert). Retourne les octets du .docx et quelques chiffres pour l'interface.
// mode : "exact" (mise en page fidèle, par défaut) ou "flow" (texte fluide, plus facile à réécrire).
export async function pdfToDocx(mupdf, doc, { onPage, mode = "exact" } = {}) {
  const exact = mode === "exact";
  // Copie de travail pour les fonds de page (le texte y est retiré), sans toucher au document ouvert.
  const copy = exact ? mupdf.Document.openDocument(doc.saveToBuffer("encrypt=none").asUint8Array().slice(), "application/pdf").asPDF() : null;
  let invisiblePages = 0;
  const media = [];
  const linkRels = new Map();
  const rels = { link: (uri) => { if (!linkRels.has(uri)) linkRels.set(uri, `rIdLink${linkRels.size + 1}`); return linkRels.get(uri); } };
  const n = doc.countPages();
  let xml = "", textChars = 0;
  const fontCount = new Map(), sizeCount = new Map();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    const blocks = readPage(mupdf, page, media, !exact);
    for (const b of blocks) if (b.type === "text") for (const l of b.lines) for (const c of l.chars) {
      if (!c.c.trim()) continue;
      textChars++;
      if (c.f.family) fontCount.set(c.f.family, (fontCount.get(c.f.family) || 0) + 1);
      const s = Math.round(c.size * 2); sizeCount.set(s, (sizeCount.get(s) || 0) + 1);
    }
    if (exact) {
      const W = x1 - x0, H = y1 - y0;
      const photo = blocks.filter((b) => b.type === "image").reduce((a, b) => a + (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]), 0) > W * H * 0.2;
      const bgImg = backgroundOf(mupdf, copy, i, photo);
      let bg = null;
      if (bgImg) { bg = { id: media.length + 1, ...bgImg }; media.push(bg); }
      const hasText = blocks.some((b) => b.type === "text");
      const invisible = hasText && textIsInvisible(mupdf, page, copy.loadPage(i));
      if (invisible) invisiblePages++;
      xml += pageXmlExact(blocks, W, H, bg, hasText && !invisible, rels, i === n - 1);
    } else xml += pageXml(blocks, x1 - x0, y1 - y0, media, rels, i === n - 1);
    await onPage?.(i + 1, n); // l'interface en profite pour afficher l'avancement et laisser respirer la page
  }
  // Table des polices : la famille générique guide Word / LibreOffice quand la police n'est pas installée.
  const SERIF = /times|georgia|garamond|cambria|antiqua|palatino|century schoolbook|baskerville|bodoni|didot|constantia|lora|merriweather|playfair|minion|caslon|serif/i;
  const fontTable = [...fontCount.keys()].map((f) => {
    const fam = /courier|consolas|mono|menlo|lucida console/i.test(f) ? "modern" : SERIF.test(f) && !/sans/i.test(f) ? "roman" : /symbol|wingdings|dingbat/i.test(f) ? "decorative" : "swiss";
    return `<w:font w:name="${esc(f)}"><w:family w:val="${fam}"/><w:pitch w:val="${fam === "modern" ? "fixed" : "variable"}"/></w:font>`;
  }).join("");
  const top = (m, d) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? d;
  const font = top(fontCount, "Arial"), sz = top(sizeCount, 22);
  const enc = new TextEncoder();
  const files = [
    { name: "[Content_Types].xml", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>`
      + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
      + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
      + `<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>`) },
    { name: "_rels/.rels", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: "word/document.xml", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${xml}</w:body></w:document>`) },
    { name: "word/styles.xml", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
      + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${esc(font)}" w:hAnsi="${esc(font)}" w:eastAsia="${esc(font)}" w:cs="${esc(font)}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault>`
      + `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
      + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`) },
    { name: "word/_rels/document.xml.rels", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + `<Relationship Id="rIdFonts" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>`
      + media.map((m) => `<Relationship Id="rIdImg${m.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${m.id}.${m.ext}"/>`).join("")
      + [...linkRels].map(([uri, id]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(uri)}" TargetMode="External"/>`).join("")
      + `</Relationships>`) },
    { name: "word/fontTable.xml", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${fontTable}</w:fonts>`) },
    ...media.map((m) => ({ name: `word/media/image${m.id}.${m.ext}`, bytes: m.bytes })),
  ];
  return { bytes: zip(files), pages: n, images: exact ? 0 : media.length, textChars: invisiblePages === n ? 0 : textChars };
}
