// Outils « à réglages » : compresser, protéger, déverrouiller, filigrane, numérotation, PDF → images.
import { t, loadEngine, setupDrop, alertStatus, download, suffixName } from "./common.js";
import { save, clean } from "./engine.js";
import { watermark, pageNumbers, protectOptions, compress, pageToImage, zip } from "./edit.js";

const app = document.querySelector(".app[data-tool]");
const tool = app.dataset.tool;
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const status = (msg, kind) => alertStatus(app, msg, kind);
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
let cur = null; // { bytes, name, pages, needsPassword }

async function openDoc(bytes, password) {
  const mupdf = await loadEngine();
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  if (doc.needsPassword()) {
    if (!password || !doc.authenticatePassword(password)) { const e = new Error(t("pw.wrong")); e.code = "pw"; throw e; }
  }
  return { mupdf, doc: doc.asPDF() };
}

/* ---------- Ouverture ---------- */

setupDrop(app, async (file) => {
  try {
    status(t("status.opening"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mupdf = await loadEngine();
    const probe = mupdf.Document.openDocument(bytes, "application/pdf");
    const needsPassword = probe.needsPassword();
    if (needsPassword && tool !== "unlock") {
      const pw = prompt(t("pw.prompt"));
      if (!pw || !probe.authenticatePassword(pw)) throw new Error(t("pw.wrong"));
      cur = { bytes, name: file.name, password: pw };
    } else cur = { bytes, name: file.name, password: null };
    cur.needsPassword = needsPassword;
    cur.pages = needsPassword && tool === "unlock" ? "?" : probe.countPages();
    app.dataset.state = "open";
    el("filename").textContent = file.name;
    el("info").textContent = (cur.pages === "?" ? "" : t("pages.total", { total: cur.pages }) + " · ") + fmtSize(bytes.length);
    el("result").hidden = true;
    el("run").disabled = false;
    if (tool === "unlock") {
      el("pwField").hidden = !needsPassword;
      status(needsPassword ? t("unlock.needPw") : t("unlock.noPw"), needsPassword ? "" : "ok");
    } else status(t(tool + ".ready", { n: cur.pages }));
    preview();
  } catch (e) {
    console.error(e);
    status(t("err.open", { msg: e.message }), "err");
  }
});

el("close").onclick = () => { cur = null; delete app.dataset.state; el("pvBox").hidden = true; status(""); };

/* ---------- Réglages et aperçu ---------- */

const rgb = (s) => s.split(",").map(Number);
function settings() {
  switch (tool) {
    case "watermark": return { text: el("wmText").value.trim(), opacity: +el("wmOpacity").value / 100, color: rgb(el("wmColor").value), angle: +el("wmAngle").value };
    case "page_numbers": return { position: el("pnPos").value, format: el("pnFmt").value, start: +el("pnStart").value || 1, size: +el("pnSize").value || 11, skipFirst: el("pnSkip").checked };
    case "compress": return { level: app.querySelector('input[name="level"]:checked').value };
    case "pdf_to_jpg": return { format: el("imgFmt").value, dpi: +el("imgDpi").value };
    default: return {};
  }
}

function apply(mupdf, doc, s) {
  if (tool === "watermark") watermark(mupdf, doc, s);
  else if (tool === "page_numbers") pageNumbers(mupdf, doc, s);
}

let pvTimer = 0;
async function preview() {
  if (!cur || !["watermark", "page_numbers"].includes(tool)) return;
  clearTimeout(pvTimer);
  pvTimer = setTimeout(async () => {
    try {
      const { mupdf, doc } = await openDoc(cur.bytes, cur.password);
      const s = settings();
      if (tool === "watermark") { if (!s.text) return; watermark(mupdf, doc, { ...s, pages: [0] }); }
      else pageNumbers(mupdf, doc, s);
      const pm = doc.loadPage(s.skipFirst && doc.countPages() > 1 ? 1 : 0).toPixmap(mupdf.Matrix.scale(0.6, 0.6), mupdf.ColorSpace.DeviceRGB, false, true);
      const img = el("preview");
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(new Blob([pm.asPNG().slice()], { type: "image/png" }));
      pm.destroy();
      el("pvBox").hidden = false;
    } catch (e) { console.error(e); }
  }, 250);
}
app.querySelectorAll("input, select").forEach((i) => i.addEventListener("input", preview));

el("showPw")?.addEventListener("change", (e) => { el("pw1").type = el("pw2").type = e.target.checked ? "text" : "password"; });

/* ---------- Traitement ---------- */

// Erreur de saisie : message affiché tel quel, sans « Une erreur est survenue ».
const userError = (msg) => Object.assign(new Error(msg), { user: true });
const wait = () => new Promise((r) => setTimeout(r, 30)); // laisse le navigateur afficher le statut

el("run").onclick = async () => {
  if (!cur) return;
  el("run").disabled = true;
  try {
    status(t("status.working"));
    await wait();
    const s = settings();
    const scrub = !!el("optMetaToo")?.checked;

    if (tool === "pdf_to_jpg") {
      const { mupdf, doc } = await openDoc(cur.bytes, cur.password);
      const n = doc.countPages(), base = cur.name.replace(/\.pdf$/i, "");
      const ext = s.format === "png" ? "png" : "jpg";
      const files = [];
      for (let i = 0; i < n; i++) {
        files.push({ name: `${base}-${String(i + 1).padStart(String(n).length, "0")}.${ext}`, bytes: pageToImage(mupdf, doc, i, s) });
        if (i % 5 === 4) { status(t("status.progress", { i: i + 1, n })); await wait(); }
      }
      if (files.length === 1) download(files[0].bytes, files[0].name, ext === "png" ? "image/png" : "image/jpeg");
      else download(zip(files), base + "-" + ext + ".zip", "application/zip");
      done(t("pdf_to_jpg.done", { n }));
      return;
    }

    if (tool === "protect") {
      const p1 = el("pw1").value, p2 = el("pw2").value;
      if (!p1) throw userError(t("protect.empty"));
      if (p1 !== p2) throw userError(t("protect.mismatch"));
      if (p1.includes(",")) throw userError(t("protect.comma"));
      const { doc } = await openDoc(cur.bytes, cur.password);
      if (scrub) clean(doc);
      const out = doc.saveToBuffer(protectOptions({ userPassword: p1, allowPrint: el("allowPrint").checked, allowCopy: el("allowCopy").checked, allowEdit: el("allowEdit").checked })).asUint8Array().slice();
      finish(out, t("protect.done"));
      return;
    }

    if (tool === "unlock") {
      if (!el("rightsOk").checked) throw userError(t("unlock.rights"));
      const { doc } = await openDoc(cur.bytes, cur.needsPassword ? el("pw1").value : null);
      if (scrub) clean(doc);
      finish(doc.saveToBuffer("encrypt=none,garbage=compact,compress").asUint8Array().slice(), t("unlock.done"));
      return;
    }

    const { mupdf, doc } = await openDoc(cur.bytes, cur.password);
    let msg = "";
    if (tool === "compress") {
      const rep = compress(mupdf, doc, s.level);
      if (scrub) clean(doc);
      const out = doc.saveToBuffer("garbage=4,compress,compress-fonts,clean" + (scrub ? ",regenerate-id" : "")).asUint8Array().slice();
      if (out.length >= cur.bytes.length) { status(t("compress.noGain"), "ok"); el("run").disabled = false; return; }
      const pct = Math.round((1 - out.length / cur.bytes.length) * 100);
      finish(out, t("compress.done", { before: fmtSize(cur.bytes.length), after: fmtSize(out.length), pct, n: rep.images }));
      return;
    }
    if (tool === "watermark" && !s.text) throw userError(t("watermark.empty"));
    apply(mupdf, doc, s);
    if (scrub) clean(doc);
    finish(save(doc, { scrub }), t(tool + ".done"));
  } catch (e) {
    console.error(e);
    status(e.code === "pw" ? t("unlock.wrong") : e.user ? e.message : t("err.process", { msg: e.message }), "err");
    el("run").disabled = false;
  }
};

function finish(bytes, msg) {
  const name = suffixName(cur.name, app.dataset.suffix || tool);
  download(bytes, name);
  done(msg + " " + t("status.downloaded", { name }));
}
function done(msg) {
  el("result").hidden = false;
  el("resultText").textContent = msg;
  status(msg, "ok");
  el("run").disabled = false;
}

const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
window.__pdfanonymProcess = { get cur() { return cur; } };
