// Traitement par lots (pro) : même anonymisation appliquée à plusieurs PDF, résultat en ZIP + rapport CSV.
import { t, loadEngine, setupDrop, alertStatus, download } from "./common.js";
import { clean, save, flatten } from "./engine.js";
import { detectPII, detectPIIPro } from "./pii.js";
import { zip } from "./edit.js";
import { status as licenseStatus } from "./license.js";

const app = document.querySelector('.app[data-tool="batch"]');
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const status = (msg, kind) => alertStatus(app, msg, kind);
let files = []; // { name, bytes, state, n }

const TERMS_KEY = "pdfanonym.terms";
try { el("terms").value = localStorage.getItem(TERMS_KEY) || ""; } catch { /* stockage indisponible */ }
el("terms").addEventListener("input", () => { try { localStorage.setItem(TERMS_KEY, el("terms").value); } catch { /* idem */ } });

function render() {
  const ol = el("list");
  ol.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    li.textContent = f.name;
    const s = document.createElement("span");
    s.className = "st " + (f.state || "");
    s.textContent = f.state === "done" ? t("batch.doneOne", { n: f.n }) : f.state === "err" ? t("batch.errOne") : f.state === "run" ? "…" : "";
    li.append(" ", s);
    ol.append(li);
  }
  el("filename").textContent = t("images.count", { n: files.length }).replace(/image\(s\)|images?/i, "PDF");
}

const add = async (file) => { files.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); app.dataset.state = "open"; render(); status(t("batch.ready", { n: files.length })); };
setupDrop(app, add, { multiple: true });
el("add").onclick = () => el("addInput").click();
el("addInput").addEventListener("change", async () => { for (const f of [...el("addInput").files]) await add(f); el("addInput").value = ""; });
el("close").onclick = () => { files = []; delete app.dataset.state; status(""); };

const quadToRect = (q) => [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])];
const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;

el("run").onclick = async () => {
  if (!files.length) return;
  if (!(await licenseStatus()).active) { location.href = app.dataset.pricing; return; }
  const cats = new Set([...app.querySelectorAll("[data-cat]:checked")].map((c) => c.dataset.cat));
  const terms = el("terms").value.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 1);
  const black = el("optBlack").checked, meta = el("optMeta").checked;
  const mupdf = await loadEngine();
  const P = mupdf.PDFPage;
  const out = [], rows = [["file", "page", "category", "count"]];
  el("run").disabled = true;
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    f.state = "run"; render();
    status(t("batch.progress", { i: k + 1, n: files.length }));
    await new Promise((r) => setTimeout(r, 20));
    try {
      const doc = mupdf.Document.openDocument(f.bytes, "application/pdf").asPDF();
      if (!doc) throw new Error("pdf");
      let hadForms = false;
      for (let i = 0; i < doc.countPages() && !hadForms; i++) hadForms = doc.loadPage(i).getWidgets().length > 0;
      if (hadForms) flatten(doc, { forms: true, annots: false });
      let total = 0;
      for (let i = 0; i < doc.countPages(); i++) {
        const page = doc.loadPage(i);
        const text = page.toStructuredText("preserve-whitespace").asText();
        const hits = [...detectPII(text), ...detectPIIPro(text)].filter((h) => cats.has(h.type)).map((h) => ({ cat: h.type, value: h.value }));
        for (const term of terms) hits.push({ cat: "list", value: term, fuzzy: true });
        const perCat = {};
        const seen = new Set();
        for (const h of hits) {
          if (seen.has(h.value)) continue;
          seen.add(h.value);
          for (const hit of page.search(h.value, h.fuzzy ? "ignore-case,ignore-diacritics" : undefined)) {
            for (const q of hit) page.createAnnotation("Redact").setRect(quadToRect(q));
            perCat[h.cat] = (perCat[h.cat] || 0) + 1;
          }
        }
        const n = Object.values(perCat).reduce((a, b) => a + b, 0);
        if (n) page.applyRedactions(black, P.REDACT_IMAGE_NONE, P.REDACT_LINE_ART_NONE, P.REDACT_TEXT_REMOVE);
        for (const [c, v] of Object.entries(perCat)) rows.push([f.name, i + 1, t("cat." + c), v]);
        total += n;
      }
      if (meta) clean(doc);
      out.push({ name: f.name.replace(/\.pdf$/i, "") + "-" + (app.dataset.suffix || "anonymized") + ".pdf", bytes: save(doc, { scrub: meta }) });
      f.state = "done"; f.n = total;
    } catch (e) {
      console.error(e);
      f.state = "err";
    }
    render();
  }
  const csv = "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
  out.push({ name: t("report.suffix") + ".csv", bytes: new TextEncoder().encode(csv) });
  download(zip(out), "pdfanonym-" + new Date().toISOString().slice(0, 10) + ".zip", "application/zip");
  const ok = files.filter((f) => f.state === "done").length;
  status(t("batch.done", { n: ok, total: files.length }), ok === files.length ? "ok" : "err");
  el("run").disabled = false;
};

const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
