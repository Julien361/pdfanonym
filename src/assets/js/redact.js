// Éditeur de caviardage / suppression de texte. Le texte marqué est réellement retiré du fichier (annotations Redact appliquées).
import { t, loadEngine, openPdf, setupDrop, alertStatus, download, suffixName } from "./common.js";
import { clean, save, flatten } from "./engine.js";
import { detectPII, detectPIIPro, PII_TYPES, PRO_TYPES } from "./pii.js";
import { status as licenseStatus } from "./license.js";
import { buildReport } from "./report.js";
import { download as dl } from "./common.js";

const app = document.querySelector('.app[data-tool="redact"]');
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const viewer = el("viewer"), marksEl = el("marks");

const state = {
  mupdf: null, doc: null, fileName: "document.pdf",
  pages: [], marks: [], snapshots: [], log: [], pro: false,
  mode: "text", zoom: 1, nextId: 1,
};
const status = (msg, kind) => alertStatus(app, msg, kind);

el("optBlack").checked = app.dataset.black === "1";

/* ---------- Ouverture ---------- */

async function openBytes(bytes, name, keepHistory = false) {
  try {
    status(t("status.opening"));
    const { mupdf, doc } = await openPdf(bytes);
    // Le texte saisi dans un champ de formulaire n'appartient pas à la page : on l'y intègre pour pouvoir le caviarder.
    let hadForms = false;
    for (let i = 0; i < doc.countPages() && !hadForms; i++) hadForms = doc.loadPage(i).getWidgets().length > 0;
    if (hadForms) flatten(doc, { forms: true, annots: false });
    state.mupdf = mupdf;
    state.doc = doc;
    state.fileName = name || "document.pdf";
    state.marks = [];
    if (!keepHistory) { state.snapshots = []; state.log = []; }
    app.dataset.state = "open";
    el("filename").textContent = state.fileName;
    buildPages();
    const textless = !hasText();
    status(textless ? t("status.noText") : t("status.ready", { n: state.pages.length }) + (hadForms ? " " + t("status.forms") : ""), textless ? "err" : "");
    if (textless) setMode("zone");
    el("piiList").innerHTML = "";
    if (app.dataset.focus === "anonymize" && !textless) scanPII();
  } catch (e) {
    console.error(e);
    status(t("err.open", { msg: e.message }), "err");
  }
}

function hasText() {
  for (let i = 0; i < Math.min(3, state.pages.length); i++) if (getStext(state.pages[i]).asText().trim()) return true;
  return false;
}

setupDrop(app, async (file) => openBytes(new Uint8Array(await file.arrayBuffer()), file.name));

function closeDoc() {
  if (state.doc && (state.marks.length || state.snapshots.length) && !confirm(t("confirm.close"))) return;
  observer.disconnect();
  state.pages.forEach((p) => p.img.src && URL.revokeObjectURL(p.img.src));
  Object.assign(state, { doc: null, pages: [], marks: [], snapshots: [] });
  viewer.innerHTML = "";
  delete app.dataset.state;
  renderMarks();
  status("");
}
el("close").onclick = closeDoc;

/* ---------- Affichage ---------- */

const observer = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) renderPage(+en.target.dataset.index);
}, { root: viewer, rootMargin: "600px 0px" });

function buildPages() {
  observer.disconnect();
  state.pages.forEach((p) => p.img.src && URL.revokeObjectURL(p.img.src));
  viewer.innerHTML = "";
  state.pages = [];
  // Ajuste le zoom à la largeur disponible au premier affichage.
  const first = state.doc.loadPage(0).getBounds();
  const avail = viewer.clientWidth - 48;
  if (avail > 200) state.zoom = Math.min(1.5, Math.max(0.5, Math.floor((avail / (first[2] - first[0])) * 10) / 10));
  el("zoomVal").textContent = Math.round(state.zoom * 100) + " %";
  const n = state.doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = state.doc.loadPage(i);
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.index = i;
    const img = document.createElement("img");
    img.alt = "";
    const layer = document.createElement("div");
    layer.className = "layer";
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = t("page", { n: i + 1 });
    div.append(num, img, layer);
    viewer.append(div);
    const p = { page, bounds: page.getBounds(), stext: null, el: div, img, layer, rendered: false };
    state.pages.push(p);
    attachPointer(i);
    sizePage(p);
    observer.observe(div);
  }
  renderMarks();
}

function sizePage(p) {
  const [x0, y0, x1, y1] = p.bounds;
  p.el.style.width = (x1 - x0) * state.zoom + "px";
  p.el.style.height = (y1 - y0) * state.zoom + "px";
}

