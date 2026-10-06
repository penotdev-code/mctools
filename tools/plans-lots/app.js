/* ==========================================================
   Plans & lots
   - Un projet = un plan PDF + un listing (tableau Excel importé)
   - Chaque forme dessinée sur le plan est rattachée à une ligne du
     listing par sa clé (ex. IDLOCAL)
   - Le statut et la remarque sont des colonnes du listing : on les
     modifie ici ou dans Excel (export / réimport), dans les deux sens
   ========================================================== */
import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";
import { xlsx } from "/js/lib/xlsx.js";
import { readXlsx, excelDateToIso } from "/js/lib/xlsx-read.js";
import { PdfDoc, textWidth } from "/js/lib/pdf-writer.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
const API = "/api/tools/plans-lots/projects";
const COPY_FORMAT = "mctools-plans-lots";
const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_LISTING = { fileName: "", sheetName: "Lots", headers: ["Local", "N° de lot", "Type", "Surface", "Remarque", "STATUT PLAN"], rows: [], keyCol: 0, notesCol: 4, statusCol: 5, dateCols: [] };
const PATTERN_LABELS = { veil: "Voile blanc", hatch: "Hachures chantier", solid: "Couleur unie" };

/* ---------------- Utilitaires ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const natural = (a, b) => String(a == null ? "" : a).localeCompare(String(b == null ? "" : b), "fr", { numeric: true, sensitivity: "base" });
const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fmtDate = (ms) => new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const fileSafe = (s) => String(s || "plan").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "plan";
const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), ms);
}
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function api(method, path, body, headers = {}) {
  const r = await fetch(API + path, { method, body, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "Erreur " + r.status), { status: r.status, data });
  return data;
}
const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function parsePages(text) {
  const pages = new Set();
  for (const part of String(text).split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`« ${part} » n'est pas compris`);
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) pages.add(n);
  }
  return [...pages].sort((x, y) => x - y);
}
function pagesToText(pages) {
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(i === j ? String(pages[i]) : `${pages[i]}-${pages[j]}`);
    i = j;
  }
  return out.join(", ");
}

/* ---------------- État ---------------- */
let project = null;
let pdf = null;
let pageNum = 1;
let zoom = 1;
let mode = "select"; // select | polygon | rect
let selectedKey = null; // ligne sélectionnée (clé du listing)
let selectedShapeId = null;
let statusFilter = undefined; // undefined = tous, "" = sans statut, sinon nom de statut
let placeFilter = "all";
let draft = [];
let cursor = null;
let rectStart = null;
let drag = null;
let drawFor = null; // { key, replaceId } : la forme dessinée sera rattachée à ce local
let renderTask = null;
let pageSize = { w: 1, h: 1 };
let rowIndex = new Map(); // clé → n° de ligne

/* ---------------- Listing (tableau Excel) ---------------- */
const L = () => project.listing;
const keyOf = (row) => String(row[L().keyCol] == null ? "" : row[L().keyCol]).trim();
function reindex() {
  rowIndex = new Map();
  L().rows.forEach((r, i) => {
    const k = keyOf(r);
    if (k && !rowIndex.has(k)) rowIndex.set(k, i);
  });
}
const rowOf = (key) => (rowIndex.has(key) ? L().rows[rowIndex.get(key)] : null);
const findCol = (re) => L().headers.findIndex((h) => re.test(norm(h)));
const lotCol = () => findCol(/^n.{0,3}\s*(de\s*)?lot|^lot\b/);
function statusByName(name) {
  const n = norm(name).trim();
  return n ? project.statuses.find((s) => norm(s.name).trim() === n) || null : null;
}
const rowStatus = (row) => (row && L().statusCol >= 0 ? statusByName(row[L().statusCol]) : null);
const rowNotes = (row) => (row && L().notesCol >= 0 && row[L().notesCol] != null ? String(row[L().notesCol]) : "");
function rowLabel(row) {
  const lc = lotCol();
  const lot = lc >= 0 && row[lc] != null ? String(row[lc]) : "";
  return lot && lot !== keyOf(row) ? lot : keyOf(row);
}
function cellText(row, i) {
  const v = row[i];
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Oui" : "Non";
  if (L().dateCols.includes(i) && typeof v === "number") return new Date(excelDateToIso(v) + "T00:00:00").toLocaleDateString("fr-FR");
  if (typeof v === "number") return v.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
  return String(v);
}
const shapesOf = (key) => project.lots.filter((l) => l.key === key);
const visiblePages = () => {
  const all = Array.from({ length: pdf ? pdf.numPages : 1 }, (_, i) => i + 1);
  const chosen = (project.pages || []).filter((n) => n <= all.length);
  return chosen.length ? chosen : all;
};

/* ==========================================================
   LISTE DES PLANS
   ========================================================== */
async function showList() {
  $("#editorView").hidden = true;
  $("#listView").hidden = false;
  project = null;
  pdf = null;
  try {
    const list = await api("GET", "");
    $("#listEmpty").hidden = list.length > 0;
    $("#projectList").innerHTML = list
      .map((p) => {
        const pills = p.statuses
          .filter((s) => p.counts[s.name])
          .map((s) => `<span class="pill"><span class="dot dot--${esc(s.pattern)}" style="background:${esc(s.color)}"></span>${esc(s.name)} · ${p.counts[s.name]}</span>`)
          .join("");
        return `<div class="tool-card project-card">
          <h3>${esc(p.name)}</h3>
          <span class="meta">${p.rowCount} local${p.rowCount > 1 ? "aux" : ""} · ${p.lotCount} sur le plan · modifié le ${esc(fmtDate(p.updatedAt))}</span>
          <div class="pills">${pills}</div>
          <div class="actions">
            <a class="btn btn--small" href="#${esc(p.id)}">Ouvrir</a>
            <button type="button" class="btn btn--ghost btn--small" data-copy="${esc(p.id)}">💾 Copie</button>
            <button type="button" class="btn btn--ghost btn--small danger" data-delete="${esc(p.id)}" data-name="${esc(p.name)}" aria-label="Supprimer">🗑️</button>
          </div>
        </div>`;
      })
      .join("");
  } catch (e) {
    showListError("Impossible de charger les plans : " + e.message);
  }
}
function showListError(msg) {
  $("#listError").textContent = msg;
  $("#listError").hidden = !msg;
}

$("#projectList").addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-copy]");
  const del = e.target.closest("[data-delete]");
  if (copy) {
    copy.disabled = true;
    try {
      await downloadCopy(await api("GET", "/" + copy.dataset.copy));
    } catch (ex) {
      toast("Erreur : " + ex.message);
    }
    copy.disabled = false;
  }
  if (del) {
    if (!confirm(`Supprimer définitivement le plan « ${del.dataset.name} » ?\n\nAstuce : télécharge d'abord une copie si tu veux la garder.`)) return;
    try {
      await api("DELETE", "/" + del.dataset.delete);
      toast("Plan supprimé");
      showList();
    } catch (ex) {
      toast("Erreur : " + ex.message);
    }
  }
});

