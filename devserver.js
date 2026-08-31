// Dev server: serves the UI plus a JSON API over the scanner/swap core.
// The Electron shell (next milestone) will reuse the same core modules.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getInstall } from './core/scanner.js';
import { flatImage, parseColor } from './core/gen.js';
import { encodePng, resizeRgba } from './core/thumbs.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(ROOT, 'ui');
const PORT = Number(process.env.PORT || 5892);
const DEFAULT_DIR = 'C:\\AQ2mapping\\AQ2';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch (e) { reject(new Error('bad JSON body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function scanResult(inst) {
  return {
    root: inst.root,
    gameDirs: inst.gameDirs,
    writeDir: inst.writeDir,
    sources: inst.fs.describeSources(),
    warnings: inst.fs.warnings,
    hasPalette: Boolean(inst.palette),
    hook: inst.swaps.hookStatus(),
    swapsEnabled: inst.swaps.enabled,
    maps: inst.listMaps(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, url, res);

    let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } catch (e) {
    console.error(`[error] ${req.url}: ${e.message}`);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

async function handleApi(req, url, res) {
  const q = url.searchParams;

  if (req.method === 'POST') {
    const body = await readBody(req);
    const inst = getInstall(body.dir || DEFAULT_DIR);
    switch (url.pathname) {
      case '/api/swap': {
        if (!body.map || !body.from) return json(res, 400, { error: 'need map and from' });
        if (body.spec) {
          if (body.spec.type === 'stock') {
            if (!inst.fs.findFirst('textures/' + body.spec.to, ['.png', '.tga', '.jpg', '.wal', '.pcx'])) {
              return json(res, 400, { error: 'replacement texture not found: ' + body.spec.to });
            }
          } else if (body.spec.type === 'flat') {
            try { parseColor(body.spec.color); }
            catch (e) { return json(res, 400, { error: e.message }); }
          } else {
            return json(res, 400, { error: 'unknown swap type' });
          }
        }
        const result = inst.swaps.setSwap(body.map, body.from, body.spec || null);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map) });
      }
      case '/api/sky': {
        if (!body.map) return json(res, 400, { error: 'need map' });
        const result = inst.swaps.setSky(body.map, body.to || null);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map) });
      }
      case '/api/reset': {
        if (!body.map) return json(res, 400, { error: 'need map' });
        const result = inst.swaps.resetMap(body.map);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map) });
      }
      case '/api/hook': {
        const status = inst.swaps.installHook();
        return json(res, 200, { ok: true, hook: status });
      }
      case '/api/enabled': {
        const result = inst.swaps.setEnabled(body.enabled);
        return json(res, 200, { ok: true, ...result, enabled: inst.swaps.enabled });
      }
      case '/api/preset/save': {
        const name = inst.swaps.savePreset(body.map, body.name);
        return json(res, 200, { ok: true, name, detail: inst.mapDetail(body.map) });
      }
      case '/api/preset/load': {
        const result = inst.swaps.loadPreset(body.map, body.name);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map) });
      }
      case '/api/preset/delete': {
        inst.swaps.deletePreset(body.map, body.name);
        return json(res, 200, { ok: true, detail: inst.mapDetail(body.map) });
      }
      case '/api/export': {
        const { obj, file } = inst.swaps.exportMap(body.map);
        return json(res, 200, { ok: true, file, data: obj });
      }
      case '/api/import': {
        const result = inst.swaps.importMap(body.data);
        return json(res, 200, { ok: true, ...result });
      }
      default:
        return json(res, 404, { error: 'unknown api route' });
    }
  }

  const dir = q.get('dir') || DEFAULT_DIR;
  switch (url.pathname) {
    case '/api/defaults':
      return json(res, 200, { dir: DEFAULT_DIR });

    case '/api/scan':
      return json(res, 200, scanResult(getInstall(dir, q.get('refresh') === '1')));

    case '/api/map': {
      const name = q.get('name');
      if (!name) return json(res, 400, { error: 'missing ?name=' });
      return json(res, 200, getInstall(dir).mapDetail(name));
    }

    case '/api/textures':
      return json(res, 200, { textures: getInstall(dir).listTextures() });

    case '/api/skies':
      return json(res, 200, { skies: getInstall(dir).listSkies() });

    case '/api/thumb': {
      const inst = getInstall(dir);
      const size = Math.min(512, Number(q.get('size')) || 128);
      let png = null;
      if (q.get('tex')) png = inst.thumbPng('textures/' + q.get('tex'), size);
      else if (q.get('sky')) png = inst.skyThumbPng(q.get('sky'), size);
      else if (q.get('flat')) {
        try {
          png = encodePng(resizeRgba(flatImage(q.get('flat'), q.get('style') || 'solid'), size));
        } catch { png = null; }
      } else return json(res, 400, { error: 'missing ?tex=, ?sky= or ?flat=' });
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
  console.log(`Default install: ${DEFAULT_DIR}`);
});