function renderPage(i) {
  const p = state.pages[i];
  if (!p || p.rendered) return;
  p.rendered = true;
  const { mupdf } = state;
  const s = state.zoom * (window.devicePixelRatio || 1);
  const pix = p.page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = pix.asPNG();
  pix.destroy();
  if (p.img.src) URL.revokeObjectURL(p.img.src);
  p.img.src = URL.createObjectURL(new Blob([png], { type: "image/png" }));
}

function getStext(p) {
  if (!p.stext) p.stext = p.page.toStructuredText("preserve-whitespace");
  return p.stext;
}

function refreshPage(i) {
  const p = state.pages[i];
  p.page = state.doc.loadPage(i);
  p.bounds = p.page.getBounds();
  p.stext = null;
  p.rendered = false;
  sizePage(p);
  renderPage(i);
}

function setZoom(z) {
  if (!state.doc) return;
  state.zoom = Math.min(4, Math.max(0.3, Math.round(z * 10) / 10));
  el("zoomVal").textContent = Math.round(state.zoom * 100) + " %";
  state.pages.forEach((p) => { sizePage(p); p.rendered = false; });
  const v = viewer.getBoundingClientRect();
  state.pages.forEach((p, i) => {
    const r = p.el.getBoundingClientRect();
    if (r.bottom > v.top - 600 && r.top < v.bottom + 600) renderPage(i);
  });
  renderMarks();
}
el("zoomIn").onclick = () => setZoom(state.zoom + 0.2);
el("zoomOut").onclick = () => setZoom(state.zoom - 0.2);

/* ---------- Géométrie ---------- */

function toPagePoint(i, ev) {
  const p = state.pages[i], r = p.layer.getBoundingClientRect();
  return [p.bounds[0] + (ev.clientX - r.left) / state.zoom, p.bounds[1] + (ev.clientY - r.top) / state.zoom];
}
const quadToRect = (q) => [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])];
const rectArea = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const sameRect = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 0.5);

function drawRect(i, rect, cls) {
  const p = state.pages[i], d = document.createElement("div");
  d.className = "box " + cls;
  d.style.left = (rect[0] - p.bounds[0]) * state.zoom + "px";
  d.style.top = (rect[1] - p.bounds[1]) * state.zoom + "px";
  d.style.width = (rect[2] - rect[0]) * state.zoom + "px";
  d.style.height = (rect[3] - rect[1]) * state.zoom + "px";
  p.layer.append(d);
  return d;
}
const clearTemp = (i) => state.pages[i].layer.querySelectorAll(".sel,.hover,.drag").forEach((n) => n.remove());

/* ---------- Sélection à la souris (et au doigt) ---------- */

function attachPointer(i) {
  const layer = state.pages[i].layer;
  let start = null, lastClick = { t: 0, x: 0, y: 0 };

  layer.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    layer.setPointerCapture(ev.pointerId);
    start = toPagePoint(i, ev);
    clearTemp(i);
  });

  layer.addEventListener("pointermove", (ev) => {
    const q = toPagePoint(i, ev);
    clearTemp(i);
    if (!start) {
      if (state.mode === "text" && ev.pointerType === "mouse") {
        const r = quadToRect(getStext(state.pages[i]).snap(q, q, "words"));
        if (rectArea(r) > 0) drawRect(i, r, "hover");
      }
      return;
    }
    if (state.mode === "zone") {
      drawRect(i, [Math.min(start[0], q[0]), Math.min(start[1], q[1]), Math.max(start[0], q[0]), Math.max(start[1], q[1])], "drag");
    } else {
      for (const quad of getStext(state.pages[i]).highlight(start, q)) drawRect(i, quadToRect(quad), "sel");
    }
  });

  layer.addEventListener("pointerleave", () => { if (!start) clearTemp(i); });

  layer.addEventListener("pointerup", (ev) => {
    if (!start) return;
    const q = toPagePoint(i, ev), a = start;
    start = null;
    clearTemp(i);
    const moved = Math.hypot(q[0] - a[0], q[1] - a[1]) * state.zoom > 4;
    const st = getStext(state.pages[i]);

    if (state.mode === "zone") {
      if (!moved) return;
      const r = [Math.min(a[0], q[0]), Math.min(a[1], q[1]), Math.max(a[0], q[0]), Math.max(a[1], q[1])];
      const txt = st.copy([r[0], r[1]], [r[2], r[3]]).trim();
      addMark({ pageIndex: i, rects: [r], kind: "zone", cat: "area", label: txt ? t("mark.zoneWith", { text: txt }) : t("mark.zone") });
      return;
    }
    if (moved) {
      const rects = st.highlight(a, q).map(quadToRect).filter((r) => rectArea(r) > 0);
      if (rects.length) addMark({ pageIndex: i, rects, kind: "text", cat: "manual", label: st.copy(a, q).trim() });
      return;
    }
    // Clic = un mot ; double-clic = la ligne (remplace le mot du premier clic) ; re-clic sur un mot marqué = le démarquer.
    const now = performance.now();
    const dbl = now - lastClick.t < 450 && Math.hypot(ev.clientX - lastClick.x, ev.clientY - lastClick.y) < 6;
    lastClick = dbl ? { t: 0, x: 0, y: 0 } : { t: now, x: ev.clientX, y: ev.clientY };
    const mode = dbl ? "lines" : "words";
    const r = quadToRect(st.snap(q, q, mode));
    if (rectArea(r) === 0) return;
    if (mode === "lines") {
      const last = state.marks[state.marks.length - 1];
      if (last && last.fromClick && last.pageIndex === i) state.marks.pop();
    } else {
      const hit = state.marks.findIndex((m) => m.pageIndex === i && m.fromClick === "words" && m.rects.length === 1 && sameRect(m.rects[0], r));
      if (hit >= 0) { state.marks.splice(hit, 1); renderMarks(); return; }
    }
    const mid = (r[1] + r[3]) / 2;
    addMark({ pageIndex: i, rects: [r], kind: "text", cat: "manual", label: st.copy([r[0] + 0.1, mid], [r[2] - 0.1, mid]).trim(), fromClick: mode });
  });
}

