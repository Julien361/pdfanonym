// Modifier le texte existant : un clic sur un mot (ou un glissé sur plusieurs mots d'une même ligne) ouvre un champ de saisie.
// Chaque remplacement est appliqué tout de suite au document (aperçu exact) : l'ancien texte est réellement retiré,
// le nouveau est écrit à la même place, dans la police d'origine quand elle le permet. Annuler = retour à l'état précédent.
import { t, loadEngine, openPdf, setupDrop, alertStatus, download, suffixName } from "./common.js";
import { save, flatten } from "./engine.js";
import { pageWords, replaceWords } from "./edit.js";

const app = document.querySelector('.app[data-tool="textedit"]');
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const viewer = el("viewer");
const status = (msg, kind) => alertStatus(app, msg, kind);
const state = { mupdf: null, doc: null, name: "", pages: [], zoom: 1, undo: [], edits: 0, editor: null };
const MAX_UNDO = 30;

/* ---------- Ouverture ---------- */

async function openBytes(bytes, keepView = false) {
  const { mupdf, doc } = await openPdf(bytes);
  // Le texte d'un champ de formulaire n'appartient pas à la page : on l'y intègre pour pouvoir le modifier.
  let forms = false;
  for (let i = 0; i < doc.countPages() && !forms; i++) forms = doc.loadPage(i).getWidgets().length > 0;
  if (forms) flatten(doc, { forms: true, annots: false });
  Object.assign(state, { mupdf, doc });
  const top = viewer.scrollTop;
  build(keepView);
  if (keepView) viewer.scrollTop = top;
  return forms;
}

