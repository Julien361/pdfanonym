// Word (.docx) → PDF sans envoi : docx-preview traduit le document en HTML/CSS (styles, tableaux, images, listes),
// MuPDF le met en page et l'écrit en PDF (texte vectoriel, sélectionnable). En-têtes et pieds de page sont
// mis en page à part puis reposés sur chaque page, avec les numéros de page recalculés.
import { parseAsync, renderDocument } from "./docx-preview.esm.js";
import JSZip from "./jszip.esm.js";

const PT = { pt: 1, px: 0.75, in: 72, cm: 72 / 2.54, mm: 72 / 25.4 };
const toPt = (s, d = 0) => { const m = /(-?[\d.]+)\s*(pt|px|in|cm|mm)?/.exec(s || ""); return m ? +m[1] * PT[m[2] || "pt"] : d; };
const FIELD = { PAGE: "@@PAGE@@", NUMPAGES: "@@NUMPAGES@@", SECTIONPAGES: "@@NUMPAGES@@" };

// Remplace le résultat mis en cache des champs PAGE / NUMPAGES (Word y garde « 1 » partout) par un repère.
function markFields(node, st = { instr: "", field: null, done: false }) {
  for (const c of node.children || []) {
    if (c.type === "simpleField") {
      const m = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/.exec(c.instruction || "");
      if (m) Object.assign(c, { type: "text", text: FIELD[m[1]] });
    } else if (c.type === "complexField") {
      if (c.charType === "begin") Object.assign(st, { instr: "", field: null, done: false });
      else if (c.charType === "separate") st.field = FIELD[(/^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/.exec(st.instr) || [])[1]] || null;
      else if (c.charType === "end") {
        // Champ sans résultat enregistré (fréquent dans les pieds de page) : on ajoute le repère après la fin du champ.
        // docx-preview masque les runs d'un champ : le repère prend la place du fldChar de fin et son run redevient visible.
        if (st.field && !st.done) { Object.assign(c, { type: "text", text: st.field }); node.fieldRun = false; }
        Object.assign(st, { instr: "", field: null });
      }
    } else if (c.type === "instruction") st.instr += c.text;
    else if (c.type === "text" && st.field) { c.text = st.done ? "" : st.field; st.done = true; }
    markFields(c, st);
  }
}

const SERIF = /times|georgia|garamond|cambria|book antiqua|palatino|century|baskerville|bodoni|didot|constantia|serif/i;
const MONO = /courier|consolas|mono|menlo|lucida console/i;
// MuPDF ne connaît que ses polices intégrées : on ajoute à chaque liste la famille générique la plus proche.
function fixFonts(css) {
  return css.replace(/font-family:\s*([^;}<>]+)/gi, (all, list) => {
    if (/\b(serif|sans-serif|monospace)\s*$/i.test(list.replace(/["']|&quot;/g, "").trim())) return all;
    const generic = /serif/i.test(list) && !/sans/i.test(list) || SERIF.test(list) && !/sans/i.test(list) ? "serif" : MONO.test(list) ? "monospace" : "sans-serif";
    return `font-family: ${list.trim()}, ${generic}`;
  });
}

// MuPDF ne lit pas les variables CSS : on les remplace par leur valeur.
function resolveVars(css) {
  const vars = {};
  css.replace(/(--[\w-]+)\s*:\s*([^;}]+)/g, (_, k, v) => (vars[k] = v.trim()));
  for (let i = 0; i < 3; i++) css = css.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, k, d) => vars[k] ?? d ?? "");
  return css;
}