/* ---------- Marques ---------- */

function addMark(m) {
  m.id = state.nextId++;
  state.marks.push(m);
  renderMarks();
}

function renderMarks() {
  state.pages.forEach((p) => p.layer.querySelectorAll(".mark").forEach((n) => n.remove()));
  for (const m of state.marks) for (const r of m.rects) drawRect(m.pageIndex, r, "mark").dataset.id = m.id;
  el("count").textContent = state.marks.length;
  marksEl.innerHTML = "";
  if (!state.marks.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = t("marks.empty");
    marksEl.append(li);
  }
  for (const m of state.marks) {
    const li = document.createElement("li");
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = (m.label || t("mark.text")).slice(0, 140);
    const pg = document.createElement("span");
    pg.className = "pg";
    pg.textContent = t("pageShort", { n: m.pageIndex + 1 });
    const x = document.createElement("button");
    x.className = "x";
    x.type = "button";
    x.title = x.ariaLabel = t("mark.remove");
    x.textContent = "×";
    x.onclick = (e) => { e.stopPropagation(); state.marks = state.marks.filter((k) => k.id !== m.id); renderMarks(); };
    li.append(lbl, pg, x);
    li.onclick = () => focusMark(m);
    marksEl.append(li);
  }
  el("apply").disabled = !state.marks.length;
  el("undo").disabled = !state.marks.length && !state.snapshots.length;
}

function focusMark(m) {
  const p = state.pages[m.pageIndex];
  viewer.scrollTo({ top: p.el.offsetTop + (m.rects[0][1] - p.bounds[1]) * state.zoom - viewer.clientHeight / 3, behavior: "smooth" });
  p.layer.querySelectorAll(`.mark[data-id="${m.id}"]`).forEach((n) => { n.classList.remove("flash"); void n.offsetWidth; n.classList.add("flash"); });
}

/* ---------- Recherche ---------- */

el("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = el("search");
  const needle = input.value.trim();
  if (!state.doc || !needle) return;
  let n = 0;
  state.pages.forEach((p, i) => {
    for (const hit of p.page.search(needle, "ignore-case,ignore-diacritics")) {
      const rects = hit.map(quadToRect).filter((r) => rectArea(r) > 0);
      if (!rects.length) continue;
      if (state.marks.some((m) => m.pageIndex === i && m.rects.length === rects.length && m.rects.every((r, k) => sameRect(r, rects[k])))) continue;
      state.marks.push({ id: state.nextId++, pageIndex: i, rects, kind: "text", cat: "search", label: needle });
      n++;
    }
  });
  renderMarks();
  status(n ? t("status.found", { n, q: needle }) : t("status.notFound", { q: needle }), n ? "" : "err");
  if (n) {
    input.blur();
    const first = state.marks.find((m) => m.label === needle);
    if (first) focusMark(first);
  }
});

/* ---------- Détection des données personnelles ---------- */

let piiHits = []; // { type, value, page }

