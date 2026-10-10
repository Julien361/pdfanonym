// Rapport de caviardage (version pro) : PDF listant ce qui a été supprimé, par page et par catégorie,
// SANS reproduire les valeurs supprimées. L'empreinte SHA-256 identifie le fichier remis.
import { stamper } from "./edit.js";

async function sha256(bytes) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildReport(mupdf, { file, bytes, pages, log, t }) {
  const doc = new mupdf.PDFDocument();
  const W = 595.28, H = 841.89, M = 56;
  const newPage = () => { doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, doc.addObject({}), "")); return doc.countPages() - 1; };
  const st = stamper(mupdf, doc);
  let p = newPage(), y = M + 10;
  const line = (text, { size = 10.5, bold = false, gap = 1.55, color = [0.1, 0.1, 0.1] } = {}) => {
    if (y > H - M) { p = newPage(); y = M; }
    st.text(p, { text, x: M, y, size, bold, color });
    y += size * gap;
  };

  const hash = await sha256(bytes);
  const total = log.reduce((a, l) => a + l.n, 0);
  line(t("report.title"), { size: 20, bold: true, gap: 2 });
  line(`${t("report.file")} : ${file}`);
  line(`${t("report.date")} : ${new Date().toLocaleString(document.documentElement.lang || "en")}`);
  line(`${t("report.pages")} : ${pages}`);
  line(`${t("report.total")} : ${total}`);
  line(`SHA-256 : ${hash.slice(0, 32)}`);
  line(`          ${hash.slice(32)}`, { gap: 2.4 });

  // Synthèse par catégorie
  line(t("report.byCat"), { size: 13, bold: true, gap: 1.9 });
  const byCat = {};
  for (const l of log) byCat[l.cat] = (byCat[l.cat] || 0) + l.n;
  for (const [cat, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) line(`•  ${t("cat." + cat)} : ${n}`);
  y += 10;

  // Détail par page
  line(t("report.byPage"), { size: 13, bold: true, gap: 1.9 });
  const byPage = {};
  for (const l of log) ((byPage[l.page] ||= {})[l.cat] = (byPage[l.page][l.cat] || 0) + l.n);
  for (const pg of Object.keys(byPage).map(Number).sort((a, b) => a - b)) {
    line(`${t("page", { n: pg })} : ` + Object.entries(byPage[pg]).map(([c, n]) => `${t("cat." + c)} (${n})`).join(", "));
  }
  y += 14;
  line(t("report.note"), { size: 9, color: [0.4, 0.4, 0.4] });
  line(t("report.by"), { size: 9, color: [0.4, 0.4, 0.4] });
  doc.setMetaData("info:Title", t("report.title") + " · " + file);
  doc.setMetaData("info:Producer", "pdfanonym.com");
  return doc.saveToBuffer("garbage=compact,compress").asUint8Array().slice();
}