$("#newPlanFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  showListError("");
  if (file.size > 50 * 1024 * 1024) return showListError("Ce PDF dépasse 50 Mo.");
  const name = prompt("Nom du plan (ex. « 57 rue de Tocqueville ») :", file.name.replace(/\.pdf$/i, "").replace(/_/g, " "));
  if (name === null) return;
  try {
    const p = await api("POST", `?name=${encodeURIComponent(name)}&file=${encodeURIComponent(file.name)}`, file, { "Content-Type": "application/pdf" });
    openAfterCreate = true;
    location.hash = p.id;
  } catch (ex) {
    showListError("Import impossible : " + ex.message);
  }
});
let openAfterCreate = false;

$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  showListError("");
  try {
    const copy = JSON.parse(await file.text());
    if (copy.format !== COPY_FORMAT || !copy.pdf || !copy.project) throw new Error("ce fichier n'est pas une copie de plan MC Tools");
    const pdfBlob = new Blob([base64ToBytes(copy.pdf)], { type: "application/pdf" });
    const c = copy.project;
    const created = await api("POST", `?name=${encodeURIComponent(c.name || "Plan importé")}&file=${encodeURIComponent(c.fileName || "")}`, pdfBlob, { "Content-Type": "application/pdf" });
    await api("PUT", "/" + created.id, JSON.stringify({ rev: created.rev, name: created.name, statuses: c.statuses, listing: c.listing, pages: c.pages, lots: c.lots || [] }), { "Content-Type": "application/json" });
    toast("Copie importée ✓");
    location.hash = created.id;
  } catch (ex) {
    showListError("Import impossible : " + ex.message);
  }
});

async function downloadCopy(p) {
  const pdfBlob = await fetch(`${API}/${p.id}/plan.pdf`).then((r) => r.blob());
  const copy = {
    format: COPY_FORMAT,
    version: 2,
    exportedAt: new Date().toISOString(),
    project: { name: p.name, fileName: p.fileName, statuses: p.statuses, listing: p.listing, pages: p.pages, lots: p.lots },
    pdf: await blobToBase64(pdfBlob),
  };
  download(new Blob([JSON.stringify(copy)], { type: "application/json" }), `${fileSafe(p.name)} - copie MC Tools.json`);
  toast("💾 Copie téléchargée (à réimporter avec « Importer une copie »)", 4000);
}

/* ==========================================================
   ÉDITEUR
   ========================================================== */
async function openProject(id) {
  $("#listView").hidden = true;
  $("#editorView").hidden = false;
  $("#stageLoading").hidden = false;
  $("#stageLoading").textContent = "Chargement du plan…";
  selectedKey = null;
  selectedShapeId = null;
  statusFilter = undefined;
  setMode("select");
  try {
    project = await api("GET", "/" + id);
    if (!project.listing) project.listing = structuredClone(DEFAULT_LISTING);
    project.lots.forEach((l) => (l.key = l.key || ""));
    reindex();
    pdf = await pdfjsLib.getDocument({ url: `${API}/${id}/plan.pdf`, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/" }).promise;
  } catch (e) {
    $("#stageLoading").textContent = "Impossible d'ouvrir ce plan : " + e.message;
    return;
  }
  $("#projectName").value = project.name;
  document.title = project.name + " · Plans & lots";
  setSaveState("Enregistré ✓");
  pageNum = visiblePages()[0];
  await fitZoom();
  renderSide();
  if (openAfterCreate) {
    openAfterCreate = false;
    if (pdf.numPages > 2) openPagesDialog(true);
  }
}

async function renderPage() {
  if (!pdf) return;
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: zoom });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = $("#pdfCanvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  pageSize = { w: viewport.width, h: viewport.height };
  $("#overlay").setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
  drawOverlay();
  if (renderTask) renderTask.cancel();
  renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e.name !== "RenderingCancelledException") throw e;
  }
  $("#stageLoading").hidden = true;
  const pages = visiblePages();
  const i = pages.indexOf(pageNum);
  $("#pageInfo").textContent = pages.length === pdf.numPages ? `Page ${pageNum} / ${pdf.numPages}` : `Plan ${i + 1} / ${pages.length} (p. ${pageNum})`;
  $("#prevPage").disabled = i <= 0;
  $("#nextPage").disabled = i >= pages.length - 1;
  $("#zoomInfo").textContent = Math.round(zoom * 100) + " %";
}

async function fitZoom() {
  const page = await pdf.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const stage = $("#stage");
  const availW = stage.clientWidth - 32;
  const availH = stage.clientHeight - 32;
  zoom = Math.max(0.2, Math.min(6, Math.min(availW / vp.width, availH > 200 ? availH / vp.height : Infinity)));
  await renderPage();
}
function setZoom(z, anchor) {
  const stage = $("#stage");
  const old = zoom;
  zoom = Math.max(0.2, Math.min(8, z));
  // Garde le même point au centre (ou sous la souris)
  const ax = anchor ? anchor.x : stage.clientWidth / 2;
  const ay = anchor ? anchor.y : stage.clientHeight / 2;
  const fx = (stage.scrollLeft + ax) / old, fy = (stage.scrollTop + ay) / old;
  renderPage().then(() => stage.scrollTo(fx * zoom - ax, fy * zoom - ay));
}
$("#zoomIn").addEventListener("click", () => setZoom(zoom * 1.25));
$("#zoomOut").addEventListener("click", () => setZoom(zoom / 1.25));
$("#zoomFit").addEventListener("click", () => fitZoom());
$("#stage").addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const r = $("#stage").getBoundingClientRect();
  setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX - r.left, y: e.clientY - r.top });
}, { passive: false });
$("#prevPage").addEventListener("click", () => stepPage(-1));
$("#nextPage").addEventListener("click", () => stepPage(1));
function stepPage(d) {
  const pages = visiblePages();
  const i = pages.indexOf(pageNum) + d;
  if (i >= 0 && i < pages.length) goToPage(pages[i]);
}
function goToPage(n) {
  if (!pdf || n === pageNum) return Promise.resolve();
  pageNum = n;
  draft = [];
  return renderPage();
}

/* ---------------- Pages utilisées ---------------- */
function openPagesDialog(first) {
  $("#pagesInput").value = pagesToText(project.pages || []);
  if (first && !project.pages.length) $("#pagesInput").placeholder = `Toutes les pages (1-${pdf.numPages})`;
  $("#pagesError").hidden = true;
  $("#pagesDialog").showModal();
}
$("#choosePages").addEventListener("click", () => openPagesDialog());
$("#cancelPages").addEventListener("click", () => $("#pagesDialog").close());
$("#savePages").addEventListener("click", () => {
  try {
    const pages = parsePages($("#pagesInput").value).filter((n) => n <= pdf.numPages);
    project.pages = pages;
    $("#pagesDialog").close();
    if (!visiblePages().includes(pageNum)) pageNum = visiblePages()[0];
    fitZoom();
    scheduleSave();
  } catch (e) {
    $("#pagesError").textContent = e.message;
    $("#pagesError").hidden = false;
  }
});

