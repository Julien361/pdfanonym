// Socle commun : textes traduits, ouverture des PDF, glisser-déposer, téléchargement, menu mobile.

const strings = (() => {
  try { return JSON.parse(document.getElementById("i18n")?.textContent || "{}"); } catch { return {}; }
})();

// t("key", { n: 3 }) remplace {n} ; une clé absente renvoie la clé (repérable en test).
export function t(key, vars = {}) {
  let s = strings[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll("{" + k + "}", v);
  return s;
}

let mupdfPromise = null;
export function loadEngine() {
  if (!mupdfPromise) mupdfPromise = import("../mupdf/mupdf.js");
  return mupdfPromise;
}

export async function openPdf(bytes) {
  const mupdf = await loadEngine();
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  if (doc.needsPassword()) {
    const pw = prompt(t("pw.prompt"));
    if (!pw || !doc.authenticatePassword(pw)) throw new Error(t("pw.wrong"));
  }
  const pdf = doc.asPDF();
  if (!pdf) throw new Error(t("err.notpdf"));
  return { mupdf, doc: pdf };
}

const isPdf = (f) => f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name));
export const isImage = (f) => f && (/^image\/(jpeg|png|gif|bmp|tiff|webp)$/.test(f.type) || /\.(jpe?g|png|gif|bmp|tiff?|webp)$/i.test(f.name));

// Branche le choix de fichier, le glisser-déposer (sur toute la page) et le clic sur la zone.
export function setupDrop(app, onFile, { multiple = false, accept = isPdf } = {}) {
  const input = app.querySelector('input[type="file"]');
  const drop = app.querySelector(".drop");
  drop.addEventListener("click", (e) => { if (e.target !== input) input.click(); });
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  if (multiple) input.multiple = true;
  const feed = async (files) => { for (const f of multiple ? files : files.slice(0, 1)) await onFile(f); };
  input.addEventListener("change", () => { const fs = [...input.files].filter(accept); input.value = ""; if (fs.length) feed(fs); });
  let depth = 0;
  document.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; app.classList.add("dragover"); });
  document.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; app.classList.remove("dragover"); } });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; app.classList.remove("dragover");
    const fs = [...(e.dataTransfer?.files || [])].filter(accept);
    if (fs.length) { app.scrollIntoView({ behavior: "smooth", block: "start" }); feed(fs); }
    else if (e.dataTransfer?.files?.length) alertStatus(app, t("err.dropPdf"), "err");
  });
}

export function alertStatus(app, msg, kind = "") {
  const el = app.querySelector(app.dataset.state === "open" ? ".work .status" : ".status[data-pre]");
  if (!el) return;
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

export function suffixName(name, suffix) {
  return (name || "document.pdf").replace(/\.pdf$/i, "") + "-" + suffix + ".pdf";
}

export function download(bytes, name, type = "application/pdf") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}

// Menu mobile
const menuBtn = document.querySelector(".menu-btn");
menuBtn?.addEventListener("click", () => {
  const nav = document.querySelector(".nav");
  const open = nav.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", open);
});

// Menus déroulants (tous les outils, langue) : fermeture au clic extérieur et sur Échap.
document.addEventListener("click", (e) => {
  document.querySelectorAll("details.mega[open], details.lang[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll("details.mega[open], details.lang[open]").forEach((d) => (d.open = false));
});
