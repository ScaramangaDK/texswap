// Install — one opened AQ2/AQtion install (root + layered game dirs) with
// cached scan results and its swap store.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { GameFS } from './vfs.js';
import { parseBsp, extractBspGeometry, flagNames } from './bsp.js';
import { decodePcx, decodeImage } from './decoders.js';
import { encodePng, resizeRgba } from './thumbs.js';
import { flatImage, notextureImage } from './gen.js';
import { makeThumbPng, resolveImage, sizeOf, TEXTURE_EXTS, TEXTURE_EXTS_LOW } from './thumbs.js';
import { imageSize } from './decoders.js';
import { SwapStore, appDataRoot } from './swaps.js';
import { TextureUpscaler } from './upscale.js';

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

// Accepts an install root or a game dir inside one; returns
// { root, dirs, game, mods, activeMod } with dirs highest-priority first,
// mirroring the engine's mod-over-base layering.
// - AQ2/AQtion (action/baseaq present): unchanged fixed layering.
// - Plain Quake 2 (baseq2): baseq2 alone, or a chosen mod layered on top
//   (the engine runs ONE mod at a time via +set game <mod>).
export function detectInstall(inputDir, mod = null) {
  const abs = path.resolve(inputDir);
  let root = abs;
  const base = path.basename(abs).toLowerCase();
  if (GAME_DIR_ORDER.includes(base)) {
    root = path.dirname(abs);
  } else if (base !== 'baseq2' && hasGameContent(abs) &&
      hasGameContent(path.join(path.dirname(abs), 'baseq2'))) {
    // pointed at a mod dir inside a Q2 install: hop to the root, keep the mod
    root = path.dirname(abs);
    mod = mod || path.basename(abs);
  }

  const aq2Dirs = GAME_DIR_ORDER.filter(d => hasGameContent(path.join(root, d)));
  if (aq2Dirs.includes('action') || aq2Dirs.includes('baseaq')) {
    return { root, dirs: aq2Dirs, game: 'aq2', mods: [], activeMod: null };
  }

  if (hasGameContent(path.join(root, 'baseq2'))) {
    let mods = [];
    try {
      mods = fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.toLowerCase() !== 'baseq2' &&
          hasGameContent(path.join(root, e.name)))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b, 'en'));
    } catch { /* unreadable root: baseq2 alone */ }
    const active = mod ? mods.find(m => m.toLowerCase() === String(mod).toLowerCase()) || null : null;
    return {
      root,
      dirs: active ? [active, 'baseq2'] : ['baseq2'],
      game: 'q2',
      mods,
      activeMod: active,
    };
  }

  if (hasGameContent(abs)) {
    return { root: path.dirname(abs), dirs: [path.basename(abs)], game: 'other', mods: [], activeMod: null };
  }
  throw new Error('no game content found at ' + inputDir);
}

// The chosen Q2 mod per install path, persisted in app-data so it survives
// restarts without threading a parameter through every API call.
function modChoiceFile() {
  return path.join(appDataRoot(), 'modchoice.json');
}
function readModChoice(inputDir) {
  try {
    const m = JSON.parse(fs.readFileSync(modChoiceFile(), 'utf8'));
    return m[path.resolve(inputDir).toLowerCase()] || null;
  } catch {
    return null;
  }
}
export function setModChoice(inputDir, mod) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(modChoiceFile(), 'utf8')) || {}; } catch { /* fresh file */ }
  const key = path.resolve(inputDir).toLowerCase();
  if (mod) m[key] = mod;
  else delete m[key];
  fs.mkdirSync(appDataRoot(), { recursive: true });
  fs.writeFileSync(modChoiceFile(), JSON.stringify(m, null, 2));
}

// Last install dir the app scanned, so the splash screen can warm the right
// install before the main page opens.
const lastDirFile = () => path.join(appDataRoot(), 'lastdir.json');
export function readLastDir() {
  try { return JSON.parse(fs.readFileSync(lastDirFile(), 'utf8')).dir || ''; } catch { return ''; }
}
export function saveLastDir(dir) {
  try {
    if (!dir || readLastDir() === dir) return;
    fs.mkdirSync(appDataRoot(), { recursive: true });
    fs.writeFileSync(lastDirFile(), JSON.stringify({ dir }));
  } catch { /* cosmetic */ }
}