// MuPDF ignore les propriétés logiques (margin-inline-start…) : on les écrit en gauche/droite.
const physical = (css) => css.replace(/\b(margin|padding)-inline-start\b/g, "$1-left").replace(/\b(margin|padding)-inline-end\b/g, "$1-right");
// MuPDF ne sait pas lire calc() et rejette alors tout l'attribut style : on retire ces seules déclarations
// (surtout line-height: calc(100% + …), un interligne Word « au moins » qu'on laisse à sa valeur normale).
const dropCalc = (css) => css.replace(/[\w-]+\s*:\s*calc\((?:[^()]|\([^()]*\))*\)\s*(?:;|(?=["'}]|&quot;))/g, "");
// Fonds d'image en data: non entre guillemets (docx-preview) : le « ; » du data: casse la règle CSS entière.
const dropDataBg = (css) => css.replace(/background(?:-image)?\s*:\s*url\(\s*data:[^)"']*\)\s*;?/g, "");
const fixCss = (css) => physical(fixFonts(dropCalc(dropDataBg(resolveVars(css)))));

// Puces Word en police Symbol / Wingdings (zone privée Unicode) → caractères ordinaires.
const BULLETS = { "\uf0b7": "•", "\uf0a7": "▪", "\uf0d8": "➢", "\uf076": "❖", "\uf0fc": "✓", "\uf0a8": "□", "\uf06e": "■", "\uf0e8": "➔", "\uf02d": "–", "\uf0be": "—" };
const ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
function fmt(n, style) {
  switch (style) {
    case "lower-alpha": case "lower-latin": return n > 0 ? String.fromCharCode(96 + ((n - 1) % 26) + 1).repeat(Math.ceil(n / 26)) : "";
    case "upper-alpha": case "upper-latin": return fmt(n, "lower-alpha").toUpperCase();
    case "lower-roman": { let r = "", k = n; for (const [v, s] of ROMAN) while (k >= v) { r += s; k -= v; } return r; }
    case "upper-roman": return fmt(n, "lower-roman").toUpperCase();
    case "decimal-leading-zero": return String(n).padStart(2, "0");
    case "none": return "";
    default: return String(n);
  }
}
const unescapeCss = (s) => s.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1");

// MuPDF n'affiche pas les ::before à compteurs de docx-preview : on calcule chaque puce / numéro et on l'écrit dans le texte.
function materializeLists(root, css) {
  const rules = {};
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    for (const sel of m[1].split(",").map((x) => x.trim())) {
      const k = /^(?:p)?\.(docx-num-[\w-]+?)(:before)?$/.exec(sel) || (sel === ".docx" ? [0, "@root"] : null);
      if (!k) continue;
      const r = (rules[k[1]] ||= {});
      const decl = m[2];
      const get = (name) => (new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(decl) || [])[1]?.trim();
      if (k[2]) { r.content = get("content") ?? r.content; r.inc = get("counter-increment") ?? r.inc; r.font = get("font-family") ?? r.font; }
      else if (get("counter-reset")) r.reset = get("counter-reset");
    }
  }
  const counters = {};
  const reset = (spec) => {
    const t = (spec || "").split(/\s+/).filter(Boolean);
    for (let i = 0; i < t.length; i++) { const name = t[i]; counters[name] = /^-?\d+$/.test(t[i + 1]) ? +t[++i] : 0; }
  };
  reset(rules["@root"]?.reset);
  for (const p of root.querySelectorAll("p")) {
    const cls = [...p.classList].find((c) => rules[c]?.content);
    if (!cls) continue;
    const r = rules[cls];
    reset(r.reset);
    if (r.inc) { const [name, by] = r.inc.split(/\s+/); counters[name] = (counters[name] || 0) + (by ? +by : 1); }
    let text = "";
    const tok = /"((?:[^"\\]|\\.)*)"|counter\(\s*([\w-]+)\s*(?:,\s*([\w-]+))?\s*\)/g;
    let t;
    while ((t = tok.exec(r.content))) text += t[1] !== undefined ? unescapeCss(t[1]) : fmt(counters[t[2]] || 0, t[3] || "decimal");
    text = [...text].map((c) => BULLETS[c] || (c >= "\uf000" && c <= "\uf0ff" ? "•" : c)).join("");
    const marker = text.replace(/\t+$/, "");
    if (!marker.trim()) continue;
    const span = root.ownerDocument.createElement("span");
    span.textContent = marker + "\u00a0\u00a0";
    if (r.font && !/symbol|wingdings/i.test(r.font)) span.style.fontFamily = r.font;
    p.prepend(span);
  }
}

// Marges Word de l'en-tête et du pied de page : docx-preview les écrit en calc(distance - marge).
const calcFirst = (s) => { const m = /calc\(\s*([\d.]+\w*)/.exec(s || ""); return m ? toPt(m[1]) : null; };

// docx-preview ignore les champs simples placés directement dans un paragraphe (<w:fldSimple w:instr="PAGE"/>) :
// on les réécrit en champs complets, qu'il sait lire.
async function prepare(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  let changed = false;
  for (const path of Object.keys(zip.files).filter((p) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(p))) {
    const xml = await zip.file(path).async("string");
    if (!xml.includes("fldSimple")) continue;
    const run = (inner) => `<w:r>${inner}</w:r>`;
    const out = xml.replace(/<w:fldSimple\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:fldSimple>)/g, (_, attrs, inner = "") => {
      const instr = (/w:instr="([^"]*)"/.exec(attrs) || [])[1] || "";
      return run('<w:fldChar w:fldCharType="begin"/>') + run(`<w:instrText xml:space="preserve">${instr}</w:instrText>`)
        + run('<w:fldChar w:fldCharType="separate"/>') + inner + run('<w:fldChar w:fldCharType="end"/>');
    });
    zip.file(path, out);
    changed = true;
  }
  return changed ? zip.generateAsync({ type: "uint8array" }) : bytes;
}

// Formes Word (VML / DrawingML) rendues en <svg> : MuPDF ne les dessine pas dans du HTML. Les petites (cases à cocher,
// pictogrammes) deviennent des images SVG à leur place dans la ligne ; les grandes, positionnées en absolu, sont retirées.
function shapesToImages(root) {
  for (const svg of [...root.querySelectorAll("svg")]) {
    if (svg.parentElement?.closest("svg")) continue;
    const w = toPt(svg.style.width || svg.getAttribute("width")), h = toPt(svg.style.height || svg.getAttribute("height"));
    const img = root.ownerDocument.createElement("img");
    const shapes = svg.querySelectorAll("rect,path,line,ellipse,circle,polygon,polyline,text");
    const pics = svg.querySelectorAll("image");
    if (pics.length === 1 && !shapes.length && w > 0 && h > 0) {
      // Image Word ancienne (VML) : on reprend directement l'image bitmap, quelle que soit sa taille (logos…).
      const href = pics[0].getAttribute("href") || pics[0].getAttribute("xlink:href") || "";
      if (!/^data:image\/(png|jpe?g|gif|bmp)/i.test(href)) { svg.remove(); continue; }
      img.src = href;
    } else if (shapes.length && w > 0 && h > 0 && w <= 40 && h <= 40) {
      const clone = svg.cloneNode(true);
      clone.removeAttribute("style");
      clone.setAttribute("width", `${w}pt`);
      clone.setAttribute("height", `${h}pt`);
      if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${w / 0.75} ${h / 0.75}`);
      if (!clone.getAttribute("fill")) clone.setAttribute("fill", "none");
      let xml = new XMLSerializer().serializeToString(clone);
      if (!/^<svg[^>]*\sxmlns=/.test(xml)) xml = xml.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
      img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
    } else { svg.remove(); continue; }
    img.style.width = `${w}pt`;
    img.style.height = `${h}pt`;
    img.style.verticalAlign = "middle";
    svg.replaceWith(img);
  }
}

// Étape navigateur (DOM requis) : .docx → morceaux HTML + géométrie de page.
export async function docxToParts(bytes, doc = globalThis.document) {
  const opts = { className: "docx", inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: true, ignoreFonts: true,
    useBase64URL: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderComments: false, experimental: true };
  const word = await parseAsync(await prepare(bytes), opts);
  markFields(word.documentPart.body);
  for (const part of word.parts || []) if (part.rootElement && /header|footer/.test(part.path || "")) markFields(part.rootElement);

  const render = async () => {
    const body = doc.createElement("div"), style = doc.createElement("div");
    for (const n of await renderDocument(word, opts)) (n.nodeName === "STYLE" ? style : body).appendChild(n);
    return { body, style };
  };
  const { body, style } = await render();
  materializeLists(body, style.textContent);
  shapesToImages(body);
  const sections = [...body.querySelectorAll("section.docx")];
  if (!sections.length) throw new Error("empty");
  const s0 = sections[0].style;
  const page = {
    w: toPt(s0.width, 595.3), h: toPt(s0.minHeight, 841.9),
    mt: toPt(s0.paddingTop, 72), mr: toPt(s0.paddingRight, 72), mb: toPt(s0.paddingBottom, 72), ml: toPt(s0.paddingLeft, 72),
  };
  const take = (sec, tag) => {
    const el = sec?.querySelector(`:scope > ${tag}`);
    if (!el) return null;
    const dist = calcFirst(tag === "header" ? el.style.marginTop : el.style.marginBottom);
    el.remove();
    return { html: el.innerHTML, dist };
  };
  const firstHeader = take(sections[0], "header"), firstFooter = take(sections[0], "footer");
  let header = firstHeader, footer = firstFooter;
  // Première page différente : on refait un rendu sans cette option pour obtenir l'en-tête courant.
  const props = word.documentPart.body.props;
  if (props?.titlePage) {
    props.titlePage = false;
    const again = await render();
    const a0 = again.body.querySelector("section.docx");
    materializeLists(again.body, again.style.textContent);
    shapesToImages(again.body);
    header = take(a0, "header");
    footer = take(a0, "footer");
  }
  for (const s of sections.slice(1)) { take(s, "header"); take(s, "footer"); }
  const html = sections.map((s, i) => `<div class="docx"${i ? ' style="page-break-before:always"' : ""}>${s.innerHTML}</div>`).join("\n");
  return { css: style.innerHTML.replace(/<\/?style[^>]*>/g, "\n"), html, page, header, footer, firstHeader, firstFooter };
}

function docHtml(css, inner, size, margin) {
  const base = `@page{size:${size};margin:${margin}} body{margin:0} .docx{color:black} .docx p{margin:0} table{border-collapse:collapse} img{max-width:100%}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${base}\n${css}\n.docx{hyphens:manual}</style></head><body>${inner}</body></html>`;
}

// Étape moteur (sans DOM) : morceaux HTML → PDF. Testable sous Node.
export function partsToPdf(mupdf, parts) {
  const { page: P } = parts;
  const css = fixCss(parts.css);
  const fix = fixCss;
  const bodyDoc = mupdf.Document.openDocument(new TextEncoder().encode(docHtml(css, fix(parts.html), `${P.w}pt ${P.h}pt`, `${P.mt}pt ${P.mr}pt ${P.mb}pt ${P.ml}pt`)), "text/html");
  bodyDoc.layout(P.w, P.h, 11);
  const n = bodyDoc.countPages();
  const innerW = P.w - P.ml - P.mr;

  // Un en-tête / pied de page est mis en page seul, sur la largeur utile ; on garde la hauteur de son contenu.
  const cache = new Map();
  const band = (part, i) => {
    if (!part || !part.html.replace(/<[^>]+>|\s|&nbsp;/g, "")) return null;
    const html = part.html.replaceAll(FIELD.PAGE, String(i + 1)).replaceAll(FIELD.NUMPAGES, String(n));
    if (cache.has(html)) return cache.get(html);
    const d = mupdf.Document.openDocument(new TextEncoder().encode(docHtml(css, `<div class="docx">${fix(html)}</div>`, `${innerW}pt ${P.h}pt`, "0")), "text/html");
    d.layout(innerW, P.h, 11);
    const pg = d.loadPage(0);
    let bottom = 0;
    for (const b of JSON.parse(pg.toStructuredText("preserve-images").asJSON()).blocks) bottom = Math.max(bottom, b.bbox.y + b.bbox.h);
    const r = { pg, h: bottom, dist: part.dist };
    cache.set(html, r);
    return r;
  };

  const buf = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buf, "pdf", "");
  const links = [];
  for (let i = 0; i < n; i++) {
    const pg = bodyDoc.loadPage(i);
    const dev = writer.beginPage([0, 0, P.w, P.h]);
    pg.run(dev, mupdf.Matrix.identity);
    const hd = band(i === 0 ? parts.firstHeader : parts.header, i);
    if (hd) hd.pg.run(dev, mupdf.Matrix.translate(P.ml, hd.dist ?? Math.min(36, P.mt / 2)));
    const ft = band(i === 0 ? parts.firstFooter : parts.footer, i);
    if (ft) ft.pg.run(dev, mupdf.Matrix.translate(P.ml, P.h - (ft.dist ?? Math.min(36, P.mb / 2)) - ft.h));
    writer.endPage();
    links.push(pg.getLinks().filter((l) => l.isExternal()).map((l) => ({ rect: l.getBounds(), uri: l.getURI() })));
  }
  writer.close();
  const bytes = buf.asUint8Array().slice();
  // Les liens web du document restent cliquables.
  if (!links.some((l) => l.length)) return bytes;
  const pdf = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  links.forEach((ls, i) => { if (ls.length) { const p = pdf.loadPage(i); for (const l of ls) p.createLink(l.rect, l.uri); } });
  return pdf.saveToBuffer("compress").asUint8Array().slice();
}
