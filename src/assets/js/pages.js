// Outil « pages » : supprimer, extraire, pivoter, réordonner (et ajouter d'autres PDF). Tout se fait sur des vignettes.
import { t, loadEngine, openPdf, setupDrop, alertStatus, download, suffixName } from "./common.js";
import { assemble, save } from "./engine.js";
import Sortable from "./sortable.esm.js";

const app = document.querySelector('.app[data-tool="pages"]');
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const grid = el("grid");
const status = (msg, kind) => alertStatus(app, msg, kind);

const state = { mupdf: null, docs: [], names: [], items: [], history: [], nextId: 1, lastClicked: null };
// items : [{ id, doc, page, rot, sel }]

/* ---------- Ouverture ---------- */

async function addFile(file, append) {
  try {
    status(t("status.opening"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { mupdf, doc } = await openPdf(bytes);
    state.mupdf = mupdf;
    if (!append) { reset(); }
    else pushHistory();
    const d = state.docs.push(doc) - 1;
    state.names.push(file.name);
    const n = doc.countPages();
    for (let i = 0; i < n; i++) state.items.push({ id: state.nextId++, doc: d, page: i, rot: 0, sel: false });
    app.dataset.state = "open";
    el("filename").textContent = state.names.length > 1 ? t("pages.files", { n: state.names.length }) : file.name;
    render();
    status(append ? t("pages.added", { n, name: file.name }) : t("pages.ready", { n }));
  } catch (e) {
    console.error(e);
    status(t("err.open", { msg: e.message }), "err");
  }
}

function reset() {
  state.docs = []; state.names = []; state.items = []; state.history = [];
  grid.innerHTML = "";
}

setupDrop(app, (file) => addFile(file, app.dataset.state === "open"), { multiple: true });
const more = el("addInput");
el("add").onclick = () => more.click();
more.addEventListener("change", async () => {
  for (const f of [...more.files]) await addFile(f, true);
  more.value = "";
});

el("close").onclick = () => {
  if (state.history.length && !confirm(t("confirm.close"))) return;
  reset();
  delete app.dataset.state;
  status("");
};

/* ---------- Vignettes ---------- */

const thumbCache = new Map(); // "doc:page" -> URL d'image
const observer = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { paint(en.target); observer.unobserve(en.target); }
}, { rootMargin: "400px 0px" });

function paint(card) {
  const it = state.items.find((x) => x.id === +card.dataset.id);
  if (!it) return;
  const key = it.doc + ":" + it.page;
  let url = thumbCache.get(key);
  if (!url) {
    const { mupdf } = state;
    const page = state.docs[it.doc].loadPage(it.page);
    const b = page.getBounds();
    const s = (150 * (window.devicePixelRatio || 1)) / Math.max(b[2] - b[0], b[3] - b[1]);
    const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
    url = URL.createObjectURL(new Blob([pix.asPNG()], { type: "image/png" }));
    pix.destroy();
    thumbCache.set(key, url);
  }
  card.querySelector("img").src = url;
}

function render() {
  observer.disconnect();
  grid.innerHTML = "";
  state.items.forEach((it, idx) => {
    const card = document.createElement("li");
    card.className = "thumb" + (it.sel ? " sel" : "");
    card.dataset.id = it.id;
    card.tabIndex = 0;
    card.setAttribute("aria-selected", it.sel);
    card.innerHTML = `<div class="frame"><img alt="" style="transform:rotate(${it.rot}deg)"></div>
      <div class="meta"><span class="no">${idx + 1}</span>${state.docs.length > 1 ? `<span class="src">${t("pages.fileShort", { n: it.doc + 1 })}</span>` : ""}</div>
      <div class="acts">
        <button type="button" data-a="left" title="${t("pages.rotL")}" aria-label="${t("pages.rotL")}">↺</button>
        <button type="button" data-a="right" title="${t("pages.rotR")}" aria-label="${t("pages.rotR")}">↻</button>
        <button type="button" data-a="del" title="${t("pages.del")}" aria-label="${t("pages.del")}">✕</button>
      </div>`;
    grid.append(card);
    observer.observe(card);
  });
  const nSel = state.items.filter((x) => x.sel).length;
  el("count").textContent = nSel ? t("pages.selected", { n: nSel, total: state.items.length }) : t("pages.total", { total: state.items.length });
  el("extract").disabled = !nSel;
  el("delSel").disabled = !nSel;
  el("undo").disabled = !state.history.length;
  el("download").disabled = !state.items.length;
}

