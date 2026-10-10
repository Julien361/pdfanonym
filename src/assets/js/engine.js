// Opérations PDF communes aux outils. Indépendant du DOM : utilisable dans le navigateur et sous Node (tests).

export const INFO_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Trapped"];

function isPDFLike(o) {
  return o && typeof o.isNull === "function" && !o.isNull();
}

// Inventaire de ce qu'un PDF contient en plus du contenu visible.
export function inspect(doc) {
  const trailer = doc.getTrailer();
  const info = trailer.get("Info");
  const root = trailer.get("Root");
  const res = { info: {}, xmp: false, pages: doc.countPages(), comments: 0, links: 0, widgets: 0, otherAnnots: 0,
    attachments: 0, javascript: false, pageMetadata: 0, pieceInfo: false, outlines: false };
  if (isPDFLike(info)) {
    info.forEach((v, k) => {
      const s = v.isString() ? v.asString() : v.isName() ? v.asName() : String(v);
      if (s !== "") res.info[k] = s;
    });
  }
  res.xmp = isPDFLike(root.get("Metadata"));
  res.pieceInfo = isPDFLike(root.get("PieceInfo"));
  res.outlines = isPDFLike(root.get("Outlines"));
  const names = root.get("Names");
  if (isPDFLike(names)) {
    res.javascript = isPDFLike(names.get("JavaScript"));
    res.attachments = Object.keys(safe(() => doc.getEmbeddedFiles(), {})).length;
  }
  if (isPDFLike(root.get("OpenAction"))) {
    const oa = root.get("OpenAction");
    if (oa.isDictionary() && isPDFLike(oa.get("JS"))) res.javascript = true;
  }
  for (let i = 0; i < res.pages; i++) {
    const page = doc.loadPage(i);
    const obj = page.getObject();
    if (isPDFLike(obj.get("Metadata")) || isPDFLike(obj.get("PieceInfo"))) res.pageMetadata++;
    for (const a of page.getAnnotations()) {
      const t = a.getType();
      if (t === "Widget") res.widgets++;
      else if (["Text", "FreeText", "Highlight", "Underline", "StrikeOut", "Squiggly", "Ink", "Popup", "Caret", "FileAttachment", "Sound"].includes(t)) res.comments++;
      else res.otherAnnots++;
    }
    res.widgets += page.getWidgets().length;
    res.links += page.getLinks().length;
  }
  return res;
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

// Supprime les métadonnées et les éléments cachés choisis. Retourne la liste de ce qui a été retiré.
export function clean(doc, opts = {}) {
  const o = { info: true, xmp: true, comments: true, attachments: true, javascript: true, pagePrivate: true, outlines: false, ...opts };
  const done = [];
  const trailer = doc.getTrailer();
  const root = trailer.get("Root");

  if (o.info && isPDFLike(trailer.get("Info"))) {
    trailer.delete("Info");
    done.push("info");
  }
  if (o.xmp && isPDFLike(root.get("Metadata"))) {
    root.delete("Metadata");
    done.push("xmp");
  }
  if (o.pagePrivate) {
    for (const k of ["PieceInfo", "SpiderInfo"]) if (isPDFLike(root.get(k))) { root.delete(k); done.push(k); }
  }
  const names = root.get("Names");
  if (isPDFLike(names)) {
    if (o.javascript && isPDFLike(names.get("JavaScript"))) { names.delete("JavaScript"); done.push("javascript"); }
    if (o.attachments && isPDFLike(names.get("EmbeddedFiles"))) { names.delete("EmbeddedFiles"); done.push("attachments"); }
  }
  if (o.javascript) {
    const oa = root.get("OpenAction");
    if (isPDFLike(oa) && oa.isDictionary() && isPDFLike(oa.get("JS"))) { root.delete("OpenAction"); done.push("openaction"); }
    if (isPDFLike(root.get("AA"))) { root.delete("AA"); done.push("aa"); }
  }
  if (o.outlines && isPDFLike(root.get("Outlines"))) { root.delete("Outlines"); done.push("outlines"); }

  let comments = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const obj = page.getObject();
    if (o.pagePrivate) for (const k of ["Metadata", "PieceInfo"]) if (isPDFLike(obj.get(k))) obj.delete(k);
    if (o.javascript && isPDFLike(obj.get("AA"))) obj.delete("AA");
    for (const a of page.getAnnotations()) {
      const t = a.getType();
      const isComment = !["Link", "Widget", "Redact"].includes(t);
      if ((o.comments && isComment) || (o.attachments && t === "FileAttachment")) { page.deleteAnnotation(a); comments++; }
    }
  }
  if (comments) done.push("comments:" + comments);
  return done;
}

// Aplatit formulaires et annotations dans le contenu des pages.
export function flatten(doc, { forms = true, annots = true } = {}) {
  doc.bake(annots, forms);
  if (forms) {
    const root = doc.getTrailer().get("Root");
    if (isPDFLike(root.get("AcroForm"))) root.delete("AcroForm");
  }
}

// Options d'enregistrement : « clean » réécrit les flux, « garbage » purge les objets orphelins (dont les anciennes métadonnées).
export function save(doc, { scrub = false } = {}) {
  const opts = scrub ? "garbage=4,compress,clean,regenerate-id" : "garbage=compact,compress";
  // Copie indispensable : asUint8Array() est une vue sur la mémoire du moteur, invalidée dès qu'elle grandit.
  return doc.saveToBuffer(opts).asUint8Array().slice();
}

// Construit un nouveau PDF à partir d'une liste de pages : [{ doc: index du fichier source, page: index, rot: 0|90|180|270 }].
// graftPage ne copie pas les annotations : on les recopie (liens web, commentaires, champs), sauf les liens internes
// vers d'autres pages, dont la cible n'existe plus forcément dans le nouveau document.
export function assemble(mupdf, docs, items) {
  const out = new mupdf.PDFDocument();
  const maps = new Map(); // une table de greffe par fichier source : ressources partagées copiées une seule fois
  const mapFor = (d) => maps.get(d) || maps.set(d, out.newGraftMap()).get(d);
  items.forEach((it, k) => {
    const map = mapFor(it.doc);
    map.graftPage(-1, docs[it.doc], it.page);
    const dst = out.findPage(k);
    const src = docs[it.doc].findPage(it.page);
    const annots = src.get("Annots");
    if (annots.isArray()) {
      const keep = out.newArray();
      annots.forEach((a) => {
        const ar = a.resolve();
        if (!ar.isDictionary()) return;
        if (ar.get("Subtype").isName() && ar.get("Subtype").asName() === "Link") {
          const act = ar.get("A");
          const isUri = act.isDictionary() && act.get("S").isName() && act.get("S").asName() === "URI";
          if (!isUri) return;
        }
        if (!ar.get("Popup").isNull() || !ar.get("Parent").isNull() || !ar.get("IRT").isNull()) {
          // Références vers d'autres annotations : on garde l'annotation mais sans ces liens croisés.
          const copy = map.graftObject(ar);
          for (const key of ["Popup", "Parent", "IRT"]) if (!copy.get(key).isNull()) copy.delete(key);
          copy.put("P", dst);
          keep.push(out.addObject(copy));
          return;
        }
        const g = map.graftObject(a);
        g.resolve().put("P", dst);
        keep.push(g);
      });
      if (keep.length) dst.put("Annots", keep);
    }
    const rot = ((it.rot || 0) % 360 + 360) % 360;
    if (rot) {
      const cur = dst.get("Rotate");
      dst.put("Rotate", ((cur.isNull() ? 0 : cur.asNumber()) + rot) % 360);
    }
  });
  return out;
}
