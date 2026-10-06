/* ==========================================================
   Lecture d'un fichier Excel (.xlsx) dans le navigateur.

   const { sheetName, rows, dateCols } = await readXlsx(file);
   rows : tableau de lignes, chaque cellule = texte, nombre, booléen ou null
   dateCols : colonnes contenant des dates (valeurs = n° de série Excel)
   ========================================================== */
import { unzip } from "./zip.js";

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export async function readXlsx(file) {
  const files = await unzip(await file.arrayBuffer());
  const dec = new TextDecoder();
  const xml = (name) => (files.has(name) ? new DOMParser().parseFromString(dec.decode(files.get(name)), "application/xml") : null);
  const all = (doc, tag) => (doc ? [...doc.getElementsByTagNameNS("*", tag)] : []);
  const text = (node) => all(node, "t").map((t) => t.textContent).join("");

  // 1re feuille du classeur
  const wb = xml("xl/workbook.xml");
  if (!wb) throw new Error("ce fichier n'est pas un classeur Excel (.xlsx)");
  const sheet = all(wb, "sheet")[0];
  const rid = sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || sheet.getAttribute("r:id");
  const rel = all(xml("xl/_rels/workbook.xml.rels"), "Relationship").find((r) => r.getAttribute("Id") === rid);
  let target = rel ? rel.getAttribute("Target") : "worksheets/sheet1.xml";
  target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");

  const shared = all(xml("xl/sharedStrings.xml"), "si").map(text);

  // Styles → quelles cellules sont des dates
  const styles = xml("xl/styles.xml");
  const customDate = new Set(
    all(styles, "numFmt")
      .filter((f) => /[dy]/i.test(f.getAttribute("formatCode").replace(/"[^"]*"|\[[^\]]*\]/g, "")))
      .map((f) => Number(f.getAttribute("numFmtId")))
  );
  const cellXfs = all(styles, "cellXfs")[0];
  const xfIsDate = cellXfs
    ? [...cellXfs.children].map((xf) => {
        const id = Number(xf.getAttribute("numFmtId"));
        return DATE_FORMAT_IDS.has(id) || customDate.has(id);
      })
    : [];

  const rows = [];
  const dateCols = new Set();
  for (const row of all(xml(target), "row")) {
    const r = Number(row.getAttribute("r")) - 1;
    const values = [];
    for (const c of all(row, "c")) {
      const i = colIndex(c.getAttribute("r"));
      const t = c.getAttribute("t");
      const v = all(c, "v")[0];
      let val = null;
      if (t === "s") val = v ? shared[Number(v.textContent)] : null;
      else if (t === "inlineStr") val = text(c);
      else if (t === "str" || t === "e") val = v ? v.textContent : null;
      else if (t === "b") val = v ? v.textContent === "1" : null;
      else if (v) {
        val = Number(v.textContent);
        if (xfIsDate[Number(c.getAttribute("s") || 0)]) dateCols.add(i);
      }
      if (typeof val === "string" && val.trim() === "") val = null;
      values[i] = val;
    }
    rows[r] = values;
  }
  // Lignes et cellules vides → null, longueur homogène
  const width = Math.max(0, ...rows.filter(Boolean).map((r) => r.length));
  const clean = [];
  for (let r = 0; r < rows.length; r++) {
    const row = Array.from({ length: width }, (_, i) => (rows[r] && rows[r][i] !== undefined ? rows[r][i] : null));
    clean.push(row);
  }
  while (clean.length && clean[clean.length - 1].every((v) => v === null)) clean.pop();
  return { sheetName: sheet.getAttribute("name"), rows: clean, dateCols: [...dateCols] };
}

/** N° de série Excel → "AAAA-MM-JJ" */
export function excelDateToIso(serial) {
  if (typeof serial !== "number") return serial;
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return d.toISOString().slice(0, 10);
}
