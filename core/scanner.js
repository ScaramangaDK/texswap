// Install — one opened AQ2/AQtion install (root + layered game dirs) with
// cached scan results and its swap store.
import path from 'node:path';
import fs from 'node:fs';
import { GameFS } from './vfs.js';
import { parseBsp, flagNames } from './bsp.js';
import { decodePcx } from './decoders.js';
import { makeThumbPng, resolveImage, TEXTURE_EXTS } from './thumbs.js';
import { imageSize } from './decoders.js';
import { SwapStore } from './swaps.js';

const SURF_SKY = 4;
const SURF_NODRAW = 128;
const GAME_DIR_ORDER = ['action', 'baseaq', 'baseq2'];

// Map "message" strings contain literal \n sequences, real newlines, and Q2 color chars.
function cleanTitle(msg) {
  return (msg || '')
    .replaceAll('\\n', ' ')
    .split('\n')[0]
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasGameContent(dirAbs) {
  try {
    return fs.readdirSync(dirAbs).some(n =>
      /\.(pak|pkz)$/i.test(n) || ['maps', 'textures', 'env'].includes(n.toLowerCase()));
  } catch {
    return false;
  }
}

// Accepts either the install root (containing action/ and/or baseaq/) or a
// game dir itself; returns { root, dirs } with dirs highest-priority first,
// mirroring the engine's mod-over-base layering.
export function detectInstall(inputDir) {
  const abs = path.resolve(inputDir);
  let root = abs;
  if (GAME_DIR_ORDER.includes(path.basename(abs).toLowerCase())) {
    root = path.dirname(abs);
  }
  const dirs = GAME_DIR_ORDER.filter(d => hasGameContent(path.join(root, d)));
  if (dirs.length) return { root, dirs };
  if (hasGameContent(abs)) {
    return { root: path.dirname(abs), dirs: [path.basename(abs)] };
  }
  throw new Error('no AQ2 game content found at ' + inputDir);
}

export class Install {
  constructor(inputDir) {
    const { root, dirs } = detectInstall(inputDir);
    this.root = root;
    this.gameDirs = dirs;
    this.writeDir = path.join(root, dirs[0]);
    this.fs = new GameFS(root, dirs);
    this.palette = this.#loadPalette();
    this.bspCache = new Map();
    this.thumbCache = new Map();
    this.texCatalog = null;
    this.skyCatalog = null;
    this.swaps = new SwapStore(this);
  }

  #loadPalette() {
    const buf = this.fs.read('pics/colormap.pcx');
    if (!buf) return null;
    try {
      const pcx = decodePcx(buf);
      return pcx.palette ? Buffer.from(pcx.palette) : null;
    } catch {
      return null;
    }
  }

  #parseMap(bspPath) {
    if (this.bspCache.has(bspPath)) return this.bspCache.get(bspPath);
    let parsed;
    try {
      parsed = parseBsp(this.fs.read(bspPath));
    } catch (e) {
      parsed = { error: e.message };
    }
    this.bspCache.set(bspPath, parsed);
    return parsed;
  }

  #mapPath(mapName) {
    return this.fs.list(x => x.startsWith('maps/') && x.endsWith('.bsp'))
      .find(p => path.basename(p, '.bsp') === mapName.toLowerCase());
  }

  listMaps() {
    const maps = [];
    for (const p of this.fs.list(x => x.startsWith('maps/') && x.endsWith('.bsp'))) {
      const name = path.basename(p, '.bsp');
      const parsed = this.#parseMap(p);
      if (parsed.error) {
        maps.push({ name, file: p, source: this.fs.sourceOf(p), error: parsed.error });
        continue;
      }
      maps.push({
        name,
        file: p,
        source: this.fs.sourceOf(p),
        title: cleanTitle(parsed.worldspawn.message),
        sky: parsed.worldspawn.sky || null,
        extended: parsed.extended,
        textureCount: parsed.textures.length,
        swapCount: this.swaps.swapCount(name),
      });
    }
    maps.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return maps;
  }

  mapDetail(mapName) {
    const bspPath = this.#mapPath(mapName);
    if (!bspPath) throw new Error('map not found: ' + mapName);
    const parsed = this.#parseMap(bspPath);
    if (parsed.error) throw new Error(parsed.error);

    const { swaps, sky: skySwap } = this.swaps.swapsFor(mapName);

    let totalArea = 0;
    for (const t of parsed.textures) {
      if (t.flags & (SURF_SKY | SURF_NODRAW)) continue;
      totalArea += t.area;
    }

    const textures = parsed.textures.map(t => {
      const hit = resolveImage(this.fs, 'textures/' + t.name);
      let dims = null;
      if (hit) {
        const buf = this.fs.read(hit.path);
        dims = imageSize(buf, hit.ext);
      }
      const utility = Boolean(t.flags & (SURF_SKY | SURF_NODRAW)) ||
        /(^|\/)(clip|hint|skip|trigger|origin|null)$/.test(t.name);
      return {
        name: t.name,
        faces: t.faces,
        area: Math.round(t.area),
        areaPct: totalArea > 0 && !utility ? +(t.area / totalArea * 100).toFixed(2) : 0,
        w: dims ? dims.w : null,
        h: dims ? dims.h : null,
        ext: hit ? hit.ext : null,
        source: hit ? hit.source : null,
        missing: !hit,
        utility,
        flags: flagNames(t.flags),
        swap: swaps[t.name] || null,
      };
    });
    textures.sort((a, b) => b.area - a.area || b.faces - a.faces);

    return {
      name: mapName,
      file: bspPath,
      source: this.fs.sourceOf(bspPath),
      title: cleanTitle(parsed.worldspawn.message),
      sky: parsed.worldspawn.sky || null,
      skySwap: skySwap ? skySwap.to : null,
      swapCount: this.swaps.swapCount(mapName),
      savedPresets: this.swaps.savedPresetNames(mapName),
      swapsEnabled: this.swaps.enabled,
      extended: parsed.extended,
      warnings: parsed.warnings,
      hasPalette: Boolean(this.palette),
      textures,
    };
  }

  // All textures available anywhere in the install, for the picker.
  listTextures() {
    if (this.texCatalog) return this.texCatalog;
    const best = new Map(); // base name -> ext (by TEXTURE_EXTS preference)
    for (const p of this.fs.list(x => x.startsWith('textures/'))) {
      const ext = path.extname(p);
      const rank = TEXTURE_EXTS.indexOf(ext);
      if (rank < 0) continue;
      const base = p.slice('textures/'.length, -ext.length);
      const prev = best.get(base);
      if (prev === undefined || rank < prev.rank) {
        best.set(base, { rank, ext, source: this.fs.sourceOf(p) });
      }
    }
    this.texCatalog = [...best.entries()]
      .map(([name, v]) => ({ name, ext: v.ext, source: v.source }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return this.texCatalog;
  }

  // All skyboxes (env/<name><face>.<ext> sets).
  listSkies() {
    if (this.skyCatalog) return this.skyCatalog;
    const sets = new Map();
    const re = /^env\/(.+)(rt|lf|ft|bk|up|dn)\.(tga|png|jpg|pcx)$/;
    for (const p of this.fs.list(x => x.startsWith('env/'))) {
      const m = re.exec(p);
      if (!m) continue;
      let s = sets.get(m[1]);
      if (!s) { s = { faces: new Set(), exts: new Set() }; sets.set(m[1], s); }
      s.faces.add(m[2]);
      s.exts.add(m[3]);
    }
    this.skyCatalog = [...sets.entries()]
      .map(([name, s]) => ({ name, faces: s.faces.size, exts: [...s.exts] }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return this.skyCatalog;
  }

  thumbPng(basePath, maxDim = 128) {
    const key = basePath.toLowerCase() + '@' + maxDim;
    if (this.thumbCache.has(key)) return this.thumbCache.get(key);
    let png = null;
    try {
      png = makeThumbPng(this.fs, basePath, this.palette, maxDim);
    } catch {
      png = null;
    }
    this.thumbCache.set(key, png);
    return png;
  }

  skyThumbPng(skyName, maxDim = 128) {
    return this.thumbPng('env/' + skyName + 'ft', maxDim) ||
      this.thumbPng('env/' + skyName + 'bk', maxDim);
  }
}

const installs = new Map();

export function getInstall(inputDir, refresh = false) {
  const { root, dirs } = detectInstall(inputDir);
  const key = (root + '|' + dirs.join(',')).toLowerCase();
  if (refresh || !installs.has(key)) {
    installs.set(key, new Install(inputDir));
  }
  return installs.get(key);
}
