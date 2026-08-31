// Dev server: serves the UI plus a JSON API over the scanner core.
// The Electron shell (next milestone) will reuse the same core modules.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getInstall } from './core/scanner.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(ROOT, 'ui');
const PORT = Number(process.env.PORT || 5892);
const DEFAULT_DIR = 'C:\\AQ2mapping\\AQ2\\baseaq';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return handleApi(url, res);

    // static UI
    let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } catch (e) {
    console.error(`[error] ${req.url}: ${e.message}`);
    json(res, 500, { error: e.message });
  }
});

function handleApi(url, res) {
  const dir = url.searchParams.get('dir') || DEFAULT_DIR;

  switch (url.pathname) {
    case '/api/defaults':
      return json(res, 200, { dir: DEFAULT_DIR });

    case '/api/scan': {
      const refresh = url.searchParams.get('refresh') === '1';
      const inst = getInstall(dir, refresh);
      return json(res, 200, {
        gameDir: inst.gameDir,
        sources: inst.fs.describeSources(),
        warnings: inst.fs.warnings,
        hasPalette: Boolean(inst.palette),
        maps: inst.listMaps(),
      });
    }

    case '/api/map': {
      const name = url.searchParams.get('name');
      if (!name) return json(res, 400, { error: 'missing ?name=' });
      return json(res, 200, getInstall(dir).mapDetail(name));
    }

    case '/api/thumb': {
      const inst = getInstall(dir);
      const tex = url.searchParams.get('tex');
      const sky = url.searchParams.get('sky');
      const size = Math.min(512, Number(url.searchParams.get('size')) || 128);
      let png = null;
      if (tex) png = inst.thumbPng('textures/' + tex, size);
      else if (sky) png = inst.skyThumbPng(sky, size);
      else return json(res, 400, { error: 'missing ?tex= or ?sky=' });
      if (!png) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' });
      return res.end(png);
    }

    default:
      return json(res, 404, { error: 'unknown api route' });
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AQ2 Texture Swapper dev server on http://127.0.0.1:${PORT}`);
  console.log(`Default game dir: ${DEFAULT_DIR}`);
});