/* ---------------- Calque SVG ---------------- */
const toPx = ([x, y]) => [x * pageSize.w, y * pageSize.h];
function centroid(points) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cr = x1 * y2 - x2 * y1;
    a += cr;
    cx += (x1 + x2) * cr;
    cy += (y1 + y2) * cr;
  }
  if (Math.abs(a) < 1e-12) return points.reduce(([sx, sy], [x, y]) => [sx + x / points.length, sy + y / points.length], [0, 0]);
  return [cx / (3 * a), cy / (3 * a)];
}
function el(name, attrs) {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
// Apparence d'une forme selon le statut de son local
function shapeStyle(lot) {
  const row = rowOf(lot.key);
  if (!row) return { fill: "#d32f2f", fillOpacity: 0.12, stroke: "#d32f2f", dash: "6 4" }; // non rattachée
  const st = rowStatus(row);
  if (!st) return { fill: "#000000", fillOpacity: 0.03, stroke: "#333333", dash: "5 4" };
  if (st.pattern === "veil") return { fill: "#ffffff", fillOpacity: 0.85, stroke: "#6b6b6b" };
  if (st.pattern === "hatch") return { fill: `url(#pat-${st.id})`, fillOpacity: 0.85, stroke: "#1a1a1a" };
  return { fill: st.color, fillOpacity: 0.55, stroke: st.color };
}
function matchesFilter(lot) {
  if (statusFilter === undefined) return true;
  const st = rowStatus(rowOf(lot.key));
  return statusFilter === "" ? !st : st && st.name === statusFilter;
}

function drawOverlay() {
  const svg = $("#overlay");
  svg.replaceChildren();
  if (!project) return;
  // Motifs « chantier » des statuts hachurés
  const defs = el("defs", {});
  for (const s of project.statuses.filter((s) => s.pattern === "hatch")) {
    const p = el("pattern", { id: "pat-" + s.id, patternUnits: "userSpaceOnUse", width: 16, height: 16, patternTransform: "rotate(45)" });
    p.append(el("rect", { width: 16, height: 16, fill: s.color }), el("rect", { width: 7, height: 16, fill: "#1a1a1a" }));
    defs.append(p);
  }
  svg.append(defs);
  const shapes = project.lots.filter((l) => l.page === pageNum && l.points.length >= 3);
  for (const lot of shapes) {
    const s = shapeStyle(lot);
    const dimmed = !matchesFilter(lot);
    const selected = lot.key ? lot.key === selectedKey : lot.id === selectedShapeId;
    svg.append(el("polygon", {
      points: lot.points.map((p) => toPx(p).join(",")).join(" "),
      fill: s.fill,
      "fill-opacity": dimmed ? s.fillOpacity * 0.25 : s.fillOpacity,
      stroke: selected ? "#0a58ca" : s.stroke,
      "stroke-opacity": dimmed ? 0.3 : 1,
      "stroke-dasharray": selected ? "" : s.dash || "",
      class: "lot-shape" + (selected ? " is-selected" : ""),
      "data-shape": lot.id,
    }));
  }
  for (const lot of shapes) {
    const row = rowOf(lot.key);
    const label = row ? rowLabel(row) : "?";
    const [cx, cy] = toPx(centroid(lot.points));
    const t = el("text", { x: cx, y: cy, class: "lot-label" + (row ? "" : " lot-label--orphan"), opacity: matchesFilter(lot) ? 1 : 0.4 });
    t.textContent = label;
    svg.append(t);
  }
  // Poignées de la forme sélectionnée
  const sel = project.lots.find((l) => l.id === selectedShapeId);
  if (sel && sel.page === pageNum && mode === "select") {
    sel.points.forEach((p, i) => {
      const [x, y] = toPx(p);
      svg.append(el("circle", { cx: x, cy: y, r: 6, class: "handle", "data-handle": i }));
    });
  }
  if (mode === "polygon" && draft.length) {
    const pts = draft.concat(cursor ? [cursor] : []).map((p) => toPx(p).join(",")).join(" ");
    svg.append(el(draft.length > 1 ? "polygon" : "polyline", { points: pts, class: "draft" }));
    draft.forEach((p, i) => {
      const [x, y] = toPx(p);
      svg.append(el("circle", { cx: x, cy: y, r: i === 0 ? 7 : 4, class: "draft-point" + (i === 0 ? " is-first" : "") }));
    });
  }
  if (mode === "rect" && rectStart && cursor) {
    const [x1, y1] = toPx(rectStart), [x2, y2] = toPx(cursor);
    svg.append(el("rect", { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), class: "draft" }));
  }
}

function pointFromEvent(e) {
  const r = $("#overlay").getBoundingClientRect();
  return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
}
const pxDist = (a, b) => Math.hypot((a[0] - b[0]) * pageSize.w, (a[1] - b[1]) * pageSize.h);

function setMode(m, target) {
  mode = m;
  draft = [];
  rectStart = null;
  cursor = null;
  drawFor = m === "select" ? null : target || drawFor;
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  $("#overlay").setAttribute("class", "mode-" + m);
  const forTxt = drawFor ? ` pour le local ${drawFor.key}` : "";
  $("#drawHint").hidden = m === "select";
  $("#drawHint").textContent =
    m === "polygon"
      ? `⬠ Clique chaque angle${forTxt}. Termine en cliquant sur le 1er point, par un double-clic ou Entrée. Échap pour annuler.`
      : m === "rect"
      ? `▭ Clique-glisse pour tracer le rectangle${forTxt}. Échap pour annuler.`
      : "";
  drawOverlay();
}
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function finishShape(points) {
  const clean = points.filter((p, i) => i === 0 || pxDist(p, points[i - 1]) > 3);
  if (clean.length < 3) return toast("Il faut au moins 3 points");
  const target = drawFor;
  let lot;
  if (target && target.replaceId) {
    lot = project.lots.find((l) => l.id === target.replaceId);
    if (lot) Object.assign(lot, { points: clean, page: pageNum });
  }
  if (!lot) {
    lot = { id: randomId(), page: pageNum, points: clean, key: target ? target.key : "" };
    project.lots.push(lot);
  }
  setMode("select");
  selectedShapeId = lot.id;
  selectedKey = lot.key || null;
  scheduleSave();
  drawOverlay();
  renderSide();
  if (!lot.key) openLinkDialog(lot);
}