setupDrop(app, async (file) => {
  try {
    status(t("status.opening"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    Object.assign(state, { name: file.name, undo: [], edits: 0 });
    app.dataset.state = "open";
    el("filename").textContent = file.name;
    const forms = await openBytes(bytes);
    syncUndo();
    const hasText = state.pages.slice(0, 3).some((p) => words(p).length);
    status(hasText ? t("tedit.ready") + (forms ? " " + t("status.forms") : "") : t("tedit.noText"), hasText ? "" : "err");
  } catch (e) {
    console.error(e);
    status(t("err.open", { msg: e.message }), "err");
  }
});

/* ---------- Affichage ---------- */

const observer = new IntersectionObserver((ents) => ents.forEach((en) => en.isIntersecting && paint(+en.target.dataset.index)), { root: viewer, rootMargin: "600px 0px" });

function build(keepZoom) {
  observer.disconnect();
  state.pages.forEach((p) => p.img.src && URL.revokeObjectURL(p.img.src));
  viewer.innerHTML = "";
  state.pages = [];
  if (!keepZoom) {
    const b0 = state.doc.loadPage(0).getBounds();
    const avail = viewer.clientWidth - 48;
    if (avail > 200) state.zoom = Math.min(1.5, Math.max(0.5, Math.floor((avail / (b0[2] - b0[0])) * 10) / 10));
  }
  el("zoomVal").textContent = Math.round(state.zoom * 100) + " %";
  for (let i = 0; i < state.doc.countPages(); i++) {
    const page = state.doc.loadPage(i);
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.index = i;
    div.innerHTML = `<span class="num">${t("page", { n: i + 1 })}</span><img alt=""><div class="layer"></div>`;
    viewer.append(div);
    const p = { page, bounds: page.getBounds(), words: null, el: div, layer: div.querySelector(".layer"), img: div.querySelector("img"), rendered: false };
    state.pages.push(p);
    size(p);
    observer.observe(div);
    attach(i);
  }
}

function size(p) {
  p.el.style.width = (p.bounds[2] - p.bounds[0]) * state.zoom + "px";
  p.el.style.height = (p.bounds[3] - p.bounds[1]) * state.zoom + "px";
}

function paint(i) {
  const p = state.pages[i];
  if (!p || p.rendered) return;
  p.rendered = true;
  const s = state.zoom * (window.devicePixelRatio || 1), { mupdf } = state;
  const pix = p.page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
  if (p.img.src) URL.revokeObjectURL(p.img.src);
  p.img.src = URL.createObjectURL(new Blob([pix.asPNG().slice()], { type: "image/png" }));
  pix.destroy();
}

function refresh(i) {
  const p = state.pages[i];
  p.page = state.doc.loadPage(i);
  p.words = null;
  p.rendered = false;
  paint(i);
}

function setZoom(z) {
  if (!state.doc) return;
  closeEditor(false);
  state.zoom = Math.min(3, Math.max(0.3, Math.round(z * 10) / 10));
  el("zoomVal").textContent = Math.round(state.zoom * 100) + " %";
  state.pages.forEach((p) => { size(p); p.rendered = false; });
  const v = viewer.getBoundingClientRect();
  state.pages.forEach((p, i) => { const r = p.el.getBoundingClientRect(); if (r.bottom > v.top - 600 && r.top < v.bottom + 600) paint(i); });
}
el("zoomIn").onclick = () => setZoom(state.zoom + 0.2);
el("zoomOut").onclick = () => setZoom(state.zoom - 0.2);

/* ---------- Mots ---------- */

const words = (p) => (p.words ||= pageWords(p.page));
const pt = (i, e) => { const p = state.pages[i], r = p.layer.getBoundingClientRect(); return [p.bounds[0] + (e.clientX - r.left) / state.zoom, p.bounds[1] + (e.clientY - r.top) / state.zoom]; };

// Mot sous le pointeur, avec une petite tolérance pour les mots fins (points, chiffres isolés).
function wordAt(i, [x, y]) {
  let best = null, dist = 3;
  for (const w of words(state.pages[i])) {
    const [x0, y0, x1, y1] = w.rect;
    const d = Math.max(x0 - x, 0, x - x1) + Math.max(y0 - y, 0, y - y1);
    if (d < dist) { dist = d; best = w; }
  }
  return best;
}

function box(i, rect, cls) {
  const p = state.pages[i], d = document.createElement("div");
  d.className = "box " + cls;
  Object.assign(d.style, {
    left: (rect[0] - p.bounds[0]) * state.zoom + "px", top: (rect[1] - p.bounds[1]) * state.zoom + "px",
    width: (rect[2] - rect[0]) * state.zoom + "px", height: (rect[3] - rect[1]) * state.zoom + "px",
  });
  p.layer.append(d);
}
const clear = (i, cls = ".hover,.pick") => state.pages[i].layer.querySelectorAll(cls).forEach((n) => n.remove());

// Mots d'une même ligne entre a et b (sélection par glissé).
function range(i, a, b) {
  if (!b || a === b || a.line !== b.line) return [a];
  const ws = words(state.pages[i]);
  const [s, e] = [ws.indexOf(a), ws.indexOf(b)].sort((x, y) => x - y);
  return ws.slice(s, e + 1);
}

function attach(i) {
  const layer = state.pages[i].layer;
  let start = null;
  layer.addEventListener("pointermove", (e) => {
    if (state.editor) return;
    clear(i);
    const w = wordAt(i, pt(i, e));
    if (start) range(i, start, w).forEach((x) => box(i, x.rect, "pick"));
    else if (w && e.pointerType === "mouse") box(i, w.rect, "hover");
  });
  layer.addEventListener("pointerleave", () => !start && clear(i));
  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target !== layer) return;
    if (state.editor) closeEditor(true); // un clic ailleurs valide la saisie en cours
    const w = wordAt(i, pt(i, e));
    if (!w) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    start = w;
  });
  layer.addEventListener("pointerup", (e) => {
    if (!start) return;
    const sel = range(i, start, wordAt(i, pt(i, e)));
    start = null;
    clear(i);
    openEditor(i, sel);
  });
}

/* ---------- Saisie ---------- */

function openEditor(i, sel) {
  const p = state.pages[i], first = sel[0];
  const rect = sel.reduce((r, w) => [Math.min(r[0], w.rect[0]), Math.min(r[1], w.rect[1]), Math.max(r[2], w.rect[2]), Math.max(r[3], w.rect[3])], first.rect.slice());
  const original = sel.map((w) => w.text).join(" ");
  sel.forEach((w) => box(i, w.rect, "pick"));
  const input = document.createElement("input");
  input.className = "wordedit";
  input.value = original;
  input.setAttribute("aria-label", t("tedit.inputLabel"));
  input.spellcheck = false;
  const h = (rect[3] - rect[1]) * state.zoom;
  Object.assign(input.style, {
    left: (rect[0] - p.bounds[0]) * state.zoom - 3 + "px", top: (rect[1] - p.bounds[1]) * state.zoom - 3 + "px",
    height: h + 6 + "px", fontSize: Math.max(11, first.size * state.zoom) + "px",
  });
  const fit = () => (input.style.width = Math.max((rect[2] - rect[0]) * state.zoom + 10, (input.value.length + 1) * Math.max(11, first.size * state.zoom) * 0.62) + "px");
  fit();
  input.addEventListener("input", fit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); closeEditor(true); }
    else if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
    else if (e.key === "Tab") {
      // Tab : valide et passe au mot suivant (Maj+Tab : précédent), comme dans un tableur.
      e.preventDefault();
      const ws = words(p), k = ws.indexOf(e.shiftKey ? first : sel[sel.length - 1]) + (e.shiftKey ? -1 : 1);
      const next = ws[k] && { line: ws[k].line, rect: ws[k].rect, x: ws[k].x };
      closeEditor(true);
      if (next) {
        const again = words(state.pages[i]).find((w) => w.line === next.line && Math.abs(w.rect[0] - next.rect[0]) < 0.5 && Math.abs(w.rect[1] - next.rect[1]) < 0.5)
          || words(state.pages[i]).find((w) => Math.abs(w.rect[1] - next.rect[1]) < 1 && w.rect[0] >= next.rect[0] - 0.5);
        if (again) openEditor(i, [again]);
      }
    }
  });
  input.addEventListener("blur", () => setTimeout(() => state.editor?.input === input && closeEditor(true), 0));
  p.layer.append(input);
  state.editor = { i, sel, input, original };
  input.focus();
  input.select();
}

