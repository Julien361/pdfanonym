// Images → PDF : vignettes réordonnables, taille de page et marges, conversion locale.
import { t, loadEngine, setupDrop, alertStatus, download, isImage } from "./common.js";
import { imagesToPdf } from "./edit.js";
import { save } from "./engine.js";
import Sortable from "./sortable.esm.js";

const app = document.querySelector('.app[data-tool="jpg_to_pdf"]');
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const grid = el("grid");
const status = (msg, kind) => alertStatus(app, msg, kind);
let items = []; // { id, name, bytes, url }
let nextId = 1;

// JPEG et PNG sont lus directement ; les autres formats passent par le navigateur (canvas → PNG).
async function normalize(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/jpe?g|png/i.test(file.type) || /\.(jpe?g|png)$/i.test(file.name)) return bytes;
  const bmp = await createImageBitmap(new Blob([bytes], { type: file.type }));
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

async function add(file) {
  try {
    const bytes = await normalize(file);
    items.push({ id: nextId++, name: file.name, bytes, url: URL.createObjectURL(new Blob([bytes])) });
    app.dataset.state = "open";
    render();
    status(t("images.ready", { n: items.length }));
  } catch (e) {
    console.error(e);
    status(t("images.bad", { name: file.name }), "err");
  }
}
setupDrop(app, add, { multiple: true, accept: isImage });
el("add").onclick = () => el("addInput").click();
el("addInput").addEventListener("change", async () => { for (const f of [...el("addInput").files].filter(isImage)) await add(f); el("addInput").value = ""; });
el("close").onclick = () => { items.forEach((i) => URL.revokeObjectURL(i.url)); items = []; delete app.dataset.state; status(""); };

function render() {
  grid.innerHTML = "";
  items.forEach((it, idx) => {
    const li = document.createElement("li");
    li.className = "thumb";
    li.dataset.id = it.id;
    li.innerHTML = `<div class="frame"><img alt=""></div><div class="meta"><span class="no">${idx + 1}</span><span class="src"></span></div>
      <div class="acts"><button type="button" data-a="del" title="${t("images.remove")}" aria-label="${t("images.remove")}">✕</button></div>`;
    li.querySelector("img").src = it.url;
    li.querySelector(".src").textContent = it.name.length > 18 ? it.name.slice(0, 16) + "…" : it.name;
    grid.append(li);
  });
  el("count").textContent = t("images.count", { n: items.length });
  el("filename").textContent = items.length === 1 ? items[0].name : t("images.count", { n: items.length });
  el("run").disabled = !items.length;
}

grid.addEventListener("click", (e) => {
  if (e.target.closest("button")?.dataset.a !== "del") return;
  const id = +e.target.closest(".thumb").dataset.id;
  const it = items.find((x) => x.id === id);
  URL.revokeObjectURL(it.url);
  items = items.filter((x) => x.id !== id);
  if (!items.length) delete app.dataset.state;
  render();
});

Sortable.create(grid, {
  animation: 150, delay: 120, delayOnTouchOnly: true, filter: "button", preventOnFilter: false,
  onEnd: (ev) => { const [m] = items.splice(ev.oldIndex, 1); items.splice(ev.newIndex, 0, m); render(); },
});

el("run").onclick = async () => {
  if (!items.length) return;
  try {
    status(t("status.working"));
    const mupdf = await loadEngine();
    const doc = imagesToPdf(mupdf, items, { size: el("size").value, margin: +el("margin").value });
    const name = (items.length === 1 ? items[0].name.replace(/\.[^.]+$/, "") : "images") + ".pdf";
    download(save(doc), name);
    status(t("images.done", { n: items.length, name }), "ok");
  } catch (e) {
    console.error(e);
    status(t("err.process", { msg: e.message }), "err");
  }
};

const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
