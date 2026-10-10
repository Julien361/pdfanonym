// Outils « rapport » : supprimer les métadonnées (data-tool="metadata") ou aplatir (data-tool="flatten").
import { t, loadEngine, openPdf, setupDrop, alertStatus, download, suffixName } from "./common.js";
import { inspect, clean, flatten, save, INFO_KEYS } from "./engine.js";
import { createConverter } from "./grayscale.js";

const app = document.querySelector('.app[data-tool="metadata"], .app[data-tool="flatten"], .app[data-tool="grayscale"]');
const tool = app.dataset.tool;
const el = (name) => app.querySelector(`[data-el="${name}"]`);
const status = (msg, kind) => alertStatus(app, msg, kind);
let current = null; // { bytes, name }

function row(label, value, found) {
  const tr = document.createElement("tr");
  const th = document.createElement("th");
  th.textContent = label;
  const td = document.createElement("td");
  td.className = "val " + (found ? "found" : "none");
  td.textContent = value;
  tr.append(th, td);
  return tr;
}

const yesNo = (n) => (n ? t("rep.found", { n }) : t("rep.none"));

function formatDate(s) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || "");
  return m ? [m[1], m[2], m[3]].filter(Boolean).join("-") + (m[4] ? ` ${m[4]}:${m[5] || "00"}` : "") : s;
}

function renderReport(info) {
  const body = el("rows");
  body.innerHTML = "";
  if (tool === "metadata") {
    for (const k of INFO_KEYS) {
      const v = info.info[k];
      if (k === "Trapped") continue;
      body.append(row(t("meta." + k), v ? (k.endsWith("Date") ? formatDate(v) : v) : t("rep.empty"), !!v));
    }
    const extra = Object.keys(info.info).filter((k) => !INFO_KEYS.includes(k));
    for (const k of extra) body.append(row(k, info.info[k], true));
    body.append(row(t("rep.xmp"), info.xmp ? t("rep.present") : t("rep.none"), info.xmp));
    body.append(row(t("rep.comments"), yesNo(info.comments), info.comments > 0));
    body.append(row(t("rep.attachments"), yesNo(info.attachments), info.attachments > 0));
    body.append(row(t("rep.javascript"), info.javascript ? t("rep.present") : t("rep.none"), info.javascript));
    body.append(row(t("rep.private"), info.pieceInfo || info.pageMetadata ? t("rep.present") : t("rep.none"), info.pieceInfo || info.pageMetadata > 0));
  } else if (tool === "grayscale") {
    body.append(row(t("rep.pages"), String(info.pages), false));
    if (info.gray) {
      body.append(row(t("gray.images"), String(info.gray.images), false));
      const left = info.gray.shadings + info.gray.spot + info.gray.inline;
      body.append(row(t("gray.left"), left ? t("gray.leftSome", { n: left }) : t("rep.none"), left > 0));
    }
  } else {
    body.append(row(t("rep.widgets"), yesNo(info.widgets), info.widgets > 0));
    body.append(row(t("rep.annots"), yesNo(info.comments + info.otherAnnots), info.comments + info.otherAnnots > 0));
    body.append(row(t("rep.pages"), String(info.pages), false));
  }
  if (tool === "grayscale") return info.pages;
  const total = tool === "metadata"
    ? Object.keys(info.info).filter((k) => k !== "Trapped").length + info.xmp + info.comments + info.attachments + info.javascript + (info.pieceInfo || info.pageMetadata > 0)
    : info.widgets + info.comments + info.otherAnnots;
  return total;
}

async function onFile(file) {
  try {
    status(t("status.opening"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { doc } = await openPdf(bytes);
    current = { bytes, name: file.name };
    const total = renderReport(inspect(doc));
    el("filename").textContent = file.name;
    el("result").hidden = true;
    app.dataset.state = "open";
    el("run").disabled = false;
    if (tool === "metadata") {
      const info = inspect(doc).info;
      app.querySelectorAll("[data-field]").forEach((i) => (i.value = info[i.dataset.field] || ""));
    }
    status(total ? t(tool + ".foundSome", { n: total }) : t(tool + ".foundNone"), total ? "" : "ok");
  } catch (e) {
    console.error(e);
    status(t("err.open", { msg: e.message }), "err");
  }
}
setupDrop(app, onFile);

el("run").onclick = async () => {
  if (!current) return;
  try {
    const { mupdf, doc } = await openPdf(current.bytes);
    let out;
    if (tool === "metadata") {
      clean(doc, { comments: el("optComments").checked, attachments: el("optAttachments").checked, javascript: el("optJs").checked });
      out = save(doc, { scrub: true });
    } else if (tool === "grayscale") {
      const rep = createConverter(mupdf, doc).run();
      if (el("optMetaToo")?.checked) clean(doc);
      out = save(doc, { scrub: !!el("optMetaToo")?.checked });
      current.gray = rep;
    } else {
      flatten(doc, { forms: el("optForms").checked, annots: el("optAnnots").checked });
      const scrub = !!el("optMetaToo")?.checked;
      if (scrub) clean(doc);
      out = save(doc, { scrub });
    }
    // Vérification : on rouvre le fichier produit et on refait l'inventaire.
    const check = mupdf.Document.openDocument(out, "application/pdf").asPDF();
    renderReport({ ...inspect(check), gray: current.gray });
    if (tool === "grayscale") {
      const pm = check.loadPage(0).toPixmap(mupdf.Matrix.scale(0.6, 0.6), mupdf.ColorSpace.DeviceRGB, false, true);
      const img = el("preview");
      if (img) { img.src = URL.createObjectURL(new Blob([pm.asPNG()], { type: "image/png" })); img.hidden = false; }
      pm.destroy();
    }
    const name = suffixName(current.name, app.dataset.suffix || tool);
    download(out, name);
    el("result").hidden = false;
    el("resultText").textContent = t(tool + ".done", { name });
    status(t("status.downloaded", { name }), "ok");
  } catch (e) {
    console.error(e);
    status(t("err.process", { msg: e.message }), "err");
  }
};

// Modifier les propriétés (titre, auteur…) au lieu de tout supprimer.
el("saveEdits")?.addEventListener("click", async () => {
  if (!current) return;
  try {
    const { mupdf, doc } = await openPdf(current.bytes);
    const root = doc.getTrailer().get("Root");
    // Le bloc XMP garderait les anciennes valeurs, que certains lecteurs affichent en priorité : on le retire.
    if (!root.get("Metadata").isNull()) root.delete("Metadata");
    app.querySelectorAll("[data-field]").forEach((i) => doc.setMetaData("info:" + i.dataset.field, i.value.trim()));
    const info = doc.getTrailer().get("Info");
    if (!info.isNull()) app.querySelectorAll("[data-field]").forEach((i) => { if (!i.value.trim()) info.delete(i.dataset.field); });
    const out = save(doc, { scrub: false });
    renderReport(inspect(mupdf.Document.openDocument(out, "application/pdf").asPDF()));
    const name = suffixName(current.name, app.dataset.suffix || tool);
    download(out, name);
    el("result").hidden = false;
    el("resultText").textContent = t("metadata.edited", { name });
    status(t("status.downloaded", { name }), "ok");
  } catch (e) {
    console.error(e);
    status(t("err.process", { msg: e.message }), "err");
  }
});

el("close").onclick = () => { current = null; delete app.dataset.state; status(""); };

// Charge le moteur juste après l'affichage (sans gêner le rendu) : l'outil marche ensuite hors connexion.
const warm = () => loadEngine();
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
