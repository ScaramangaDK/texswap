// Install — one opened AQ2/AQtion game dir with cached scan results.
import path from 'node:path';
import fs from 'node:fs';
import { GameFS } from './vfs.js';
import { parseBsp, flagNames } from './bsp.js';
import { decodePcx } from './decoders.js';
import { makeThumbPng, sizeOf } from './thumbs.js';

const SURF_SKY = 4;
const SURF_NODRAW = 128;

// Map "message" strings contain literal \n sequences, real newlines, and Q2 color chars.
function cleanTitle(msg) {
  return (msg || '')
    .replaceAll('\\n', ' ')
    .split('\n')[0]
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Install {
  constructor(gameDir) {
    if (!fs.existsSync(gameDir) || !fs.statSync(gameDir).isDirectory()) {
      throw new Error('not a directory: ' + gameDir);
    }
    this.gameDir = gameDir;
    this.fs = new GameFS(gameDir);
    this.palette = this.#loadPalette();
    this.bspCache = new Map();   // map name -> parsed data or {error}
    this.thumbCache = new Map(); // basePath -> png Buffer|null
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
      });
    }
    maps.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return maps;
  }

  mapDetail(mapName) {
    const bspPath = this.fs.list(x => x.startsWith('maps/') && x.endsWith('.bsp'))
      .find(p => path.basename(p, '.bsp') === mapName.toLowerCase());
    if (!bspPath) throw new Error('map not found: ' + mapName);
    const parsed = this.#parseMap(bspPath);
    if (parsed.error) throw new Error(parsed.error);

    // Total drawable area for percentages (skip sky + nodraw surfaces)
    let totalArea = 0;
    for (const t of parsed.textures) {
      if (t.flags & (SURF_SKY | SURF_NODRAW)) continue;
      totalArea += t.area;
    }

    const textures = parsed.textures.map(t => {
      const dims = sizeOf(this.fs, 'textures/' + t.name);
      const utility = Boolean(t.flags & (SURF_SKY | SURF_NODRAW)) ||
        /(^|\/)(clip|hint|skip|trigger|origin|null)$/.test(t.name);
      return {
        name: t.name,
        faces: t.faces,
        area: Math.round(t.area),
        areaPct: totalArea > 0 && !utility ? +(t.area / totalArea * 100).toFixed(2) : 0,
        w: dims ? dims.w : null,
        h: dims ? dims.h : null,
        ext: dims ? dims.ext : null,
        source: dims ? dims.source : null,
        missing: !dims,
        utility,
        flags: flagNames(t.flags),
      };
    });
    textures.sort((a, b) => b.area - a.area || b.faces - a.faces);

    return {
      name: mapName,
      file: bspPath,
      source: this.fs.sourceOf(bspPath),
      title: cleanTitle(parsed.worldspawn.message),
      sky: parsed.worldspawn.sky || null,
      extended: parsed.extended,
      warnings: parsed.warnings,
      hasPalette: Boolean(this.palette),
      textures,
    };
  }

  // basePath without extension, e.g. "textures/e1u1/box1_3" or "env/aqcityft"
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

export function getInstall(gameDir, refresh = false) {
  const key = path.resolve(gameDir).toLowerCase();
  if (refresh || !installs.has(key)) {
    installs.set(key, new Install(path.resolve(gameDir)));
  }
  return installs.get(key);
}
