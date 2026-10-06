/* ==========================================================
   🧰  Boîte à outils — serveur du portail
   Node ≥ 22, zéro dépendance.

   - Sert le portail (public/) et chaque outil (tools/<id>/)
   - GET /api/config : nom de l'appli et catégories (config.json)
   - GET /api/tools  : la liste des outils, lue dans tools/<id>/tool.json
   - Un outil peut avoir une partie serveur : tools/<id>/api.js
     (module.exports = async (req, res, ctx) => …), appelée sur
     /api/tools/<id>/…

   L'accès est protégé en amont par Traefik (mot de passe partagé).
   ========================================================== */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TOOLS_DIR = path.join(ROOT, 'tools');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const MAX_BODY = 50 * 1024 * 1024; // pour les futurs outils qui reçoivent des fichiers

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- Outils ---------------- */
// Chaque dossier tools/<id>/ contenant un tool.json est un outil.
function loadTools() {
  const tools = [];
  for (const id of fs.readdirSync(TOOLS_DIR).sort()) {
    if (id.startsWith('_') || !/^[a-z0-9-]+$/.test(id)) continue;
    const manifest = path.join(TOOLS_DIR, id, 'tool.json');
    if (!fs.existsSync(manifest)) continue;
    try {
      const t = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const apiFile = path.join(TOOLS_DIR, id, 'api.js');
      tools.push({
        id,
        name: t.name || id,
        icon: t.icon || '🔧',
        category: t.category || 'divers',
        description: t.description || '',
        status: t.status || 'ready', // ready | soon
        keywords: t.keywords || [],
        api: fs.existsSync(apiFile) ? require(apiFile) : null,
      });
    } catch (e) {
      console.error(`Outil ${id} ignoré : ${e.message}`);
    }
  }
  return tools;
}
const TOOLS = loadTools();
const publicTool = ({ api, ...t }) => Object.assign(t, { hasApi: !!api, url: `/outils/${t.id}/` });

/* ---------------- HTTP ---------------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const fail = (res, status, error) => send(res, status, { error });

// Lecture du corps de requête, à disposition des outils (ctx.readBody)
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Fichier trop volumineux'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
function serveFile(req, res, baseDir, relPath) {
  const file = path.join(baseDir, path.normalize('/' + relPath));
  if (!file.startsWith(baseDir + path.sep)) return notFound(res);
  if (path.basename(file) === 'api.js') return notFound(res); // le code serveur des outils reste privé
  fs.stat(file, (err, st) => {
    if (err) return notFound(res);
    if (st.isDirectory()) return serveFile(req, res, baseDir, path.join(relPath, 'index.html'));
    const lastModified = st.mtime.toUTCString();
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Last-Modified': lastModified,
    };
    if (req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Introuvable');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/api/config') return send(res, 200, CONFIG);
    if (p === '/api/tools') return send(res, 200, TOOLS.map(publicTool));

    // API d'un outil : /api/tools/<id>/…
    const m = /^\/api\/tools\/([a-z0-9-]+)(\/.*)?$/.exec(p);
    if (m) {
      const tool = TOOLS.find((t) => t.id === m[1]);
      if (!tool || !tool.api) return fail(res, 404, 'Outil introuvable');
      const toolData = path.join(DATA_DIR, tool.id);
      fs.mkdirSync(toolData, { recursive: true });
      return await tool.api(req, res, { path: m[2] || '/', url, send, fail, readBody, dataDir: toolData });
    }
    if (p.startsWith('/api/')) return fail(res, 404, 'Introuvable');

    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);

    // Pages d'un outil : /outils/<id>/…
    const t = /^\/outils\/([a-z0-9-]+)(\/.*)?$/.exec(p);
    if (t) {
      if (!t[2]) {
        res.writeHead(301, { Location: `/outils/${t[1]}/` });
        return res.end();
      }
      if (!TOOLS.some((x) => x.id === t[1])) return notFound(res);
      return serveFile(req, res, path.join(TOOLS_DIR, t[1]), t[2]);
    }
    return serveFile(req, res, PUBLIC_DIR, p === '/' ? 'index.html' : p);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Erreur serveur');
  }
});

server.listen(PORT, () => console.log(`🧰 ${CONFIG.name} en écoute sur :${PORT} — ${TOOLS.length} outil(s)`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
