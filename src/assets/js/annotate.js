// Ajouter du texte et une signature dessinée. Les éléments sont posés en coordonnées de page (points, repère visuel),
// puis gravés dans le PDF au téléchargement (texte réel en Helvetica, signature en image PNG transparente).
import { t, loadEngine, openPdf, setupDrop, alertStatus, download, suffixName } from "./common.js";
import { save } from "./engine.js";
import { stamper } from "./edit.js";

const app = document.querySelector('.app[data-tool="annotate"]');
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const viewer = el("viewer");
const status = (msg, kind) => alertStatus(app, msg, kind);
const state = { bytes: null, name: "", mupdf: null, doc: null, pages: [], items: [], zoom: 1, mode: app.dataset.focus === "sign" ? "sign" : "text", sig: null, nextId: 1 };

/* ---------- Ouverture et rendu ---------- */

setupDrop(app, async (file) => {
  try {
    status(t("status.opening"));
    state.bytes = new Uint8Array(await file.arrayBuffer());
    const { mupdf, doc } = await openPdf(state.bytes.slice());
    Object.assign(state, { mupdf, doc, name: file.name, items: [] });
    app.dataset.state = "open";
    el("filename").textContent = file.name;
    build();
    status(t(state.mode === "sign" ? "annot.readySign" : "annot.readyText"));
    if (state.mode === "sign" && !state.sig) openPad();
  } catch (e) {
    console.error(e);
    status(t("err.open", { msg: e.message }), "err");
  }
});

const observer = new IntersectionObserver((ents) => ents.forEach((en) => en.isIntersecting && paint(+en.target.dataset.index)), { root: viewer, rootMargin: "600px 0px" });

function build() {
  observer.disconnect();
  viewer.innerHTML = "";
  state.pages = [];
  const b0 = state.doc.loadPage(0).getBounds();
  const avail = viewer.clientWidth - 48;
  if (avail > 200) state.zoom = Math.min(1.5, Math.max(0.5, Math.floor((avail / (b0[2] - b0[0])) * 10) / 10));
  el("zoomVal").textContent = Math.round(state.zoom * 100) + " %";
  for (let i = 0; i < state.doc.countPages(); i++) {
    const page = state.doc.loadPage(i), b = page.getBounds();
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.index = i;
    div.innerHTML = `<span class="num">${t("page", { n: i + 1 })}</span><img alt=""><div class="layer"></div>`;
    viewer.append(div);
    const p = { page, w: b[2] - b[0], h: b[3] - b[1], el: div, layer: div.querySelector(".layer"), img: div.querySelector("img"), rendered: false };
    state.pages.push(p);
    size(p);
    observer.observe(div);
    p.layer.addEventListener("pointerdown", (e) => onLayerDown(e, i));
  }
  state.items.forEach(place);
}

function size(p) { p.el.style.width = p.w * state.zoom + "px"; p.el.style.height = p.h * state.zoom + "px"; }

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

function setZoom(z) {
  if (!state.doc) return;
  state.zoom = Math.min(3, Math.max(0.3, Math.round(z * 10) / 10));
  el("zoomVal").textContent = Math.round(state.zoom * 100) + " %";
  state.pages.forEach((p, i) => { size(p); p.rendered = false; });
  state.items.forEach(place);
  state.pages.forEach((p, i) => { const r = p.el.getBoundingClientRect(), v = viewer.getBoundingClientRect(); if (r.bottom > v.top - 600 && r.top < v.bottom + 600) paint(i); });
}
el("zoomIn").onclick = () => setZoom(state.zoom + 0.2);
el("zoomOut").onclick = () => setZoom(state.zoom - 0.2);

/* ---------- Éléments posés ---------- */

const pt = (i, e) => { const r = state.pages[i].layer.getBoundingClientRect(); return [(e.clientX - r.left) / state.zoom, (e.clientY - r.top) / state.zoom]; };
const hexToRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);