function closeEditor(commit) {
  const ed = state.editor;
  if (!ed) return;
  state.editor = null;
  ed.input.remove();
  clear(ed.i);
  const text = ed.input.value.replace(/\s+/g, " ").trim();
  if (!commit || text === ed.original) return;
  apply(ed.i, ed.sel, text);
}

function apply(i, sel, text) {
  try {
    pushUndo();
    const p = state.pages[i];
    // Plusieurs mots sélectionnés = un seul bloc remplacé d'un coup.
    const merged = sel.length === 1 ? sel[0] : {
      ...sel[0], text: sel.map((w) => w.text).join(" "), quads: sel.flatMap((w) => w.quads),
      rect: [sel[0].rect[0], Math.min(...sel.map((w) => w.rect[1])), sel[sel.length - 1].rect[2], Math.max(...sel.map((w) => w.rect[3]))],
    };
    const all = sel.length === 1 ? words(p) : words(p).filter((w) => !sel.includes(w) || w === sel[0]).map((w) => (w === sel[0] ? merged : w));
    replaceWords(state.mupdf, state.doc, i, [{ word: merged, text }], all);
    state.edits++;
    refresh(i);
    status(text ? t("tedit.replaced", { a: merged.text, b: text }) : t("tedit.erased", { a: merged.text }), "ok");
  } catch (e) {
    console.error(e);
    undo(true);
    status(t("err.process", { msg: e.message }), "err");
  }
}

/* ---------- Annuler ---------- */

function pushUndo() {
  // Enregistrement brut, sans « garbage » : le compactage renumérote les objets du document ouvert, et une police
  // ajoutée ensuite pouvait se retrouver remplacée par une autre (constaté : police changée au 3e remplacement).
  state.undo.push({ bytes: state.doc.saveToBuffer("").asUint8Array().slice(), edits: state.edits });
  if (state.undo.length > MAX_UNDO) state.undo.shift();
  syncUndo();
}
function syncUndo() { el("undo").disabled = !state.undo.length; }

async function undo(silent = false) {
  const last = state.undo.pop();
  syncUndo();
  if (!last) return;
  closeEditor(false);
  await openBytes(last.bytes, true);
  state.edits = last.edits;
  if (!silent) status(t("tedit.undone"));
}
el("undo").onclick = () => undo();
document.addEventListener("keydown", (e) => {
  if (!state.doc || state.editor) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
});

/* ---------- Téléchargement ---------- */

el("download").onclick = async () => {
  if (!state.doc) return;
  closeEditor(true);
  try {
    const name = suffixName(state.name, app.dataset.suffix || "edited");
    // Enregistrement compacté : les anciens contenus de page (avec l'ancien texte) ne restent pas dans le fichier.
    const bytes = save(state.doc);
    download(bytes, name);
    await openBytes(bytes.slice(), true); // le compactage a renuméroté le document ouvert : on repart du fichier enregistré
    status(t("tedit.done", { n: state.edits, name }), "ok");
  } catch (e) {
    console.error(e);
    status(t("err.process", { msg: e.message }), "err");
  }
};

el("close").onclick = () => {
  if (state.edits && !confirm(t("confirm.close"))) return;
  closeEditor(false);
  observer.disconnect();
  Object.assign(state, { doc: null, pages: [], undo: [], edits: 0 });
  viewer.innerHTML = "";
  delete app.dataset.state;
  status("");
};

window.addEventListener("beforeunload", (e) => { if (state.edits) e.preventDefault(); });
const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
window.__pdfanonymTextEdit = { state };