const overlay = $("#overlay");
let lastTap = { id: null, t: 0 };
overlay.addEventListener("pointerdown", (e) => {
  if (!project || e.button > 0) return;
  const pt = pointFromEvent(e);
  if (mode === "select") {
    const h = e.target.closest("[data-handle]");
    if (h) {
      drag = { id: selectedShapeId, index: Number(h.dataset.handle) };
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const shape = e.target.closest("[data-shape]");
    if (!shape) return selectShape(null);
    // Double-clic (ou double appui) : la fiche complète
    const now = Date.now();
    const isDouble = lastTap.id === shape.dataset.shape && now - lastTap.t < 400;
    lastTap = { id: shape.dataset.shape, t: now };
    selectShape(shape.dataset.shape);
    if (isDouble) {
      const lot = project.lots.find((l) => l.id === shape.dataset.shape);
      if (lot && rowOf(lot.key)) openInfoDialog(lot.key);
    }
    return;
  }
  e.preventDefault();
  if (mode === "polygon") {
    if (draft.length >= 3 && pxDist(pt, draft[0]) < 10) return finishShape(draft);
    draft.push(pt);
    cursor = pt;
    drawOverlay();
  } else if (mode === "rect") {
    rectStart = pt;
    cursor = pt;
    overlay.setPointerCapture(e.pointerId);
  }
});
overlay.addEventListener("pointermove", (e) => {
  if (!project) return;
  const pt = pointFromEvent(e);
  if (drag) {
    const lot = project.lots.find((l) => l.id === drag.id);
    if (lot) lot.points[drag.index] = pt;
    drawOverlay();
    return;
  }
  if ((mode === "polygon" && draft.length) || (mode === "rect" && rectStart)) {
    cursor = pt;
    drawOverlay();
  }
});
overlay.addEventListener("pointerup", (e) => {
  if (drag) {
    drag = null;
    scheduleSave();
    return;
  }
  if (mode === "rect" && rectStart) {
    const a = rectStart, b = pointFromEvent(e);
    rectStart = null;
    if (pxDist(a, [b[0], a[1]]) < 6 || pxDist(a, [a[0], b[1]]) < 6) {
      drawOverlay();
      return toast("Fais glisser pour tracer le rectangle");
    }
    finishShape([a, [b[0], a[1]], b, [a[0], b[1]]]);
  }
});
overlay.addEventListener("dblclick", (e) => {
  if (mode === "polygon" && draft.length >= 3) {
    e.preventDefault();
    finishShape(draft);
  }
});
document.addEventListener("keydown", (e) => {
  if ($("#editorView").hidden || document.querySelector("dialog[open]")) return;
  const typing = e.target.closest("input, textarea, select");
  if (e.key === "Escape") {
    if (mode !== "select") setMode("select");
    else if (!typing) selectShape(null);
  } else if (e.key === "Enter" && mode === "polygon" && draft.length >= 3) {
    e.preventDefault();
    finishShape(draft);
  } else if (!typing && (e.key === "p" || e.key === "P")) setMode("polygon");
  else if (!typing && (e.key === "r" || e.key === "R")) setMode("rect");
});

/* ---------------- Sélection ---------------- */
function selectShape(id) {
  const lot = id && project.lots.find((l) => l.id === id);
  selectedShapeId = lot ? lot.id : null;
  selectedKey = lot && lot.key ? lot.key : null;
  drawOverlay();
  renderSide();
  if (lot && !lot.key) openLinkDialog(lot);
}
// Depuis la liste : sélectionne le local et montre sa forme sur le plan
async function selectKey(key, { scroll = true } = {}) {
  selectedKey = key;
  const shapes = shapesOf(key).filter((l) => visiblePages().includes(l.page));
  const lot = shapes.find((l) => l.page === pageNum) || shapes[0];
  selectedShapeId = lot ? lot.id : null;
  if (lot && lot.page !== pageNum) await goToPage(lot.page);
  else drawOverlay();
  renderSide();
  if (lot && scroll) scrollToShape(lot);
}
function scrollToShape(lot) {
  const [cx, cy] = toPx(centroid(lot.points));
  const stage = $("#stage");
  const box = $("#pageBox");
  const x = box.offsetLeft + cx, y = box.offsetTop + cy;
  if (x < stage.scrollLeft + 40 || x > stage.scrollLeft + stage.clientWidth - 40 || y < stage.scrollTop + 40 || y > stage.scrollTop + stage.clientHeight - 40) {
    stage.scrollTo({ left: x - stage.clientWidth / 2, top: y - stage.clientHeight / 2, behavior: "smooth" });
  }
}

/* ---------------- Panneau latéral ---------------- */
function renderSide() {
  if (!project) return;
  const row = selectedKey ? rowOf(selectedKey) : null;
  $("#overview").hidden = !!row;
  $("#rowCard").hidden = !row;
  if (row) return renderCard($("#rowCard"), selectedKey, { closable: true });

  // Légende : nombre de locaux par statut (cliquable pour filtrer)
  const counts = new Map();
  let none = 0;
  for (const r of L().rows) {
    if (!keyOf(r)) continue;
    const st = rowStatus(r);
    if (st) counts.set(st.name, (counts.get(st.name) || 0) + 1);
    else none++;
  }
  const orphans = project.lots.filter((l) => !rowOf(l.key)).length;
  $("#legend").innerHTML =
    project.statuses
      .map((s) => `<li><button type="button" data-filter="${esc(s.name)}" aria-pressed="${statusFilter === s.name}">
        <span class="dot dot--${esc(s.pattern)}" style="background:${esc(s.color)}"></span>${esc(s.name)}<span class="n">${counts.get(s.name) || 0}</span></button></li>`)
      .join("") +
    `<li><button type="button" data-filter="" aria-pressed="${statusFilter === ""}"><span class="dot dot--none"></span>Sans statut<span class="n">${none}</span></button></li>` +
    (orphans ? `<li class="legend__warn">⚠️ ${orphans} forme${orphans > 1 ? "s" : ""} non rattachée${orphans > 1 ? "s" : ""} (en rouge sur le plan)</li>` : "");

  const total = L().rows.filter((r) => keyOf(r)).length;
  $("#rowCount").textContent = `(${total})`;
  $("#listingInfo").innerHTML = L().fileName
    ? `📄 ${esc(L().fileName)} · clé : <b>${esc(L().headers[L().keyCol])}</b>`
    : "Aucun listing Excel importé : utilise « 📥 Importer l'Excel » ou ajoute les locaux à la main.";

  const q = norm($("#rowSearch").value.trim());
  const pages = visiblePages();
  const list = L().rows
    .filter((r) => keyOf(r))
    .filter((r) => {
      const st = rowStatus(r);
      if (statusFilter !== undefined && (statusFilter === "" ? st : !st || st.name !== statusFilter)) return false;
      const placed = shapesOf(keyOf(r)).some((l) => pages.includes(l.page));
      if (placeFilter === "placed" && !placed) return false;
      if (placeFilter === "unplaced" && placed) return false;
      return !q || norm(r.join(" ")).includes(q);
    })
    .sort((a, b) => natural(keyOf(a), keyOf(b)));
  const multi = pages.length > 1;
  $("#rowList").innerHTML =
    list
      .slice(0, 400)
      .map((r) => {
        const key = keyOf(r);
        const st = rowStatus(r);
        const shapes = shapesOf(key);
        const where = shapes.length ? (multi ? `📍 p.${shapes[0].page}` : "📍") : "à placer";
        const lot = rowLabel(r);
        const note = rowNotes(r);
        return `<li><button type="button" data-key="${esc(key)}">
          <span class="dot ${st ? "dot--" + esc(st.pattern) : "dot--none"}" style="${st ? "background:" + esc(st.color) : ""}"></span>
          <span class="row-main"><b>${esc(key)}</b>${lot !== key ? ` <span class="muted">· lot ${esc(lot)}</span>` : ""}
          ${note ? `<span class="row-note">${esc(note)}</span>` : ""}</span>
          <span class="sub${shapes.length ? "" : " sub--todo"}">${where}</span></button></li>`;
      })
      .join("") || `<li class="muted">Aucun local ne correspond.</li>`;
}
$("#legend").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  statusFilter = statusFilter === b.dataset.filter ? undefined : b.dataset.filter;
  drawOverlay();
  renderSide();
});
$("#placeFilter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-place]");
  if (!b) return;
  placeFilter = b.dataset.place;
  document.querySelectorAll("[data-place]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  renderSide();
});
$("#rowList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-key]");
  if (b) selectKey(b.dataset.key);
});
$("#rowSearch").addEventListener("input", renderSide);

