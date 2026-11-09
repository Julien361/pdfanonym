// Word → PDF : le .docx est converti sur l'appareil (docx-preview + MuPDF), aperçu des pages, puis téléchargement.
import { t, loadEngine, setupDrop, alertStatus, download } from "./common.js";
import { docxToParts, partsToPdf } from "./docx.js";

const app = document.querySelector('.app[data-tool="word_to_pdf"]');
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const status = (msg, kind) => alertStatus(app, msg, kind);
const isWordLike = (f) => f && /\.(docx|docm|dotx|doc|odt|rtf|pages)$/i.test(f.name);
let result = null; // { bytes, name }
let urls = [];

function reset() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  result = null;
  el("grid").innerHTML = "";
  el("run").disabled = true;
}

async function convert(file) {
  reset();
  app.dataset.state = "open";
  el("filename").textContent = file.name;
  el("count").textContent = "";
  if (!/\.(docx|docm|dotx)$/i.test(file.name)) { status(t("word.old", { name: file.name }), "err"); return; }
  status(t("word.working"));
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const [mupdf, parts] = await Promise.all([loadEngine(), docxToParts(bytes)]);
    const pdf = partsToPdf(mupdf, parts);
    result = { bytes: pdf, name: file.name.replace(/\.[^.]+$/, "") + ".pdf" };
    const doc = mupdf.Document.openDocument(pdf, "application/pdf");
    const n = doc.countPages();
    el("count").textContent = t("word.count", { n });
    for (let i = 0; i < Math.min(n, 40); i++) {
      const page = doc.loadPage(i);
      const [, , w] = page.getBounds();
      const pix = page.toPixmap(mupdf.Matrix.scale(300 / w, 300 / w), mupdf.ColorSpace.DeviceRGB, false, true);
      const url = URL.createObjectURL(new Blob([pix.asPNG()], { type: "image/png" }));
      urls.push(url);
      const li = document.createElement("li");
      li.className = "thumb";
      li.innerHTML = `<div class="frame"><img alt=""></div><div class="meta"><span class="no">${i + 1}</span></div>`;
      li.querySelector("img").src = url;
      el("grid").append(li);
    }
    el("run").disabled = false;
    status(t("word.ready", { n }), "ok");
  } catch (e) {
    console.error(e);
    status(t("word.bad", { name: file.name }), "err");
  }
}

setupDrop(app, convert, { accept: isWordLike });
el("close").onclick = () => { reset(); delete app.dataset.state; status(""); };
el("run").onclick = () => {
  if (!result) return;
  download(result.bytes, result.name);
  status(t("word.done", { name: result.name }), "ok");
};

const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
