/* ==========================================================
   Création de fichiers Excel (.xlsx) sans bibliothèque externe.

   xlsx([{
     name: "Lots",
     columns: [{ header: "N°", width: 10 }, …],
     rows: [[ "A1", 45, { v: "Loué", fill: "#2e9d5b" } ], …],
   }]) → Blob

   Une cellule est une valeur (texte, nombre, vide) ou { v, fill, bold, date }
   (date : v est un n° de série Excel, affiché au format jj/mm/aaaa).
   ========================================================== */
import { zip } from "./zip.js";

const escXml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const colName = (i) => {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};
// Couleur pâle (pour le fond d'une cellule) à partir de la couleur d'un statut
function tint(hex, amount = 0.72) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * amount));
  return ch.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function xlsx(sheets) {
  // Styles : un par combinaison (gras, fond) rencontrée
  const styleKeys = ["0||0"]; // 0 = normal
  const styleOf = (bold, fill, date) => {
    const key = (bold ? 1 : 0) + "|" + (fill || "") + "|" + (date ? 1 : 0);
    let i = styleKeys.indexOf(key);
    if (i < 0) i = styleKeys.push(key) - 1;
    return i;
  };
  const header = styleOf(true, "#d9e2dc");

  const sheetXml = sheets.map((sh) => {
    const cols = sh.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join("");
    const rows = [sh.columns.map((c) => ({ v: c.header, style: header }))].concat(sh.rows);
    const body = rows
      .map((row, r) =>
        `<row r="${r + 1}">` +
        row
          .map((cell, c) => {
            const o = cell !== null && typeof cell === "object" ? cell : { v: cell };
            if (o.v === null || o.v === undefined || o.v === "") return "";
            const ref = colName(c) + (r + 1);
            const s = o.style != null ? o.style : o.bold || o.fill || o.date ? styleOf(o.bold, o.fill && "#" + tint(o.fill), o.date) : 0;
            const sAttr = s ? ` s="${s}"` : "";
            if (typeof o.v === "number" && Number.isFinite(o.v)) return `<c r="${ref}"${sAttr}><v>${o.v}</v></c>`;
            if (typeof o.v === "boolean") return `<c r="${ref}"${sAttr} t="b"><v>${o.v ? 1 : 0}</v></c>`;
            return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escXml(o.v)}</t></is></c>`;
          })
          .join("") +
        `</row>`
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols><sheetData>${body}</sheetData>
<autoFilter ref="A1:${colName(sh.columns.length - 1)}${rows.length}"/>
</worksheet>`;
  });

  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const xfs = styleKeys.map((k) => {
    const [bold, fill, date] = k.split("|");
    let fillId = 0;
    if (fill) fillId = fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${fill.replace("#", "").toUpperCase()}"/></patternFill></fill>`) - 1;
    return `<xf numFmtId="${date === "1" ? 14 : 0}" fontId="${bold === "1" ? 1 : 0}" fillId="${fillId}" borderId="0" xfId="0"${fillId ? ' applyFill="1"' : ""}${bold === "1" ? ' applyFont="1"' : ""}${date === "1" ? ' applyNumberFormat="1"' : ""}/>`;
  });
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="${fills.length}">${fills.join("")}</fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
</styleSheet>`;

  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
${sheets.map((s, i) => `<sheet name="${escXml(s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}
</sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: "xl/styles.xml", data: styles },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
  ];
  return zip(files, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