/* ---------------- Fiche d'un local (panneau ou fenêtre) ---------------- */
function renderCard(box, key, { closable, dialog } = {}) {
  const row = rowOf(key);
  if (!row) return;
  const st = rowStatus(row);
  const shapes = shapesOf(key);
  const special = new Set([L().keyCol, L().notesCol, L().statusCol]);
  const fields = L().headers
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => !special.has(i))
    .map(({ h, i }) => {
      const date = L().dateCols.includes(i);
      const v = row[i];
      if (L().rows.some((r) => typeof r[i] === "boolean")) {
        return `<label class="field"><span>${esc(h)}</span>
          <select class="input input--compact" data-col="${i}" data-bool="1">
            <option value=""></option><option value="1" ${v === true ? "selected" : ""}>Oui</option><option value="0" ${v === false ? "selected" : ""}>Non</option>
          </select></label>`;
      }
      const val = date && typeof v === "number" ? excelDateToIso(v) : v == null ? "" : String(v);
      return `<label class="field"><span>${esc(h)}</span>
        <input class="input input--compact" data-col="${i}" ${date ? 'type="date"' : ""} value="${esc(val)}" /></label>`;
    })
    .join("");
  box.innerHTML = `
    <div class="side__head">
      <h2><span class="dot ${st ? "dot--" + esc(st.pattern) : "dot--none"}" style="${st ? "background:" + esc(st.color) : ""}"></span>${esc(key)}</h2>
      ${closable ? '<button type="button" class="btn btn--ghost btn--small" data-act="close">✕</button>' : ""}
      ${dialog ? '<button type="button" class="btn btn--ghost btn--small" data-act="close-dialog">✕ Fermer</button>' : ""}
    </div>
    <div class="card-main">
      <label class="field">Statut
        <select class="input" data-role="status">
          <option value="">— Aucun —</option>
          ${project.statuses.map((s) => `<option ${st && st.id === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select>
      </label>
      <label class="field">${esc(L().notesCol >= 0 ? L().headers[L().notesCol] : "Remarque")}
        <textarea class="input" data-role="notes" rows="${dialog ? 6 : 4}" placeholder="Tes notes sur ce local…">${esc(rowNotes(row))}</textarea>
      </label>
    </div>
    <div class="actions">
      ${shapes.length ? `<button type="button" class="btn btn--ghost btn--small" data-act="show">📍 Voir sur le plan</button>` : ""}
      <button type="button" class="btn btn--small" data-act="draw">✏️ ${shapes.length ? "Redessiner" : "Dessiner sur le plan"}</button>
      ${shapes.length ? `<button type="button" class="btn btn--ghost btn--small danger" data-act="unplace">Retirer du plan</button>` : ""}
    </div>
    <details class="card-fields" ${dialog ? "open" : ""}>
      <summary>Toutes les informations du listing</summary>
      <div class="lot-fields">${fields}
        <label class="field"><span>${esc(L().headers[L().keyCol])} (clé)</span>
          <input class="input input--compact" data-role="key" value="${esc(key)}" /></label>
      </div>
    </details>`;

  box.onchange = box.oninput = (e) => {
    const t = e.target;
    const r = rowOf(key);
    if (!r) return;
    if (t.dataset.role === "status") {
      if (L().statusCol < 0) addColumn("STATUT PLAN", "statusCol");
      r[L().statusCol] = t.value || null;
      drawOverlay();
      if (e.type === "change") refreshCards(box);
    } else if (t.dataset.role === "notes") {
      if (L().notesCol < 0) addColumn("Remarque", "notesCol");
      r[L().notesCol] = t.value || null;
    } else if (t.dataset.col != null) {
      const i = Number(t.dataset.col);
      if (t.dataset.bool) r[i] = t.value === "" ? null : t.value === "1";
      else if (L().dateCols.includes(i)) r[i] = t.value ? Math.round(Date.parse(t.value + "T00:00:00Z") / 86400000 + 25569) : null;
      else {
        const old = r[i];
        const n = Number(String(t.value).replace(",", "."));
        r[i] = t.value === "" ? null : typeof old === "number" && !isNaN(n) ? n : t.value;
      }
      drawOverlay();
    } else if (t.dataset.role === "key" && e.type === "change") {
      renameKey(key, t.value.trim());
      return;
    } else return;
    scheduleSave();
  };
  box.onclick = (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") {
      selectedKey = null;
      selectedShapeId = null;
      drawOverlay();
      renderSide();
    } else if (act === "close-dialog") $("#infoDialog").close();
    else if (act === "show") {
      $("#infoDialog").close();
      selectKey(key);
    } else if (act === "draw") {
      $("#infoDialog").close();
      const current = shapesOf(key).find((l) => l.id === selectedShapeId) || shapesOf(key)[0];
      selectKey(key, { scroll: false }).then(() => setMode("polygon", { key, replaceId: current ? current.id : null }));
    } else if (act === "unplace") {
      if (!confirm(`Retirer le local ${key} du plan ? (ses informations restent dans le listing)`)) return;
      project.lots = project.lots.filter((l) => l.key !== key);
      selectedShapeId = null;
      drawOverlay();
      refreshCards(box);
      scheduleSave();
    }
  };
}
// Réaffiche la fiche (statut, boutons) sans perdre la saisie en cours
function refreshCards(box) {
  if (box === $("#rowCard")) renderSide();
  else {
    renderCard(box, selectedKey, { dialog: true });
    renderSide();
  }
}
function renameKey(oldKey, newKey) {
  if (!newKey || newKey === oldKey) return;
  if (rowIndex.has(newKey)) {
    toast(`La clé « ${newKey} » existe déjà`);
    return renderSide();
  }
  rowOf(oldKey)[L().keyCol] = newKey;
  project.lots.forEach((l) => l.key === oldKey && (l.key = newKey));
  reindex();
  selectedKey = newKey;
  drawOverlay();
  renderSide();
  scheduleSave();
}
function addColumn(name, role) {
  L().headers.push(name);
  L().rows.forEach((r) => r.push(null));
  L()[role] = L().headers.length - 1;
}
function openInfoDialog(key) {
  const d = $("#infoDialog");
  renderCard(d, key, { dialog: true });
  d.showModal();
  d.addEventListener("close", () => renderSide(), { once: true });
}

$("#addRow").addEventListener("click", () => {
  const key = prompt(`Identifiant du nouveau local (colonne « ${L().headers[L().keyCol]} ») :`);
  if (!key || !key.trim()) return;
  if (rowIndex.has(key.trim())) return toast("Ce local existe déjà");
  const row = L().headers.map(() => null);
  row[L().keyCol] = key.trim();
  L().rows.push(row);
  reindex();
  scheduleSave();
  selectKey(key.trim());
});

/* ---------------- Rattacher une forme ---------------- */
let linking = null;
function openLinkDialog(lot) {
  linking = lot;
  $("#linkSearch").value = "";
  renderLinkList();
  $("#linkDialog").showModal();
  $("#linkSearch").focus();
}
function renderLinkList() {
  const q = norm($("#linkSearch").value.trim());
  const placed = new Set(project.lots.map((l) => l.key));
  const list = L().rows
    .filter((r) => keyOf(r) && (!q || norm(r.join(" ")).includes(q)))
    .sort((a, b) => (placed.has(keyOf(a)) - placed.has(keyOf(b))) || natural(keyOf(a), keyOf(b)))
    .slice(0, 200);
  $("#linkList").innerHTML =
    list
      .map((r) => {
        const k = keyOf(r);
        const extra = [rowLabel(r) !== k ? "lot " + rowLabel(r) : "", ...L().headers.map((h, i) => (/type|etage/.test(norm(h)) && r[i] != null ? cellText(r, i) : ""))].filter(Boolean).slice(0, 3).join(" · ");
        return `<li><button type="button" data-link="${esc(k)}"><b>${esc(k)}</b><span class="sub">${esc(extra)}${placed.has(k) ? " · déjà placé" : ""}</span></button></li>`;
      })
      .join("") || `<li class="muted">${L().rows.length ? "Aucun local ne correspond." : "Le listing est vide : importe d'abord l'Excel (ou « Ajouter un local »)."}</li>`;
}
$("#linkSearch").addEventListener("input", renderLinkList);
$("#linkList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-link]");
  if (!b || !linking) return;
  linking.key = b.dataset.link;
  $("#linkDialog").close();
  selectedKey = linking.key;
  selectedShapeId = linking.id;
  linking = null;
  drawOverlay();
  renderSide();
  scheduleSave();
});
$("#linkLater").addEventListener("click", () => $("#linkDialog").close());
$("#linkDelete").addEventListener("click", () => {
  if (!linking) return;
  project.lots = project.lots.filter((l) => l !== linking);
  linking = null;
  selectedShapeId = null;
  $("#linkDialog").close();
  drawOverlay();
  renderSide();
  scheduleSave();
});

/* ---------------- Statuts ---------------- */
let editingStatuses = [];
function renderStatusEditor() {
  $("#statusEditList").innerHTML = editingStatuses
    .map((s, i) => `<li>
      <input type="color" value="${esc(s.color)}" data-i="${i}" data-k="color" aria-label="Couleur" />
      <input class="input" value="${esc(s.name)}" data-i="${i}" data-k="name" maxlength="40" aria-label="Nom du statut" />
      <select class="input" data-i="${i}" data-k="pattern" aria-label="Rendu">
        ${Object.entries(PATTERN_LABELS).map(([k, v]) => `<option value="${k}" ${s.pattern === k ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <button type="button" class="btn btn--ghost btn--small danger" data-remove="${i}" aria-label="Supprimer">🗑️</button>
    </li>`)
    .join("");
}
$("#editStatuses").addEventListener("click", () => {
  editingStatuses = project.statuses.map((s) => Object.assign({}, s, { oldName: s.name }));
  renderStatusEditor();
  $("#statusDialog").showModal();
});
$("#statusEditList").addEventListener("input", (e) => {
  const i = e.target.dataset.i;
  if (i != null) editingStatuses[i][e.target.dataset.k] = e.target.value;
});
$("#statusEditList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  editingStatuses.splice(Number(b.dataset.remove), 1);
  renderStatusEditor();
});
$("#addStatus").addEventListener("click", () => {
  const palette = ["#2e9d5b", "#3d7fd6", "#e8892b", "#6b7280", "#14a3a3"];
  editingStatuses.push({ id: "s" + randomId(), name: "Nouveau statut", color: palette[editingStatuses.length % palette.length], pattern: "solid" });
  renderStatusEditor();
});
$("#cancelStatuses").addEventListener("click", () => $("#statusDialog").close());
$("#saveStatuses").addEventListener("click", () => {
  // Un statut renommé est renommé aussi dans le listing
  if (L().statusCol >= 0) {
    for (const s of editingStatuses) {
      if (s.oldName && s.oldName !== s.name) L().rows.forEach((r) => norm(r[L().statusCol]) === norm(s.oldName) && (r[L().statusCol] = s.name));
    }
  }
  project.statuses = editingStatuses.map((s) => ({ id: s.id, name: s.name.trim() || "Statut", color: s.color, pattern: s.pattern }));
  $("#statusDialog").close();
  drawOverlay();
  renderSide();
  scheduleSave();
});