export class Install {
  constructor(inputDir) {
    const { root, dirs, game, mods, activeMod } = detectInstall(inputDir, readModChoice(inputDir));
    this.root = root;
    this.gameDirs = dirs;
    this.game = game;
    this.mods = mods;
    this.activeMod = activeMod;
    this.writeDir = path.join(root, dirs[0]);
    this.fs = new GameFS(root, dirs);
    this.palette = this.#loadPalette();
    this.bspCache = new Map();
    this.geoCache = new Map();
    this.thumbCache = new Map();
    this.texCatalog = null;
    this.skyCatalog = null;
    this.swaps = new SwapStore(this);
    this.upscale = new TextureUpscaler(this);
    // the weapon Skin studio was taken out of this build (2026-09-04; it returns in a
    // later update): drop its game-side files once and restate the cfgs without its
    // links - after the upscaler exists, or the restated cfgs would lose upscale links
    try { this.swaps.dropLegacySkins(); } catch { /* the next swap action rewrites the cfgs */ }
    if (this.swaps.pendingHeal) {
      this.swaps.pendingHeal = false;
      try { this.swaps.materialize(); } catch { /* healed on next action */ }
    }
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

  #installKey() {
    return (this.root + '|' + this.gameDirs.join(',')).toLowerCase();
  }

  // On-disk scan cache: map entries and texture dims survive restarts, keyed
  // by the backing file's mtime+size, so a warm start skips parsing every BSP.
  #loadScanCache() {
    if (this.scanCache) return this.scanCache;
    let all = {};
    try { all = JSON.parse(fs.readFileSync(path.join(appDataRoot(), 'scancache.json'), 'utf8')) || {}; } catch { /* cold */ }
    this.scanCacheAll = all;
    const mine = all[this.#installKey()] || {};
    this.scanCache = mine.maps || {};
    this.dimsDisk = mine.dims || {};
    this.scanDirty = 0;
    return this.scanCache;
  }

  #saveScanCache() {
    if (!this.scanDirty) return;
    const all = this.scanCacheAll || {};
    all[this.#installKey()] = { at: Date.now(), maps: this.scanCache, dims: this.dimsDisk };
    const keys = Object.keys(all);
    if (keys.length > 4) {
      keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      while (keys.length > 4) delete all[keys.shift()];
    }
    try {
      fs.mkdirSync(appDataRoot(), { recursive: true });
      fs.writeFileSync(path.join(appDataRoot(), 'scancache.json'), JSON.stringify(all));
      this.scanDirty = 0;
    } catch { /* cache only */ }
  }