function onLayerDown(e, i) {
  if (e.target !== state.pages[i].layer) return; // clic sur un élément existant : géré par l'élément
  e.preventDefault(); // sinon le clic retire aussitôt le curseur de la zone de texte créée
  select(null);
  const [x, y] = pt(i, e);
  if (state.mode === "text") {
    const it = { id: state.nextId++, kind: "text", page: i, x, y: y - (+el("size").value || 14) * 0.6, size: +el("size").value || 14, color: el("color").value, text: "" };
    state.items.push(it);
    place(it);
    edit(it);
  } else {
    if (!state.sig) { openPad(); return; }
    const w = Math.min(180, state.pages[i].w * 0.4), h = w / state.sig.ratio;
    const it = { id: state.nextId++, kind: "sig", page: i, x: x - w / 2, y: y - h / 2, w, h, bytes: state.sig.bytes, url: state.sig.url };
    state.items.push(it);
    place(it);
    select(it);
    status(t("annot.placed"));
  }
}

function place(it) {
  let d = viewer.querySelector(`.item[data-id="${it.id}"]`);
  if (!d) {
    d = document.createElement("div");
    d.className = "item " + (it.kind === "text" ? "txt" : "sig");
    d.dataset.id = it.id;
    if (it.kind === "sig") d.innerHTML = `<img alt="">`;
    d.insertAdjacentHTML("beforeend", `<button type="button" class="rm" title="${t("annot.remove")}" aria-label="${t("annot.remove")}">×</button>${it.kind === "sig" ? '<span class="rs" aria-hidden="true"></span>' : ""}`);
    if (it.kind === "sig") d.querySelector("img").src = it.url;
    attach(d, it);
  }
  const p = state.pages[it.page];
  if (d.parentElement !== p.layer) p.layer.append(d);
  d.style.left = it.x * state.zoom + "px";
  d.style.top = it.y * state.zoom + "px";
  if (it.kind === "text") {
    d.style.fontSize = it.size * state.zoom + "px";
    d.style.color = it.color;
    const span = d.querySelector(".t") || d.insertBefore(Object.assign(document.createElement("span"), { className: "t" }), d.firstChild);
    if (!span.isContentEditable) span.textContent = it.text || "";
  } else {
    d.style.width = it.w * state.zoom + "px";
    d.style.height = it.h * state.zoom + "px";
  }
}

function attach(d, it) {
  d.querySelector(".rm").addEventListener("click", (e) => { e.stopPropagation(); remove(it); });
  let drag = null;
  d.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("rm") || d.querySelector(".t")?.isContentEditable) return;
    e.preventDefault();
    select(it);
    d.setPointerCapture(e.pointerId);
    drag = { sx: e.clientX, sy: e.clientY, x: it.x, y: it.y, w: it.w, h: it.h, resize: e.target.classList.contains("rs"), moved: false };
  });
  d.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / state.zoom, dy = (e.clientY - drag.sy) / state.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
    if (drag.resize) { it.w = Math.max(20, drag.w + dx); it.h = it.w * (drag.h / drag.w); }
    else { it.x = drag.x + dx; it.y = drag.y + dy; }
    place(it);
  });
  d.addEventListener("pointerup", () => {
    if (drag && !drag.moved && it.kind === "text") edit(it);
    drag = null;
  });
}

function edit(it) {
  const d = viewer.querySelector(`.item[data-id="${it.id}"]`);
  const span = d.querySelector(".t");
  span.setAttribute("contenteditable", "plaintext-only");
  if (!span.isContentEditable) span.setAttribute("contenteditable", "true");
  select(it);
  span.textContent = it.text;
  span.focus();
  const range = document.createRange(); range.selectNodeContents(span); range.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const onKey = (e) => { if (e.key === "Escape") span.blur(); };
  const finish = () => {
    delete it.commit;
    span.removeEventListener("blur", finish);
    span.removeEventListener("keydown", onKey);
    span.removeAttribute("contenteditable");
    it.text = span.innerText.replace(/\n+$/, "");
    if (!it.text.trim()) remove(it); else place(it);
  };
  span.addEventListener("blur", finish);
  span.addEventListener("keydown", onKey);
  it.commit = finish; // validé aussi au téléchargement, même si le champ n'a pas perdu le focus
}