/* ---------------- Import du listing Excel ---------------- */
$("#listingFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const sheet = await readXlsx(file);
    const headerRow = sheet.rows.findIndex((r) => r.filter((v) => v !== null).length >= 2);
    if (headerRow < 0) throw new Error("aucun tableau trouvé dans la 1re feuille");
    const headers = sheet.rows[headerRow].map((h, i) => (h == null ? `Colonne ${i + 1}` : String(h).trim()));
    const rows = sheet.rows.slice(headerRow + 1).filter((r) => r.some((v) => v !== null));
    const find = (re) => headers.findIndex((h) => re.test(norm(h)));
    let keyCol = find(/^id\s*local|^identifiant/);
    if (keyCol < 0) keyCol = headers.findIndex((_, i) => rows.length && rows.every((r) => r[i] !== null) && new Set(rows.map((r) => String(r[i]))).size === rows.length);
    if (keyCol < 0) keyCol = 0;
    const next = {
      fileName: file.name,
      sheetName: sheet.sheetName,
      headers,
      rows,
      keyCol,
      notesCol: find(/remarque|commentaire|observation|^notes?$/),
      statusCol: find(/statut/),
      dateCols: sheet.dateCols.filter((i) => i < headers.length),
    };
    const isUpdate = L().rows.length > 0;
    if (isUpdate && !confirm(`Mettre à jour le listing avec « ${file.name} » ?\n\nLes informations du fichier (dont les remarques et statuts) remplaceront celles de l'outil. Une case vide dans le fichier n'efface pas une remarque ou un statut déjà saisi ici. Les formes dessinées sont conservées.`)) return;
    const old = project.listing;
    const oldIndex = rowIndex;
    const oldKeyOf = (r) => String(r[old.keyCol] == null ? "" : r[old.keyCol]).trim();
    // Colonnes absentes du fichier : on les crée et on reprend les valeurs de l'outil
    for (const [role, name] of [["notesCol", "Remarque"], ["statusCol", "STATUT PLAN"]]) {
      if (next[role] >= 0) continue;
      next.headers.push(name);
      next.rows.forEach((r) => r.push(null));
      next[role] = next.headers.length - 1;
      if (isUpdate && old[role] >= 0) {
        next.rows.forEach((r) => {
          const prev = oldIndex.has(String(r[keyCol] ?? "").trim()) ? old.rows[oldIndex.get(String(r[keyCol] ?? "").trim())] : null;
          if (prev) r[next[role]] = prev[old[role]];
        });
      }
    }
    // Remarques et statuts : une case vide dans le fichier n'efface pas ce
    // qui a été saisi dans l'outil (on ne perd jamais une note par erreur)
    let kept = 0;
    if (isUpdate) {
      for (const role of ["notesCol", "statusCol"]) {
        if (old[role] < 0) continue;
        next.rows.forEach((r) => {
          const k = String(r[keyCol] ?? "").trim();
          const prev = oldIndex.has(k) ? old.rows[oldIndex.get(k)] : null;
          if (prev && (r[next[role]] == null || r[next[role]] === "") && prev[old[role]] != null && prev[old[role]] !== "") {
            r[next[role]] = prev[old[role]];
            kept++;
          }
        });
      }
    }
    // « Local vide » = 1 → statut « Vide » (si pas déjà de statut)
    const vacantCol = find(/local vide|vacant/);
    const vide = project.statuses.find((s) => s.pattern === "veil") || statusByName("Vide");
    let autoVide = 0;
    if (vacantCol >= 0 && vide) {
      next.rows.forEach((r) => {
        if (!r[next.statusCol] && (r[vacantCol] === true || r[vacantCol] === 1 || /^(1|oui|x|vrai)$/i.test(String(r[vacantCol] ?? "").trim()))) {
          r[next.statusCol] = vide.name;
          autoVide++;
        }
      });
    }
    project.listing = next;
    reindex();
    const keysBefore = new Set(old.rows.map(oldKeyOf));
    const added = next.rows.filter((r) => !keysBefore.has(String(r[keyCol] ?? "").trim())).length;
    const orphans = project.lots.filter((l) => l.key && !rowIndex.has(l.key)).length;
    drawOverlay();
    renderSide();
    scheduleSave();
    toast(
      (isUpdate ? `Listing mis à jour : ${next.rows.length} lignes (${added} nouvelle${added > 1 ? "s" : ""})` : `Listing importé : ${next.rows.length} locaux (clé : ${headers[keyCol]})`) +
        (autoVide ? ` · ${autoVide} marqué${autoVide > 1 ? "s" : ""} « ${vide.name} »` : "") +
        (kept ? ` · ${kept} remarque(s)/statut(s) de l'outil conservé(s) (vides dans le fichier)` : "") +
        (orphans ? ` · ⚠️ ${orphans} forme${orphans > 1 ? "s" : ""} sans local correspondant` : ""),
      6000
    );
  } catch (ex) {
    console.error(ex);
    toast("Import Excel impossible : " + ex.message, 5000);
  }
});

