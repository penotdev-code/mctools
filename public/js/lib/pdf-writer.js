/* ==========================================================
   Création de PDF simples sans bibliothèque externe :
   pages composées d'images JPEG, de texte (Helvetica) et de rectangles.

   const doc = new PdfDoc();
   const page = doc.addPage(842, 595);           // taille en points (A4 paysage)
   page.image(jpegBytes, pxW, pxH, x, y, w, h);  // origine en bas à gauche
   page.rect(x, y, w, h, "#2e9d5b");
   page.text("Bonjour", x, y, 12, { bold: true, color: "#333333" });
   const blob = doc.save();
   ========================================================== */

// Helvetica standard : encodage WinAnsi (latin-1 + quelques caractères)
const WIN_ANSI_EXTRA = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "œ": 0x9c, "Œ": 0x8c };
function winAnsi(str) {
  const out = [];
  for (const ch of String(str).normalize("NFC")) {
    const code = ch.codePointAt(0);
    if (WIN_ANSI_EXTRA[ch]) out.push(WIN_ANSI_EXTRA[ch]);
    else if (code === 0x202f || code === 0xa0) out.push(0x20); // espaces insécables
    else if (code < 256) out.push(code);
    else out.push(0x3f); // « ? » pour le reste (emoji…)
  }
  return out;
}
function pdfString(str) {
  return "(" + winAnsi(str).map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? "\\" + String.fromCharCode(b) : b < 32 || b > 126 ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b))).join("") + ")";
}
const rgb = (hex) => {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (c / 255).toFixed(3)).join(" ");
};
const f = (n) => (Math.round(n * 100) / 100).toString();

// Largeurs approximatives Helvetica (pour mesurer / couper le texte)
export function textWidth(str, size, bold) {
  let w = 0;
  for (const ch of String(str)) {
    if ("ilI.,:;'|!".includes(ch)) w += 0.28;
    else if ("fjtr()[] ".includes(ch)) w += 0.33;
    else if ("mwMW".includes(ch)) w += 0.85;
    else if (ch >= "A" && ch <= "Z") w += 0.67;
    else w += 0.56;
  }
  return w * size * (bold ? 1.06 : 1);
}

class PdfPage {
  constructor(doc, width, height) {
    this.doc = doc;
    this.width = width;
    this.height = height;
    this.ops = [];
    this.images = [];
  }
  image(jpegBytes, pxW, pxH, x, y, w, h) {
    const name = "Im" + this.doc.imageCount++;
    this.images.push({ name, data: jpegBytes, pxW, pxH });
    this.ops.push(`q ${f(w)} 0 0 ${f(h)} ${f(x)} ${f(y)} cm /${name} Do Q`);
  }
  rect(x, y, w, h, fill, stroke) {
    this.ops.push(`q ${fill ? rgb(fill) + " rg " : ""}${stroke ? rgb(stroke) + " RG 0.6 w " : ""}${f(x)} ${f(y)} ${f(w)} ${f(h)} re ${fill && stroke ? "B" : fill ? "f" : "S"} Q`);
  }
  line(x1, y1, x2, y2, color = "#cccccc", width = 0.5) {
    this.ops.push(`q ${rgb(color)} RG ${f(width)} w ${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S Q`);
  }
  text(str, x, y, size = 10, { bold = false, color = "#222222" } = {}) {
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${f(size)} Tf ${rgb(color)} rg ${f(x)} ${f(y)} Td ${pdfString(str)} Tj ET`);
  }
}

export class PdfDoc {
  constructor() {
    this.pages = [];
    this.imageCount = 0;
  }
  addPage(width = 595.28, height = 841.89) {
    const p = new PdfPage(this, width, height);
    this.pages.push(p);
    return p;
  }
  save() {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (data) => {
      const bytes = typeof data === "string" ? enc.encode(data) : data;
      chunks.push(bytes);
      length += bytes.length;
    };
    // Les numéros d'objets : 1 catalogue, 2 pages, 3-4 polices, puis pages/contenus/images
    const objects = [];
    const add = (body) => objects.push(body); // renvoie le n° de l'objet (1, 2, …)
    add(null); // 1 : catalogue (rempli plus bas)
    add(null); // 2 : arbre des pages
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds = [];
    for (const p of this.pages) {
      const xobj = p.images.map((im) => {
        const id = add({ stream: im.data, dict: `<< /Type /XObject /Subtype /Image /Width ${im.pxW} /Height ${im.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>` });
        return `/${im.name} ${id} 0 R`;
      });
      const content = enc.encode(p.ops.join("\n"));
      const contentId = add({ stream: content, dict: `<< /Length ${content.length} >>` });
      pageIds.push(
        add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(p.width)} ${f(p.height)}] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xobj.join(" ")} >> >> >>`)
      );
    }
    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => id + " 0 R").join(" ")}] /Count ${pageIds.length} >>`;

    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    objects.forEach((o, i) => {
      offsets.push(length);
      push(`${i + 1} 0 obj\n`);
      if (o && o.stream) {
        push(o.dict + "\nstream\n");
        push(o.stream);
        push("\nendstream\n");
      } else push(o + "\n");
      push("endobj\n");
    });
    const xref = length;
    push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    push(offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join(""));
    push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }
}