function select(it) {
  viewer.querySelectorAll(".item.sel").forEach((n) => n.classList.remove("sel"));
  state.sel = it;
  if (!it) return;
  viewer.querySelector(`.item[data-id="${it.id}"]`)?.classList.add("sel");
  if (it.kind === "text") { el("size").value = it.size; el("color").value = it.color; }
}

function remove(it) {
  state.items = state.items.filter((x) => x !== it);
  viewer.querySelector(`.item[data-id="${it.id}"]`)?.remove();
  if (state.sel === it) state.sel = null;
}

el("size").addEventListener("input", () => { const it = state.sel; if (it?.kind === "text") { it.size = +el("size").value || it.size; place(it); } });
el("color").addEventListener("input", () => { const it = state.sel; if (it?.kind === "text") { it.color = el("color").value; place(it); } });

document.addEventListener("keydown", (e) => {
  if (!state.doc || !state.sel) return;
  if (e.target instanceof Element && (e.target.matches("input, textarea, select") || e.target.isContentEditable)) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(state.sel); }
});

/* ---------- Modes ---------- */

function setMode(m) {
  state.mode = m;
  app.querySelectorAll("[data-mode]").forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on); });
  el("hint").textContent = t(m === "sign" ? "annot.hintSign" : "annot.hintText");
  if (m === "sign" && state.doc && !state.sig) openPad();
}
app.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

/* ---------- Signature dessinée ---------- */

const pad = el("pad"), canvas = el("canvas"), ctx = canvas.getContext("2d");
let drawing = false, hasInk = false, last = null;
function openPad() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hasInk = false;
  pad.showModal();
}
const cpt = (e) => { const r = canvas.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height]; };
canvas.addEventListener("pointerdown", (e) => { drawing = true; last = cpt(e); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const p = cpt(e);
  ctx.strokeStyle = "#111"; ctx.lineWidth = 5; ctx.lineCap = ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke();
  last = p; hasInk = true;
});
canvas.addEventListener("pointerup", () => (drawing = false));
el("padClear").onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; };
el("padCancel").onclick = () => pad.close();
el("padOk").onclick = async () => {
  if (!hasInk) { pad.close(); return; }
  // Recadrage sur le tracé pour obtenir une image sans marges.
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const w = x1 - x0 + 12, h = y1 - y0 + 12;
  const c2 = document.createElement("canvas"); c2.width = w; c2.height = h;
  c2.getContext("2d").drawImage(canvas, x0 - 6, y0 - 6, w, h, 0, 0, w, h);
  const blob = await new Promise((r) => c2.toBlob(r, "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (state.sig?.url) URL.revokeObjectURL(state.sig.url);
  state.sig = { bytes, url: URL.createObjectURL(blob), ratio: w / h };
  pad.close();
  setMode("sign");
  status(t("annot.sigReady"));
};

/* ---------- Gravure et téléchargement ---------- */

el("download").onclick = async () => {
  if (!state.doc) return;
  state.items.filter((it) => it.commit).forEach((it) => it.commit());
  try {
    const { mupdf, doc } = await openPdf(state.bytes.slice());
    const st = stamper(mupdf, doc);
    for (const it of state.items) {
      if (it.kind === "text") {
        it.text.split("\n").forEach((line, k) => {
          // Ligne de base ≈ haut de la boîte + 0,93 × taille (Helvetica, interligne 1,2).
          st.text(it.page, { text: line, x: it.x, y: it.y + it.size * (0.93 + k * 1.2), size: it.size, color: hexToRgb(it.color) });
        });
      } else st.image(it.page, { bytes: it.bytes, x: it.x, y: it.y, w: it.w, h: it.h });
    }
    const name = suffixName(state.name, app.dataset.suffix || "edited");
    download(save(doc), name);
    status(t("annot.done", { n: state.items.length, name }), "ok");
  } catch (e) {
    console.error(e);
    status(t("err.process", { msg: e.message }), "err");
  }
};

el("close").onclick = () => {
  if (state.items.length && !confirm(t("confirm.close"))) return;
  Object.assign(state, { doc: null, items: [], pages: [] });
  viewer.innerHTML = "";
  delete app.dataset.state;
  status("");
};

window.addEventListener("beforeunload", (e) => { if (state.items.length) e.preventDefault(); });
const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
window.__pdfanonymAnnot = { state };