async function scanPII() {
  if (!state.doc) return;
  state.pro = (await licenseStatus()).active;
  piiHits = [];
  state.pages.forEach((p, i) => {
    const text = getStext(p).asText();
    for (const f of detectPII(text)) piiHits.push({ ...f, page: i });
    for (const f of detectPIIPro(text)) piiHits.push({ ...f, page: i, pro: true });
  });
  const list = el("piiList");
  list.innerHTML = "";
  if (!piiHits.length) { list.innerHTML = `<p class="muted small">${t("pii.none")}</p><p class="pii-warn">${t("pii.warn")}</p>`; status(t("pii.none"), "ok"); return; }
  const box = document.createElement("div");
  box.className = "pii-list";
  for (const type of [...PII_TYPES, ...PRO_TYPES]) {
    const hits = piiHits.filter((h) => h.type === type);
    if (!hits.length) continue;
    const isPro = PRO_TYPES.includes(type), locked = isPro && !state.pro;
    const uniq = [...new Set(hits.map((h) => h.value))];
    const lab = document.createElement("label");
    if (locked) lab.className = "locked";
    lab.innerHTML = `<input type="checkbox" data-pii="${type}"${type === "date" || locked ? "" : " checked"}${locked ? " disabled" : ""}> <span></span>${isPro ? ' <b class="pro-badge">PRO</b>' : ""}<span class="n">${hits.length}</span>`;
    lab.querySelector("span").textContent = t("pii." + type);
    const ex = document.createElement("span");
    ex.className = "ex";
    ex.textContent = locked ? t("pro.locked") : uniq.slice(0, 3).join(" · ") + (uniq.length > 3 ? " …" : "");
    box.append(lab, ex);
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn dark";
  btn.textContent = t("pii.mark");
  btn.onclick = markPII;
  list.append(box, btn);
  if (!state.pro && piiHits.some((h) => h.pro)) {
    const up = document.createElement("a");
    up.className = "btn primary pro-cta";
    up.href = app.dataset.pricing;
    up.textContent = t("pro.unlock");
    list.append(up);
  }
  const warn = document.createElement("p");
  warn.className = "pii-warn";
  warn.textContent = t("pii.warn");
  list.append(warn);
  status(t("pii.found", { n: piiHits.filter((h) => !h.pro || state.pro).length }));
}

function markPII() {
  const types = new Set([...el("piiList").querySelectorAll("[data-pii]:checked")].map((c) => c.dataset.pii));
  let n = 0;
  const done = new Set();
  for (const h of piiHits) {
    if (!types.has(h.type) || (h.pro && !state.pro)) continue;
    const key = h.page + "|" + h.value;
    if (done.has(key)) continue;
    done.add(key);
    for (const hit of state.pages[h.page].page.search(h.value)) {
      const rects = hit.map(quadToRect).filter((r) => rectArea(r) > 0);
      if (!rects.length) continue;
      if (state.marks.some((m) => m.pageIndex === h.page && m.rects.length === rects.length && m.rects.every((r, k) => sameRect(r, rects[k])))) continue;
      state.marks.push({ id: state.nextId++, pageIndex: h.page, rects, kind: "text", cat: h.type, label: t("pii." + h.type) + " : " + h.value });
      n++;
    }
  }
  renderMarks();
  status(n ? t("pii.marked", { n }) : t("pii.nothingMarked"), n ? "" : "err");
  const first = state.marks[state.marks.length - n];
  if (n && first) focusMark(first);
}
el("piiScan").onclick = scanPII;

/* ---------- Listes de termes enregistrées (pro) ---------- */

const TERMS_KEY = "pdfanonym.terms";
const termsBox = el("terms");
try { termsBox.value = localStorage.getItem(TERMS_KEY) || ""; } catch { /* stockage indisponible */ }
termsBox.addEventListener("input", () => { try { localStorage.setItem(TERMS_KEY, termsBox.value); } catch { /* idem */ } });
el("termsMark").onclick = async () => {
  if (!state.doc) return;
  if (!(await licenseStatus()).active) { location.href = app.dataset.pricing; return; }
  const terms = termsBox.value.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 1);
  let n = 0;
  for (const term of terms) state.pages.forEach((p, i) => {
    for (const hit of p.page.search(term, "ignore-case,ignore-diacritics")) {
      const rects = hit.map(quadToRect).filter((r) => rectArea(r) > 0);
      if (!rects.length || state.marks.some((m) => m.pageIndex === i && m.rects.length === rects.length && m.rects.every((r, k) => sameRect(r, rects[k])))) continue;
      state.marks.push({ id: state.nextId++, pageIndex: i, rects, kind: "text", cat: "list", label: term });
      n++;
    }
  });
  renderMarks();
  status(n ? t("pii.marked", { n }) : t("status.notFound", { q: terms.slice(0, 3).join(", ") }), n ? "" : "err");
};