  #saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.#saveScanCache(), 1500);
    this.saveTimer.unref?.();
  }

  #mapPath(mapName) {
    return this.fs.list(x => x.startsWith('maps/') && x.endsWith('.bsp'))
      .find(p => path.basename(p, '.bsp') === mapName.toLowerCase());
  }

  #mapEntryFor(p) {
    const cache = this.#loadScanCache();
    const sk = this.fs.statKey(p);
    const hit = cache[p];
    if (hit && sk && hit.k === sk) {
      return { ...hit.e, swapCount: this.swaps.swapCount(hit.e.name) };
    }
    const name = path.basename(p, '.bsp');
    const parsed = this.#parseMap(p);
    const e = parsed.error
      ? { name, file: p, source: this.fs.sourceOf(p), error: parsed.error }
      : {
        name,
        file: p,
        source: this.fs.sourceOf(p),
        title: cleanTitle(parsed.worldspawn.message),
        sky: parsed.worldspawn.sky || null,
        extended: parsed.extended,
        textureCount: parsed.textures.length,
      };
    if (sk) {
      cache[p] = { k: sk, e };
      this.scanDirty++;
    }
    return { ...e, swapCount: this.swaps.swapCount(name) };
  }

  listMaps() {
    if (this.mapsCache) {
      // swap counts move between scans; everything else is immutable
      for (const m of this.mapsCache) m.swapCount = this.swaps.swapCount(m.name);
      return this.mapsCache;
    }
    const maps = this.fs.list(x => x.startsWith('maps/') && x.endsWith('.bsp'))
      .map(p => this.#mapEntryFor(p));
    maps.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    this.mapsCache = maps;
    this.#saveScanCache();
    return maps;
  }

  // Same scan as listMaps, but yielding to the event loop so a status
  // endpoint can report progress while the first scan runs (a big install
  // takes 10s+ and the UI should never look frozen).
  async scanMapsAsync() {
    if (this.mapsCache) return this.mapsCache;
    const files = this.fs.list(x => x.startsWith('maps/') && x.endsWith('.bsp'));
    this.scanProgress = { done: 0, total: files.length };
    const maps = [];
    for (const p of files) {
      maps.push(this.#mapEntryFor(p));
      this.scanProgress.done++;
      if (this.scanProgress.done % 20 === 0) await new Promise(r => setImmediate(r));
    }
    maps.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    this.mapsCache = maps;
    this.scanProgress = null;
    this.#saveScanCache();
    this.#warmSkiesSoon();
    return maps;
  }

  // Pre-decode skybox picker thumbs in the background right after the first
  // scan (yielding between sets), so the sky dialog's first open is instant.
  #warmSkiesSoon() {
    if (this.skiesWarmed) return;
    this.skiesWarmed = true;
    const t = setTimeout(async () => {
      try {
        for (const s of this.listSkies()) {
          this.skyThumbPng(s.name);
          await new Promise(r => setImmediate(r));
        }
      } catch { /* warmup only */ }
    }, 1500);
    t.unref?.();
  }

  mapDetail(mapName, lowRes = false) {
    const extOrder = lowRes ? TEXTURE_EXTS_LOW : TEXTURE_EXTS;
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
      const hit = resolveImage(this.fs, 'textures/' + t.name, extOrder);
      const dims = hit ? this.#texDim(t.name, lowRes) : null;
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
      activePreset: this.swaps.activePreset(mapName),
      swapsEnabled: this.swaps.enabled,
      lighting: this.swaps.mapLighting(mapName),
      lightingManaged: this.swaps.lightingConfig().manage,
      recentFlats: this.swaps.recentFlats(),
      favTextures: this.swaps.favTextures(),
      favSets: this.swaps.favSets(),
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

  // Dimensions for a batch of picker textures, probed lazily (reading every
  // texture up front takes ~25s on a big install) and cached per name.
  // One texture's dimensions through the layered memory/disk cache; reads
  // the image file only on a true miss.
  #texDim(name, lowRes) {
    if (!this.dimsCache) this.dimsCache = new Map();
    this.#loadScanCache();
    const pre = lowRes ? 'L|' : 'H|';
    let d = this.dimsCache.get(pre + name);
    if (d === undefined) {
      const exts = lowRes ? TEXTURE_EXTS_LOW : TEXTURE_EXTS;
      const hit = resolveImage(this.fs, 'textures/' + name, exts);
      const sk = hit ? this.fs.statKey(hit.path) : null;
      const disk = this.dimsDisk[pre + name];
      if (disk && sk && disk.k === sk) {
        d = disk.d;
      } else {
        d = sizeOf(this.fs, 'textures/' + name, exts) || null;
        if (sk) {
          this.dimsDisk[pre + name] = { k: sk, d };
          this.scanDirty++;
          this.#saveSoon();
        }
      }
      this.dimsCache.set(pre + name, d);
    }
    return d;
  }

  texDims(names, lowRes = false) {
    const out = {};
    for (const name of names.slice(0, 400)) {
      const d = this.#texDim(name, lowRes);
      if (d) out[name] = { w: d.w, h: d.h, ext: d.ext };
    }
    return out;
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

  // Decoded thumbs also persist to disk (validated by the source file's
  // mtime+size), so first-click skybox/texture grids are only slow once ever.
  #thumbFile(key, sk) {
    if (!sk) return null;
    if (!this.thumbDirOk) {
      try {
        fs.mkdirSync(path.join(appDataRoot(), 'thumbcache'), { recursive: true });
        this.thumbDirOk = true;
      } catch {
        return null;
      }
    }
    const h = crypto.createHash('sha1').update(this.#installKey() + '|' + key + '|' + sk).digest('hex');
    return path.join(appDataRoot(), 'thumbcache', h + '.png');
  }

  thumbPng(basePath, maxDim = 128, lowRes = false, alpha255 = false) {
    const key = basePath.toLowerCase() + '@' + maxDim + (lowRes ? '@low' : '') + (alpha255 ? '@a' : '');
    if (this.thumbCache.has(key)) return this.thumbCache.get(key);
    const exts = lowRes ? TEXTURE_EXTS_LOW : TEXTURE_EXTS;
    const hit = resolveImage(this.fs, basePath, exts);
    const dfile = hit ? this.#thumbFile(key, this.fs.statKey(hit.path)) : null;
    if (dfile) {
      try {
        const png = fs.readFileSync(dfile);
        this.thumbCache.set(key, png);
        return png;
      } catch { /* not on disk yet */ }
    }
    let png = null;
    try {
      png = makeThumbPng(this.fs, basePath, this.palette, maxDim, exts, { transparent255: alpha255 });
    } catch {
      png = null;
    }
    this.thumbCache.set(key, png);
    if (png && dfile) {
      try { fs.writeFileSync(dfile, png); } catch { /* cache only */ }
    }
    return png;
  }

  skyThumbPng(skyName, maxDim = 128) {
    return this.thumbPng('env/' + skyName + 'ft', maxDim) ||
      this.thumbPng('env/' + skyName + 'bk', maxDim);
  }

  // One full-resolution skybox face as PNG, for the 3D viewer backdrop.
  skyFacePng(skyName, face) {
    if (!/^(rt|lf|ft|bk|up|dn)$/.test(face)) return null;
    return this.thumbPng('env/' + skyName + face, 1024);
  }

  // The engine's mapping grid for a texture: the .wal's dims when one
  // exists (hi-res replacements are squeezed to that grid), else the image's
  // own dims. This is the tiling frame swaps must be generated in.
  mappingDims(name) {
    if (!this.mapDimsCache) this.mapDimsCache = new Map();
    if (this.mapDimsCache.has(name)) return this.mapDimsCache.get(name);
    let dims = null;
    const walBuf = this.fs.read('textures/' + name + '.wal');
    if (walBuf) dims = imageSize(walBuf, '.wal');
    if (!dims) {
      const hit = resolveImage(this.fs, 'textures/' + name);
      if (hit) dims = imageSize(this.fs.read(hit.path), hit.ext);
    }
    const out = dims && dims.w ? { w: dims.w, h: dims.h } : null;
    this.mapDimsCache.set(name, out);
    return out;
  }

  // The player's in-game light settings. `launch` layers files the way the
  // engine does at startup (q2config.cfg -> autoexec.cfg, later wins); every
  // OTHER loose cfg in the write dir that sets light cvars becomes an
  // optional profile (mappers often keep a hand-made "view my maps" cfg
  // under any name they like), parsed as launch + that file on top. Bare
  // `cvar value` lines count too - loose cfgs rarely bother with set/seta.
  engineLighting() {
    try {
      const CVARS = {
        gl_modulate: 'modulate', gl_modulate_world: 'modulateWorld',
        gl_brightness: 'brightness', vid_gamma: 'gamma', intensity: 'intensity',
        gl_saturation: 'saturation', gl_coloredlightmaps: 'coloredLightmaps',
      };
      const parse = (txt, out) => {
        let hit = false;
        for (const [name, key] of Object.entries(CVARS)) {
          const m = new RegExp(`^\\s*(?:seta?\\s+)?${name}\\s+"?(-?[\\d.]+)`, 'mi').exec(txt);
          if (m) { out[key] = parseFloat(m[1]); hit = true; }
        }
        return hit;
      };
      const readTxt = f => {
        try { return fs.readFileSync(path.join(this.writeDir, f), 'latin1'); } catch { return null; }
      };
      const launch = {};
      const srcs = [];
      for (const f of ['q2config.cfg', 'autoexec.cfg']) {
        const t = readTxt(f);
        if (t && parse(t, launch)) srcs.push(f);
      }
      launch.source = srcs.join(' + ') || 'q2config.cfg';
      const profiles = {};
      for (const f of fs.readdirSync(this.writeDir)) {
        if (!/\.cfg$/i.test(f) || /^(q2config|autoexec|config)\.cfg$/i.test(f)) continue;
        let st;
        try { st = fs.statSync(path.join(this.writeDir, f)); } catch { continue; }
        if (!st.isFile() || st.size > 128 * 1024) continue;
        const t = readTxt(f);
        if (!t) continue;
        const p = { ...launch };
        if (parse(t, p)) {
          p.source = f;
          profiles[f] = p;
          if (Object.keys(profiles).length >= 12) break;
        }
      }
      if (!srcs.length && !Object.keys(profiles).length) return null;
      return { launch, profiles };
    } catch {
      return null;
    }
  }

  // Texture names in a map with no image file anywhere in the install,
  // skipping utility surfaces nobody sees (for the global missing-tex fix).
  missingTextures(bspPath) {
    const parsed = this.#parseMap(bspPath);
    if (parsed.error) return [];
    return parsed.textures
      .filter(t => !(t.flags & (SURF_SKY | SURF_NODRAW)) &&
        !/(^|\/)(clip|hint|skip|trigger|origin|null)$/.test(t.name) &&
        !resolveImage(this.fs, 'textures/' + t.name, TEXTURE_EXTS))
      .map(t => t.name);
  }

  // Served in place of textures the install doesn't have, rendered in the
  // user's configured missing-texture style (default: near-black #0f0f0f
  // with a #5b3b0f brown grid).
  placeholderPng(size = 128) {
    const mf = this.swaps.missingFixConfig();
    const key = `placeholder@${size}@${mf.enabled ? 'on' : 'off'}|${mf.color}|${mf.style}|${mf.color2 || ''}|${mf.scale || 1}`;
    if (this.thumbCache.has(key)) return this.thumbCache.get(key);
    let png;
    try {
      png = mf.enabled
        // fix ON: preview exactly what the fix will link in-game
        ? encodePng(flatImage(mf.color, mf.style, size, mf.color2 || null, mf.scale || 1))
        // fix OFF: the engine's real generated notexture (red dots on black)
        : encodePng(notextureImage(size));
    } catch {
      png = encodePng(flatImage('#0f0f0f', 'grid', size, '#5b3b0f'));
    }
    this.thumbCache.set(key, png);
    return png;
  }

  // Renderable geometry for the 3D viewer, with UVs normalized against the
  // engine's mapping dimensions (the .wal size when one exists — hi-res
  // replacements are scaled to the wal's texel grid).
  mapGeometry(mapName) {
    if (this.geoCache.has(mapName)) return this.geoCache.get(mapName);
    const bspPath = this.#mapPath(mapName);
    if (!bspPath) throw new Error('map not found: ' + mapName);
    const raw = extractBspGeometry(this.fs.read(bspPath));
    const groups = raw.groups.map(g => {
      let dims = null;
      const walBuf = this.fs.read('textures/' + g.name + '.wal');
      if (walBuf) dims = imageSize(walBuf, '.wal');
      if (!dims) {
        const hit = resolveImage(this.fs, 'textures/' + g.name);
        if (hit) dims = imageSize(this.fs.read(hit.path), hit.ext);
      }
      const w = dims && dims.w ? dims.w : 64;
      const h = dims && dims.h ? dims.h : 64;
      const uvs = new Array(g.uvs.length);
      for (let i = 0; i < g.uvs.length; i += 2) {
        uvs[i] = Math.round(g.uvs[i] / w * 10000) / 10000;
        uvs[i + 1] = Math.round(g.uvs[i + 1] / h * 10000) / 10000;
      }
      return { name: g.name, flags: flagNames(g.flags), positions: g.positions, uvs, luvs: g.luvs, texW: w, texH: h };
    });
    // lightmap atlas: RGB -> RGBA -> PNG, served via /api/maplight
    let atlasPng = null;
    try {
      const { width, height, rgb } = raw.lightAtlas;
      const rgba = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = rgb[i * 3];
        rgba[i * 4 + 1] = rgb[i * 3 + 1];
        rgba[i * 4 + 2] = rgb[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
      atlasPng = encodePng({ width, height, data: rgba });
    } catch { /* viewer falls back to fullbright */ }
    const geo = { name: mapName, extended: raw.extended, groups, spawns: raw.spawns, bounds: raw.bounds, hasLightmap: Boolean(atlasPng) };
    this.geoCache.set(mapName, { geo, atlasPng });
    return { geo, atlasPng };
  }

  // Thumbnail for an uploaded custom image (texswap/custom/*.png).
  customThumbPng(relFile, maxDim = 128) {
    if (!/^custom\/[a-z0-9_.-]+\.png$/i.test(relFile)) return null;
    const key = 'custom:' + relFile.toLowerCase() + '@' + maxDim;
    if (this.thumbCache.has(key)) return this.thumbCache.get(key);
    let png = null;
    try {
      const buf = fs.readFileSync(path.join(this.swaps.dataDir, relFile));
      png = encodePng(resizeRgba(decodeImage(buf, '.png', this.palette), maxDim));
    } catch {
      png = null;
    }
    this.thumbCache.set(key, png);
    return png;
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