$("#projectName").addEventListener("input", (e) => {
  project.name = e.target.value.trim() || "Plan sans nom";
  scheduleSave();
});
$("#backToList").addEventListener("click", async () => {
  await flushSave();
  location.hash = "";
});

/* ---------------- Enregistrement automatique ---------------- */
let saveTimer = null;
let saving = null;
let dirty = false;
function setSaveState(text, isError) {
  $("#saveState").textContent = text;
  $("#saveState").classList.toggle("is-error", !!isError);
}
function scheduleSave() {
  dirty = true;
  setSaveState("Modifications…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
}
async function save() {
  if (!project || !dirty) return;
  if (saving) {
    await saving;
    return save();
  }
  dirty = false;
  setSaveState("Enregistrement…");
  const body = JSON.stringify({ rev: project.rev, name: project.name, statuses: project.statuses, listing: project.listing, pages: project.pages, lots: project.lots });
  saving = fetch(`${API}/${project.id}`, { method: "PUT", body, headers: { "Content-Type": "application/json" } })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (r.status === 409) {
        alert("Ce plan a été modifié depuis un autre appareil ou un autre onglet. La dernière version enregistrée va être rechargée.");
        Object.assign(project, data.project);
        reindex();
        selectedKey = selectedShapeId = null;
        drawOverlay();
        renderSide();
        setSaveState("Rechargé");
        return;
      }
      if (!r.ok) throw new Error(data.error || "Erreur " + r.status);
      project.rev = data.rev;
      project.updatedAt = data.updatedAt;
      setSaveState(dirty ? "Modifications…" : "Enregistré ✓");
    })
    .catch(() => {
      dirty = true;
      setSaveState("⚠️ Non enregistré, nouvel essai…", true);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 5000);
    })
    .finally(() => (saving = null));
  await saving;
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (dirty) await save();
  if (saving) await saving;
}
window.addEventListener("beforeunload", (e) => {
  if (dirty || saving) e.preventDefault();
});

/* ==========================================================
   EXPORTS
   ========================================================== */
// Excel : le listing tel quel, avec statuts et remarques à jour → réimportable
$("#exportXlsx").addEventListener("click", async () => {
  await flushSave();
  const l = L();
  const sorted = l.rows.slice();
  const statusFill = (st) => (st ? (st.pattern === "veil" ? "#9e9e9e" : st.color) : null);
  const sheet = {
    name: l.sheetName || "Lots",
    columns: l.headers.map((h) => ({ header: h, width: Math.min(40, Math.max(10, h.length + 2)) })),
    rows: sorted.map((r) =>
      l.headers.map((_, i) => {
        const v = r[i];
        if (i === l.statusCol) {
          const st = rowStatus(r);
          return st ? { v: st.name, fill: statusFill(st) } : v;
        }
        if (l.dateCols.includes(i) && typeof v === "number") return { v, date: true };
        return v;
      })
    ),
  };
  if (l.notesCol >= 0) sheet.columns[l.notesCol].width = 45;
  const counts = project.statuses.map((s) => [{ v: s.name, fill: statusFill(s) }, l.rows.filter((r) => rowStatus(r) === s).length]);
  counts.push(["Sans statut", l.rows.filter((r) => keyOf(r) && !rowStatus(r)).length]);
  const synth = { name: "Synthèse", columns: [{ header: "Statut", width: 22 }, { header: "Nombre de locaux", width: 18 }], rows: counts };
  const base = (l.fileName || project.name).replace(/\.xlsx$/i, "");
  download(xlsx([sheet, synth]), `${fileSafe(base)} - à jour.xlsx`);
  toast("📊 Excel téléchargé : modifie-le si besoin puis réimporte-le avec « 📥 Importer l'Excel »", 5000);
});

$("#exportCopy").addEventListener("click", async () => {
  await flushSave();
  try {
    await downloadCopy(project);
  } catch (e) {
    toast("Erreur : " + e.message);
  }
});

// Motif « chantier » pour le PDF
function hatchPattern(ctx, color, size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = "#1a1a1a";
  g.lineWidth = size / 2.3;
  g.beginPath();
  for (let k = -size; k <= size * 2; k += size) {
    g.moveTo(k, 0);
    g.lineTo(k - size, size);
  }
  g.stroke();
  return ctx.createPattern(c, "repeat");
}

