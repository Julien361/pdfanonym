// PDF → Word : le PDF est lu et le .docx écrit sur l'appareil (MuPDF + pdf2docx.js), puis téléchargé.
import { t, openPdf, setupDrop, alertStatus, download, loadEngine } from "./common.js";
import { pdfToDocx } from "./pdf2docx.js";

const app = document.querySelector('.app[data-tool="pdf_to_word"]');
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const status = (msg, kind) => alertStatus(app, msg, kind);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let result = null; // { bytes, name }
let current = null; // dernier fichier déposé : changer de mode relance la conversion

async function convert(file) {
  current = file;
  result = null;
  el("run").disabled = true;
  app.dataset.state = "open";
  el("filename").textContent = file.name;
  status(t("pdf2word.working", { i: 0, n: "…" }));
  try {
    const { mupdf, doc } = await openPdf(new Uint8Array(await file.arrayBuffer()));
    const r = await pdfToDocx(mupdf, doc, {
      mode: el("mode").value,
      onPage: (i, n) => { status(t("pdf2word.working", { i, n })); return new Promise((ok) => setTimeout(ok, 0)); },
    });
    result = { bytes: r.bytes, name: file.name.replace(/\.pdf$/i, "") + ".docx" };
    el("run").disabled = false;
    // Sans texte (scan), le document Word ne contiendra que les images des pages : on le dit clairement.
    status(r.textChars ? t("pdf2word.ready", { n: r.pages }) : t("pdf2word.scan", { n: r.pages }), r.textChars ? "ok" : "");
  } catch (e) {
    console.error(e);
    status(t("err.process", { msg: e.message }), "err");
  }
}

setupDrop(app, convert);
el("mode").addEventListener("change", () => { if (current) convert(current); });
el("close").onclick = () => { result = null; current = null; delete app.dataset.state; status(""); };
el("run").onclick = () => {
  if (!result) return;
  download(result.bytes, result.name, DOCX);
  status(t("pdf2word.done", { name: result.name }), "ok");
};

const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
