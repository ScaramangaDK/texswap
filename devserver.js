// Dev server: serves the UI plus a JSON API over the scanner/swap core.
// The Electron shell (next milestone) will reuse the same core modules.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getInstall, setModChoice } from './core/scanner.js';
import { flatImage, parseColor } from './core/gen.js';
import { encodePng } from './core/thumbs.js';

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
    game: inst.game,
    mods: inst.mods,
    activeMod: inst.activeMod,
    sources: inst.fs.describeSources(),
    warnings: inst.fs.warnings,
    hasPalette: Boolean(inst.palette),
    hook: inst.swaps.hookStatus(),
    swapsEnabled: inst.swaps.enabled,
    lighting: inst.swaps.lightingConfig(),
    missingFix: inst.swaps.missingFixConfig(),
    favTextures: inst.swaps.favTextures(),
    favSets: inst.swaps.favSets(),
    maps: inst.listMaps(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, url, res);

    if (url.pathname.startsWith('/vendor/')) {
      const name = url.pathname.slice('/vendor/'.length);
      if (!/^[a-z0-9_.-]+\.js$/i.test(name)) { res.writeHead(404); return res.end(); }
      const vfile = path.join(ROOT, 'node_modules', 'three', 'build', name);
      if (!fs.existsSync(vfile)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=3600' });
      return res.end(fs.readFileSync(vfile));
    }

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
    const lowRes = body.res === 'low';
    switch (url.pathname) {
      case '/api/upload': {
        if (!body.map || !body.from || !body.filename || !body.dataB64) {
          return json(res, 400, { error: 'need map, from, filename and dataB64' });
        }
        const buf = Buffer.from(body.dataB64, 'base64');
        if (buf.length > 16 * 1024 * 1024) return json(res, 400, { error: 'image too large (max 16 MB)' });
        const result = inst.swaps.setCustomSwap(body.map, body.from, body.filename, buf);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map, lowRes) });
      }
      case '/api/texdims': {
        if (!Array.isArray(body.names)) return json(res, 400, { error: 'need names[]' });
        return json(res, 200, { dims: inst.texDims(body.names.map(String), lowRes) });
      }
      case '/api/setmod': {
        setModChoice(body.dir || DEFAULT_DIR, body.mod || null);
        getInstall(body.dir || DEFAULT_DIR, true); // fresh install, async rescan
        return json(res, 200, { ok: true });
      }
      case '/api/missingfix': {
        try {
          const result = inst.swaps.setMissingFix(body || {});
          return json(res, 200, { ok: true, ...result, missingFix: inst.swaps.missingFixConfig() });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      case '/api/favtex': {
        if (!body.name) return json(res, 400, { error: 'need name' });
        const favTextures = inst.swaps.setFavTexture(body.name, Boolean(body.fav));
        return json(res, 200, { ok: true, favTextures });
      }
      case '/api/favset': {
        if (!body.action || !body.set) return json(res, 400, { error: 'need action and set' });
        try {
          const r = inst.swaps.modifyFavSet(body.action, body.set, body.name);
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      case '/api/swap': {
        if (!body.map || !body.from) return json(res, 400, { error: 'need map and from' });
        if (body.spec) {
          if (body.spec.type === 'stock') {
            if (!inst.fs.findFirst('textures/' + body.spec.to, ['.png', '.tga', '.jpg', '.wal', '.pcx'])) {
              return json(res, 400, { error: 'replacement texture not found: ' + body.spec.to });
            }
          } else if (body.spec.type === 'flat') {
            try {
              parseColor(body.spec.color);
              if (body.spec.color2) parseColor(body.spec.color2);
            } catch (e) { return json(res, 400, { error: e.message }); }
            if (body.spec.scale !== undefined) {
              const sc = Number(body.spec.scale);
              if (!Number.isFinite(sc) || sc < 0.25 || sc > 8) return json(res, 400, { error: 'bad pattern scale' });
            }
          } else {
            return json(res, 400, { error: 'unknown swap type' });
          }
        }
        const result = inst.swaps.setSwap(body.map, body.from, body.spec || null);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map, lowRes) });
      }
      case '/api/sky': {
        if (!body.map) return json(res, 400, { error: 'need map' });
        const result = inst.swaps.setSky(body.map, body.to || null);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map, lowRes) });
      }
      case '/api/reset': {
        if (!body.map) return json(res, 400, { error: 'need map' });
        const result = inst.swaps.resetMap(body.map);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map, lowRes) });
      }
      case '/api/hook': {
        const status = inst.swaps.installHook();
        return json(res, 200, { ok: true, hook: status });
      }
      case '/api/launchgame': {
        if (!body.map || !/^[a-z0-9_.-]+$/i.test(body.map)) {
          return json(res, 400, { error: 'bad map name' });
        }
        const exe = ['q2pro.exe', 'aqtion.exe', 'quake2.exe']
          .map(n => path.join(inst.root, n))
          .find(p => fs.existsSync(p));
        if (!exe) return json(res, 400, { error: 'no q2pro.exe / aqtion.exe / quake2.exe found in ' + inst.root });
        const args = inst.activeMod ? ['+set', 'game', inst.activeMod, '+map', body.map] : ['+map', body.map];
        if (body.dry) return json(res, 200, { ok: true, exe, args, launched: false });
        try {
          const child = spawn(exe, args, { cwd: inst.root, detached: true, stdio: 'ignore' });
          child.unref();
          return json(res, 200, { ok: true, exe, args, launched: true });
        } catch (e) {
          return json(res, 500, { error: 'launch failed: ' + e.message });
        }
      }
      case '/api/enabled': {
        const result = inst.swaps.setEnabled(body.enabled);
        return json(res, 200, { ok: true, ...result, enabled: inst.swaps.enabled });
      }
      case '/api/lighting': {
        const result = inst.swaps.setLighting(body.lighting);
        return json(res, 200, { ok: true, ...result, lighting: inst.swaps.lightingConfig() });
      }
      case '/api/maplighting': {
        if (!body.map) return json(res, 400, { error: 'need map' });
        const result = inst.swaps.setMapLighting(body.map, body.lighting);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map, lowRes) });
      }
      case '/api/preset/save': {
        const name = inst.swaps.savePreset(body.map, body.name);
        return json(res, 200, { ok: true, name, detail: inst.mapDetail(body.map, lowRes) });
      }
      case '/api/preset/load': {
        const result = inst.swaps.loadPreset(body.map, body.name);
        return json(res, 200, { ok: true, ...result, detail: inst.mapDetail(body.map, lowRes) });
      }
      case '/api/preset/delete': {
        inst.swaps.deletePreset(body.map, body.name);
        return json(res, 200, { ok: true, detail: inst.mapDetail(body.map, lowRes) });
      }
      case '/api/export': {
        const { obj, file } = inst.swaps.exportMap(body.map);
        return json(res, 200, { ok: true, file, data: obj });
      }
      case '/api/exportpack': {
        try {
          if (body.list) return json(res, 200, { ok: true, maps: inst.swaps.packableMaps() });
          return json(res, 200, { ok: true, ...inst.swaps.exportPack(body.maps || null) });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      case '/api/import': {
        const result = body.data && body.data.kind === 'pack'
          ? inst.swaps.importPack(body.data)
          : inst.swaps.importMap(body.data);
        return json(res, 200, { ok: true, ...result });
      }
      default:
        return json(res, 404, { error: 'unknown api route' });
    }
  }

  const dir = q.get('dir') || DEFAULT_DIR;
  switch (url.pathname) {
    case '/api/defaults':
      return json(res, 200, { dir: fs.existsSync(DEFAULT_DIR) ? DEFAULT_DIR : '' });

    case '/api/scan': {
      const inst = getInstall(dir, q.get('refresh') === '1');
      if (!inst.mapsCache) {
        // first scan of a big install takes 10s+: run it async and let the
        // UI poll for progress instead of hanging on a dead request
        if (!inst.scanPromise) {
          inst.scanPromise = inst.scanMapsAsync().catch(e => { inst.scanError = e.message; });
        }
        if (inst.scanError) return json(res, 500, { error: inst.scanError });
        return json(res, 200, { scanning: true, progress: inst.scanProgress || { done: 0, total: 0 } });
      }
      return json(res, 200, scanResult(inst));
    }

    case '/api/map': {
      const name = q.get('name');
      if (!name) return json(res, 400, { error: 'missing ?name=' });
      return json(res, 200, getInstall(dir).mapDetail(name, q.get('res') === 'low'));
    }

    case '/api/browse': {
      const p = q.get('path');
      if (!p) {
        const drives = [];
        for (let c = 65; c <= 90; c++) {
          const d = String.fromCharCode(c) + ':\\';
          if (fs.existsSync(d)) drives.push({ name: d, path: d });
        }
        return json(res, 200, { path: null, parent: null, dirs: drives, looksLikeInstall: false });
      }
      const abs = path.resolve(p);
      let items;
      try { items = fs.readdirSync(abs, { withFileTypes: true }); }
      catch (e) { return json(res, 400, { error: 'cannot open folder: ' + e.message }); }
      const dirs = items
        .filter(it => it.isDirectory())
        .map(it => ({ name: it.name, path: path.join(abs, it.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));
      const names = items.map(it => it.name.toLowerCase());
      const looksLikeInstall = names.includes('action') || names.includes('baseaq') ||
        names.some(n => n.endsWith('.pkz')) || names.includes('q2pro.exe') || names.includes('aqtion.exe');
      const parent = path.dirname(abs) === abs ? null : path.dirname(abs);
      return json(res, 200, { path: abs, parent, dirs, looksLikeInstall });
    }

    case '/api/mapgeo': {
      const name = q.get('name');
      if (!name) return json(res, 400, { error: 'missing ?name=' });
      return json(res, 200, getInstall(dir).mapGeometry(name).geo);
    }

    case '/api/maplight': {
      const name = q.get('name');
      if (!name) return json(res, 400, { error: 'missing ?name=' });
      const { atlasPng } = getInstall(dir).mapGeometry(name);
      if (!atlasPng) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=300' });
      return res.end(atlasPng);
    }

    case '/api/textures':
      return json(res, 200, { textures: getInstall(dir).listTextures() });

    case '/api/skies':
      return json(res, 200, { skies: getInstall(dir).listSkies() });

    case '/api/skyface': {
      const png = getInstall(dir).skyFacePng(q.get('sky') || '', q.get('face') || '');
      if (!png) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' });
      return res.end(png);
    }

    case '/api/palette': {
      // the install's Quake 2 palette (colormap.pcx) as 256 hex colors
      const p = getInstall(dir).palette;
      const colors = [];
      if (p) {
        for (let i = 0; i < 256; i++) {
          colors.push('#' + (((p[i * 3] << 16) | (p[i * 3 + 1] << 8) | p[i * 3 + 2]) + 0x1000000).toString(16).slice(1));
        }
      }
      return json(res, 200, { colors });
    }

    case '/api/thumb': {
      const inst = getInstall(dir);
      const size = Math.min(512, Number(q.get('size')) || 128);
      let png = null;
      if (q.get('tex')) {
        png = inst.thumbPng('textures/' + q.get('tex'), size, q.get('res') === 'low', q.get('alpha') === '1')
          || inst.placeholderPng(size);
      }
      else if (q.get('custom')) png = inst.customThumbPng(q.get('custom'), size);
      else if (q.get('sky')) png = inst.skyThumbPng(q.get('sky'), size);
      else if (q.get('flat')) {
        // generate at the requested size directly - resampling a fixed-size
        // pattern makes thin grid lines look broken
        try {
          png = encodePng(flatImage(q.get('flat'), q.get('style') || 'solid', size, q.get('color2') || null, Number(q.get('scale')) || 1));
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

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Ralle's Texture Swapper is already running - just open http://127.0.0.1:${PORT}`);
    // inside Electron, keep the window alive and reuse the running server
    if (!process.env.AQ2TS_ELECTRON) process.exit(0);
    return;
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Ralle's Texture Swapper dev server on http://127.0.0.1:${PORT}`);
  console.log(`Default install: ${DEFAULT_DIR}`);
});
