/* ==========================================================
   Plans & lots — stockage sur le serveur
   dataDir/<id>/plan.pdf      le plan d'origine (jamais modifié)
   dataDir/<id>/project.json  nom, listing (tableau Excel), lots (formes
                              rattachées à une ligne du listing), statuts,
                              pages du PDF utilisées, révision

   GET    /projects            liste (résumé)
   POST   /projects?name=…     crée un projet (corps = le PDF)
   GET    /projects/<id>       le projet
   GET    /projects/<id>/plan.pdf
   PUT    /projects/<id>       enregistre (JSON) ; refusé (409) si une autre
                               fenêtre a enregistré entre-temps
   DELETE /projects/<id>
   ========================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PROJECT_JSON = 10 * 1024 * 1024;
// pattern : veil = voile blanc, hatch = hachures « chantier », solid = couleur unie
const DEFAULT_STATUSES = [
  { id: 'vide', name: 'Vide', color: '#ffffff', pattern: 'veil' },
  { id: 'travaux', name: 'En travaux', color: '#f2c200', pattern: 'hatch' },
  { id: 'nouvelle-version', name: 'Nouvelle version', color: '#d6249f', pattern: 'solid' },
];
const PATTERNS = ['veil', 'hatch', 'solid'];
// Listing par défaut (sans fichier Excel)
const DEFAULT_LISTING = { fileName: '', sheetName: 'Lots', headers: ['Local', 'N° de lot', 'Type', 'Surface', 'Remarque', 'STATUT PLAN'], rows: [], keyCol: 0, notesCol: 4, statusCol: 5, dateCols: [] };

const validId = (id) => /^[a-z0-9]{16}$/.test(id);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function readProject(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
}
function writeProject(dir, project) {
  // Écriture atomique : jamais de fichier à moitié écrit
  const tmp = path.join(dir, 'project.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(project));
  fs.renameSync(tmp, path.join(dir, 'project.json'));
}

// Ne garde que des champs connus, de taille raisonnable
function cleanLot(l) {
  const points = Array.isArray(l.points)
    ? l.points.slice(0, 200).filter((p) => Array.isArray(p) && p.length === 2 && p.every((n) => num(n) !== null && n >= -0.1 && n <= 1.1))
    : [];
  return {
    id: /^[a-z0-9]{6,24}$/.test(l.id) ? l.id : crypto.randomBytes(6).toString('hex'),
    page: Math.max(1, Math.min(9999, Math.round(num(l.page) || 1))),
    points,
    key: str(l.key, 200), // valeur de la colonne clé du listing (ex. IDLOCAL)
  };
}
function cleanStatuses(list) {
  if (!Array.isArray(list) || !list.length) return DEFAULT_STATUSES;
  return list.slice(0, 20).map((s) => ({
    id: /^[a-z0-9-]{1,40}$/.test(s.id) ? s.id : crypto.randomBytes(4).toString('hex'),
    name: str(s.name, 40) || 'Statut',
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#888888',
    pattern: PATTERNS.includes(s.pattern) ? s.pattern : 'solid',
  }));
}
const cell = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? v : typeof v === 'string' ? v.slice(0, 4000) : null);
function cleanListing(l) {
  if (!l || !Array.isArray(l.headers) || !l.headers.length) return DEFAULT_LISTING;
  const headers = l.headers.slice(0, 100).map((h, i) => str(h, 200) || `Colonne ${i + 1}`);
  const col = (v, fallback) => (Number.isInteger(v) && v >= 0 && v < headers.length ? v : fallback);
  return {
    fileName: str(l.fileName, 200),
    sheetName: str(l.sheetName, 100),
    headers,
    rows: (Array.isArray(l.rows) ? l.rows : []).slice(0, 10000).map((r) => headers.map((_, i) => cell(Array.isArray(r) ? r[i] : null))),
    keyCol: col(l.keyCol, 0),
    notesCol: col(l.notesCol, -1),
    statusCol: col(l.statusCol, -1),
    dateCols: (Array.isArray(l.dateCols) ? l.dateCols : []).filter((i) => Number.isInteger(i) && i >= 0 && i < headers.length),
  };
}
const cleanPages = (p) => (Array.isArray(p) ? [...new Set(p.filter((n) => Number.isInteger(n) && n >= 1 && n <= 9999))].sort((a, b) => a - b) : []);
const summary = (p) => {
  const counts = {};
  const L = p.listing;
  if (L && L.statusCol >= 0) for (const r of L.rows) if (r[L.statusCol]) counts[r[L.statusCol]] = (counts[r[L.statusCol]] || 0) + 1;
  return {
    id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
    lotCount: p.lots.length, rowCount: L ? L.rows.length : 0, counts, statuses: p.statuses,
  };
};

module.exports = async (req, res, ctx) => {
  const root = path.join(ctx.dataDir, 'projects');
  fs.mkdirSync(root, { recursive: true });
  const parts = ctx.path.split('/').filter(Boolean); // ["projects", id?, "plan.pdf"?]
  if (parts[0] !== 'projects') return ctx.fail(res, 404, 'Introuvable');

  // Liste
  if (parts.length === 1 && req.method === 'GET') {
    const list = [];
    for (const id of fs.readdirSync(root)) {
      if (!validId(id)) continue;
      try {
        list.push(summary(readProject(path.join(root, id))));
      } catch (e) {}
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return ctx.send(res, 200, list);
  }

  // Création : le corps est le PDF
  if (parts.length === 1 && req.method === 'POST') {
    const pdf = await ctx.readBody(req);
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') return ctx.fail(res, 400, "Ce fichier n'est pas un PDF");
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'plan.pdf'), pdf);
    const now = Date.now();
    const project = {
      id,
      name: str(ctx.url.searchParams.get('name'), 120) || 'Plan sans nom',
      fileName: str(ctx.url.searchParams.get('file'), 200),
      createdAt: now,
      updatedAt: now,
      rev: 1,
      statuses: DEFAULT_STATUSES,
      listing: DEFAULT_LISTING,
      pages: cleanPages((ctx.url.searchParams.get('pages') || '').split(',').map(Number)),
      lots: [],
    };
    writeProject(dir, project);
    return ctx.send(res, 201, project);
  }

  const id = parts[1];
  if (!validId(id)) return ctx.fail(res, 404, 'Projet introuvable');
  const dir = path.join(root, id);
  if (!fs.existsSync(path.join(dir, 'project.json'))) return ctx.fail(res, 404, 'Projet introuvable');

  if (parts.length === 3 && parts[2] === 'plan.pdf' && req.method === 'GET') {
    const st = fs.statSync(path.join(dir, 'plan.pdf'));
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400' });
    return fs.createReadStream(path.join(dir, 'plan.pdf')).pipe(res);
  }
  if (parts.length !== 2) return ctx.fail(res, 404, 'Introuvable');

  if (req.method === 'GET') return ctx.send(res, 200, readProject(dir));

  if (req.method === 'PUT') {
    const body = await ctx.readBody(req, MAX_PROJECT_JSON);
    let input;
    try {
      input = JSON.parse(body.toString('utf8'));
    } catch (e) {
      return ctx.fail(res, 400, 'JSON invalide');
    }
    const current = readProject(dir);
    if (input.rev !== current.rev) {
      return ctx.send(res, 409, { error: 'Ce plan a été modifié ailleurs entre-temps', project: current });
    }
    const project = Object.assign(current, {
      name: str(input.name, 120) || current.name,
      statuses: cleanStatuses(input.statuses),
      listing: input.listing ? cleanListing(input.listing) : current.listing,
      pages: input.pages ? cleanPages(input.pages) : current.pages,
      lots: Array.isArray(input.lots) ? input.lots.slice(0, 5000).map(cleanLot) : current.lots,
      updatedAt: Date.now(),
      rev: current.rev + 1,
    });
    writeProject(dir, project);
    return ctx.send(res, 200, project);
  }

  if (req.method === 'DELETE') {
    fs.rmSync(dir, { recursive: true, force: true });
    return ctx.send(res, 200, { ok: true });
  }
  return ctx.fail(res, 405, 'Méthode non autorisée');
};