/* ---------- Historique ---------- */

function pushHistory() {
  state.history.push(JSON.stringify(state.items));
  if (state.history.length > 100) state.history.shift();
}
function undo() {
  if (!state.history.length) return;
  state.items = JSON.parse(state.history.pop());
  render();
  status(t("pages.undone"));
}
el("undo").onclick = undo;

/* ---------- Actions ---------- */

function targets() {
  const sel = state.items.filter((x) => x.sel);
  return sel.length ? sel : state.items;
}

function rotate(list, delta) {
  pushHistory();
  list.forEach((it) => (it.rot = (it.rot + delta + 360) % 360));
  render();
  status(t("pages.rotated", { n: list.length }));
}

function remove(list) {
  if (!list.length) return;
  if (list.length === state.items.length) { status(t("pages.cantAll"), "err"); return; }
  pushHistory();
  const ids = new Set(list.map((x) => x.id));
  state.items = state.items.filter((x) => !ids.has(x.id));
  render();
  status(t("pages.deleted", { n: ids.size }));
}

el("rotL").onclick = () => rotate(targets(), -90);
el("rotR").onclick = () => rotate(targets(), 90);
el("delSel").onclick = () => remove(state.items.filter((x) => x.sel));
el("selAll").onclick = () => {
  const all = state.items.every((x) => x.sel);
  state.items.forEach((x) => (x.sel = !all));
  render();
};

grid.addEventListener("click", (e) => {
  const card = e.target.closest(".thumb");
  if (!card) return;
  const it = state.items.find((x) => x.id === +card.dataset.id);
  const a = e.target.closest("button")?.dataset.a;
  if (a === "left") return rotate([it], -90);
  if (a === "right") return rotate([it], 90);
  if (a === "del") return remove([it]);
  // Sélection : clic = basculer ; Maj+clic = plage.
  if (e.shiftKey && state.lastClicked != null) {
    const i1 = state.items.findIndex((x) => x.id === state.lastClicked), i2 = state.items.indexOf(it);
    const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
    for (let k = lo; k <= hi; k++) state.items[k].sel = true;
  } else it.sel = !it.sel;
  state.lastClicked = it.id;
  render();
});

Sortable.create(grid, {
  animation: 150,
  delay: 120, delayOnTouchOnly: true,
  filter: "button", preventOnFilter: false,
  onEnd: (ev) => {
    if (ev.oldIndex === ev.newIndex) return;
    pushHistory();
    const [moved] = state.items.splice(ev.oldIndex, 1);
    state.items.splice(ev.newIndex, 0, moved);
    render();
    status(t("pages.moved"));
  },
});

/* ---------- Enregistrement ---------- */

function build(list) {
  const out = assemble(state.mupdf, state.docs, list.map(({ doc, page, rot }) => ({ doc, page, rot })));
  return save(out);
}

el("download").onclick = () => {
  if (!state.items.length) return;
  const name = suffixName(state.names[0], app.dataset.suffix || "pages");
  download(build(state.items), name);
  status(t("status.downloaded", { name }), "ok");
};

el("extract").onclick = () => {
  const sel = state.items.filter((x) => x.sel);
  if (!sel.length) return;
  const name = suffixName(state.names[0], t("pages.extractSuffix"));
  download(build(sel), name);
  status(t("pages.extracted", { n: sel.length, name }), "ok");
};

document.addEventListener("keydown", (e) => {
  if (app.dataset.state !== "open") return;
  if (e.target instanceof Element && e.target.matches("input, textarea, select")) return;
  const cmd = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (cmd && k === "z") { e.preventDefault(); undo(); }
  else if (cmd && k === "a") { e.preventDefault(); state.items.forEach((x) => (x.sel = true)); render(); }
  else if (cmd && k === "s") { e.preventDefault(); el("download").click(); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(state.items.filter((x) => x.sel)); }
  else if (e.key === "Escape") { state.items.forEach((x) => (x.sel = false)); render(); }
  else if (e.key === "Enter" && e.target.closest?.(".thumb")) { e.target.click(); }
});

window.addEventListener("beforeunload", (e) => { if (state.history.length) e.preventDefault(); });

const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
window.__pdfanonymPages = { state, addFile };