/* ---------- Suppression réelle ---------- */

function applyMarks() {
  if (!state.marks.length) return 0;
  const { mupdf } = state;
  const P = mupdf.PDFPage;
  state.snapshots.push(state.doc.saveToBuffer("").asUint8Array().slice());
  const black = el("optBlack").checked;
  const zoneImg = el("optImages").checked ? P.REDACT_IMAGE_PIXELS : P.REDACT_IMAGE_NONE;
  const zoneLines = el("optLines").checked ? P.REDACT_LINE_ART_REMOVE_IF_COVERED : P.REDACT_LINE_ART_NONE;
  const byPage = new Map();
  for (const m of state.marks) (byPage.get(m.pageIndex) || byPage.set(m.pageIndex, []).get(m.pageIndex)).push(m);
  let count = 0;
  for (const [i, marks] of byPage) {
    const page = state.pages[i].page;
    // Zones d'abord (options images/traits), puis le texte seul.
    for (const kind of ["zone", "text"]) {
      const sel = marks.filter((m) => m.kind === kind);
      if (!sel.length) continue;
      for (const m of sel) for (const r of m.rects) { page.createAnnotation("Redact").setRect(r); count++; }
      page.applyRedactions(black, kind === "zone" ? zoneImg : P.REDACT_IMAGE_NONE, kind === "zone" ? zoneLines : P.REDACT_LINE_ART_NONE, P.REDACT_TEXT_REMOVE);
    }
    refreshPage(i);
  }
  for (const m of state.marks) state.log.push({ page: m.pageIndex + 1, cat: m.cat || "manual", n: m.rects.length });
  state.marks = [];
  renderMarks();
  return count;
}

function applyWithStatus() {
  const n = applyMarks();
  status(n ? t("status.applied", { n }) : t("status.nothing"), n ? "ok" : "err");
}
el("apply").onclick = applyWithStatus;

async function undo() {
  if (state.marks.length) {
    state.marks.pop();
    renderMarks();
    status(t("status.unmarked"));
  } else if (state.snapshots.length) {
    const bytes = state.snapshots.pop();
    const top = viewer.scrollTop;
    await openBytes(bytes, state.fileName, true);
    viewer.scrollTop = top;
    renderMarks();
    status(t("status.undone"));
  }
}
el("undo").onclick = undo;

el("download").onclick = async () => {
  if (!state.doc) return;
  const n = applyMarks();
  if (el("optMeta").checked) clean(state.doc);
  const bytes = save(state.doc, { scrub: el("optMeta").checked });
  const name = suffixName(state.fileName, app.dataset.suffix || "redacted");
  download(bytes, name);
  status((n ? t("status.applied", { n }) + " " : "") + t("status.downloaded", { name }), "ok");
  if (el("optReport").checked && state.log.length) {
    if (!(await licenseStatus()).active) { status(t("pro.reportLocked"), "err"); return; }
    const rep = await buildReport(state.mupdf, { file: name, bytes, pages: state.pages.length, log: state.log, t });
    setTimeout(() => dl(rep, name.replace(/\.pdf$/i, "") + "-" + t("report.suffix") + ".pdf"), 400);
  }
};

/* ---------- Modes et clavier ---------- */

function setMode(mode) {
  state.mode = mode;
  app.querySelectorAll("[data-mode]").forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on); });
  viewer.classList.toggle("zone", mode === "zone");
}
app.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

document.addEventListener("keydown", (e) => {
  if (!state.doc) return;
  const cmd = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  const inField = e.target instanceof Element && e.target.matches("input, textarea, select");
  if (cmd && k === "f") { e.preventDefault(); el("search").focus(); el("search").select(); return; }
  if (cmd && k === "s") { e.preventDefault(); el("download").click(); return; }
  if (inField) { if (e.key === "Escape") e.target.blur(); return; }
  if (cmd && k === "z") { e.preventDefault(); undo(); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); applyWithStatus(); }
  else if (e.key === "Escape" && state.marks.length) { state.marks = []; renderMarks(); status(t("status.cleared")); }
  else if (cmd || e.altKey) return;
  else if (k === "t") setMode("text");
  else if (k === "r") setMode("zone");
});

window.addEventListener("beforeunload", (e) => { if (state.marks.length || state.snapshots.length) e.preventDefault(); });

renderMarks();
window.__pdfanonym = { state, openBytes, applyMarks };

// Charge le moteur juste après l'affichage (sans gêner le rendu) : l'outil marche ensuite hors connexion.
const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