$("#exportPdf").addEventListener("click", async () => {
  const btn = $("#exportPdf");
  btn.disabled = true;
  const label = btn.textContent;
  try {
    await flushSave();
    const doc = new PdfDoc();
    const today = new Date().toLocaleDateString("fr-FR");
    const BAND = 64;
    const pages = visiblePages();
    for (const [idx, n] of pages.entries()) {
      btn.textContent = `⏳ Plan ${idx + 1}/${pages.length}…`;
      const page = await pdf.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 3600 / Math.max(vp1.width, vp1.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const shapes = project.lots.filter((l) => l.page === n && l.points.length >= 3 && rowOf(l.key));
      const counts = new Map();
      for (const lot of shapes) {
        const st = rowStatus(rowOf(lot.key));
        counts.set(st ? st.name : "", (counts.get(st ? st.name : "") || 0) + 1);
        ctx.beginPath();
        lot.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * canvas.width, y * canvas.height) : ctx.moveTo(x * canvas.width, y * canvas.height)));
        ctx.closePath();
        if (st) {
          ctx.globalAlpha = st.pattern === "solid" ? 0.55 : 0.85;
          ctx.fillStyle = st.pattern === "veil" ? "#ffffff" : st.pattern === "hatch" ? hatchPattern(ctx, st.color, Math.round(scale * 10)) : st.color;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = st.pattern === "veil" ? "#6b6b6b" : st.pattern === "hatch" ? "#1a1a1a" : st.color;
          ctx.lineWidth = Math.max(1.5, scale * 0.8);
          ctx.stroke();
        }
      }
      const fontPx = Math.round(Math.max(10, scale * 6));
      ctx.font = `700 ${fontPx}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      for (const lot of shapes) {
        const row = rowOf(lot.key);
        if (!rowStatus(row)) continue; // on n'étiquette que les lots qui ont un statut
        const [cx, cy] = centroid(lot.points);
        ctx.lineWidth = fontPx / 3.5;
        ctx.strokeStyle = "#fff";
        ctx.strokeText(rowLabel(row), cx * canvas.width, cy * canvas.height);
        ctx.fillStyle = "#111";
        ctx.fillText(rowLabel(row), cx * canvas.width, cy * canvas.height);
      }
      const jpeg = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88))).arrayBuffer());
      const w = Math.max(vp1.width, 420);
      const h = vp1.height * (w / vp1.width);
      const p = doc.addPage(w, h + BAND);
      p.image(jpeg, canvas.width, canvas.height, 0, BAND, w, h);
      p.line(0, BAND, w, BAND, "#cccccc", 0.5);
      p.text(project.name, 16, BAND - 22, 12, { bold: true });
      const right = `Plan ${idx + 1}/${pages.length} (page ${n}) · ${today}`;
      p.text(right, w - 16 - textWidth(right, 9), BAND - 22, 9, { color: "#666666" });
      let x = 16;
      for (const s of project.statuses) {
        if (!counts.get(s.name)) continue;
        const txt = `${s.name} (${counts.get(s.name)})`;
        if (x + 16 + textWidth(txt, 9) > w - 16) break;
        if (s.pattern === "hatch") {
          p.rect(x, BAND - 46, 12, 12, s.color, "#1a1a1a");
          p.line(x + 3, BAND - 46, x + 12, BAND - 37, "#1a1a1a", 2);
          p.line(x, BAND - 43, x + 9, BAND - 34, "#1a1a1a", 2);
        } else p.rect(x, BAND - 46, 12, 12, s.pattern === "veil" ? "#ffffff" : s.color, "#6b6b6b");
        p.text(txt, x + 16, BAND - 44, 9);
        x += 16 + textWidth(txt, 9) + 18;
      }
    }

    // Récapitulatif : les locaux qui ont un statut ou une remarque
    btn.textContent = "⏳ Récapitulatif…";
    const l = L();
    const pick = (re) => l.headers.findIndex((h) => re.test(norm(h)));
    const cols = [
      { h: l.headers[l.keyCol], w: 95, get: (r) => keyOf(r) },
      lotCol() >= 0 && { h: "Lot", w: 45, get: (r) => cellText(r, lotCol()) },
      pick(/type/) >= 0 && { h: "Type", w: 55, get: (r) => cellText(r, pick(/type/)) },
      pick(/surface/) >= 0 && { h: "Surface", w: 50, get: (r) => cellText(r, pick(/surface/)) },
      pick(/^etage$/) >= 0 && { h: "Étage", w: 45, get: (r) => cellText(r, pick(/^etage$/)) },
      { h: "Statut", w: 100, get: (r) => (rowStatus(r) ? rowStatus(r).name : ""), status: true },
      { h: "Remarque", w: 0, get: (r) => rowNotes(r) },
    ].filter(Boolean);
    const W = 841.89, H = 595.28, M = 28, ROW = 17;
    cols[cols.length - 1].w = W - 2 * M - cols.slice(0, -1).reduce((s, c) => s + c.w, 0);
    const fit = (s, width, size) => {
      s = String(s || "").replace(/\s+/g, " ");
      if (textWidth(s, size) <= width) return s;
      while (s && textWidth(s + "…", size) > width) s = s.slice(0, -1);
      return s + "…";
    };
    const rows = l.rows.filter((r) => keyOf(r) && (rowStatus(r) || rowNotes(r))).sort((a, b) => natural(keyOf(a), keyOf(b)));
    let page = null, y = 0;
    const newPage = () => {
      page = doc.addPage(W, H);
      page.text(`${project.name} — locaux avec un statut ou une remarque`, M, H - M - 8, 14, { bold: true });
      page.text(`${rows.length} local(aux) · ${today}`, M, H - M - 26, 9, { color: "#666666" });
      y = H - M - 52;
      let x = M;
      page.rect(M, y - 5, W - 2 * M, ROW, "#e3ebe6");
      for (const c of cols) {
        page.text(c.h, x + 4, y, 9, { bold: true });
        x += c.w;
      }
      y -= ROW;
    };
    newPage();
    rows.forEach((r, i) => {
      if (y < M + 10) newPage();
      if (i % 2) page.rect(M, y - 5, W - 2 * M, ROW, "#f6f8f7");
      let x = M;
      for (const c of cols) {
        let off = 4;
        if (c.status && rowStatus(r)) {
          const st = rowStatus(r);
          page.rect(x + 4, y - 1, 8, 8, st.pattern === "veil" ? "#ffffff" : st.color, "#6b6b6b");
          off = 16;
        }
        page.text(fit(c.get(r), c.w - off - 4, 9), x + off, y, 9);
        x += c.w;
      }
      y -= ROW;
    });
    if (!rows.length) page.text("Aucun local n'a encore de statut ni de remarque.", M, y, 10, { color: "#666666" });

    download(doc.save(), `${fileSafe(project.name)} - plan annoté.pdf`);
    toast("📄 PDF téléchargé");
  } catch (e) {
    console.error(e);
    toast("Erreur pendant la création du PDF : " + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* ---------------- Navigation ---------------- */
async function route() {
  const id = location.hash.slice(1);
  if (project && project.id !== id) await flushSave();
  if (/^[a-z0-9]{16}$/.test(id)) openProject(id);
  else showList();
}
window.addEventListener("hashchange", route);
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => pdf && !$("#editorView").hidden && renderPage(), 200);
});
route();
