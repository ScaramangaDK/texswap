// SwapStore — per-install swap presets plus materialization into the game:
// texswap/<map>.cfg files (hard `link` commands), generated texture files in
// texswap/gen/, hook.cfg, and the autoexec.cfg hook line.
//
// Everything written lives under <writeDir>/texswap/ except one appended line
// in <writeDir>/autoexec.cfg. Shipped game files are never modified.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { flatImage, parseColor, FLAT_STYLES, transcode, encodeAs, encodePngFile, resizeToGrid } from './gen.js';
import { decodeImage } from './decoders.js';
import { resolveImage } from './thumbs.js';

const ALL_TEX_EXTS = ['.png', '.tga', '.jpg', '.wal'];
const HOOK_LINE = 'exec texswap/hook.cfg';

function sanitize(name) {
  return name.replaceAll('/', '-').replace(/[^a-z0-9_.-]/gi, '_');
}

function sanitizePresetName(name) {
  const clean = String(name || '').trim().replace(/[^a-z0-9 _.-]/gi, '').slice(0, 24);
  if (!clean) throw new Error('invalid preset name');
  return clean;
}

// Keep cfg output safe: plain cvar names, short quote/semicolon-free values.
function cleanCvarMap(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!/^[a-z0-9_]{1,32}$/i.test(k)) continue;
    const val = String(v).trim();
    if (val === '' || val.length > 32 || /["\n\r;]/.test(val)) continue;
    out[k.toLowerCase()] = val;
  }
  return out;
}

// Global missing-texture fix config: which flat style stands in for
// textures the install doesn't have (and, when enabled, gets link'd
// in-game across all maps). Falls back to the cyan2 + brown grid default.
function cleanMissingFix(m) {
  const f = { enabled: false, color: '#0f0f0f', style: 'grid', color2: '#5b3b0f', scale: 1 };
  if (!m || typeof m !== 'object') return f;
  f.enabled = Boolean(m.enabled);
  try { parseColor(m.color); f.color = m.color; } catch { /* keep default */ }
  if (FLAT_STYLES.includes(m.style)) f.style = m.style;
  if (m.color2 === null) f.color2 = null;
  else { try { parseColor(m.color2); f.color2 = m.color2; } catch { /* keep default */ } }
  const sc = Number(m.scale);
  if (Number.isFinite(sc) && sc >= 0.25 && sc <= 8) f.scale = sc;
  return f;
}

// Per-user data root: presets survive game reinstalls/deletions here.
export function appDataRoot() {
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '.', '.config');
  return path.join(base, 'AQ2TextureSwapper');
}

export class SwapStore {
  constructor(install) {
    this.install = install;
    this.dir = path.join(install.writeDir, 'texswap');

    // source of truth lives in app-data, keyed per install
    const key = crypto.createHash('sha1').update(path.resolve(install.root).toLowerCase()).digest('hex').slice(0, 10);
    const slug = path.basename(install.root).replace(/[^a-z0-9_-]/gi, '_').slice(0, 24) || 'install';
    this.dataDir = path.join(appDataRoot(), 'installs', `${slug}-${key}`);
    fs.mkdirSync(path.join(this.dataDir, 'custom'), { recursive: true });
    this.file = path.join(this.dataDir, 'presets.json');

    // migrate older versions that stored everything inside the install
    const legacyFile = path.join(this.dir, 'presets.json');
    if (!fs.existsSync(this.file) && fs.existsSync(legacyFile)) {
      try {
        fs.copyFileSync(legacyFile, this.file);
        const legacyCustom = path.join(this.dir, 'custom');
        if (fs.existsSync(legacyCustom)) {
          for (const f of fs.readdirSync(legacyCustom)) {
            fs.copyFileSync(path.join(legacyCustom, f), path.join(this.dataDir, 'custom', f));
          }
        }
      } catch { /* keep going with whatever we could migrate */ }
    }
    this.data = { version: 2, enabled: true, lighting: { manage: false, global: {}, extra: '' }, missingFix: cleanMissingFix(null), recentFlats: [], favTextures: [], favSets: {}, maps: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.maps) {
        this.data = {
          version: 2,
          enabled: raw.enabled !== false,
          lighting: {
            manage: Boolean(raw.lighting && raw.lighting.manage),
            global: cleanCvarMap(raw.lighting && raw.lighting.global),
            extra: typeof (raw.lighting && raw.lighting.extra) === 'string' ? raw.lighting.extra.slice(0, 2000) : '',
          },
          missingFix: cleanMissingFix(raw.missingFix),
          recentFlats: Array.isArray(raw.recentFlats) ? raw.recentFlats.slice(0, 12) : [],
          favTextures: Array.isArray(raw.favTextures) ? raw.favTextures : [],
          favSets: (raw.favSets && typeof raw.favSets === 'object' && !Array.isArray(raw.favSets))
            ? Object.fromEntries(Object.entries(raw.favSets)
                .filter(([, v]) => Array.isArray(v))
                .map(([k, v]) => [k, v.filter(x => typeof x === 'string')]))
            : {},
          maps: raw.maps,
          gridSemantics: raw.gridSemantics || 0,
          skinsRemoved: Boolean(raw.skinsRemoved),
        };
        // the invisible swap type was removed before release (see-through
        // surfaces are a cheat risk): drop any stored ones, presets included.
        // AI upscales on textures WITHOUT a .wal are dropped too: the engine
        // tiles those by the served image, so they shrank on every brush.
        for (const e of Object.values(this.data.maps)) {
          if (!e) continue;
          const sets = [e.swaps, ...Object.values(e.saved || {}).map(p => p && p.swaps)];
          for (const swaps of sets) {
            if (!swaps) continue;
            for (const [k, v] of Object.entries(swaps)) {
              if (v && v.type === 'invisible') delete swaps[k];
              else if (v && v.type === 'upscale' && !install.fs.has('textures/' + k + '.wal')) delete swaps[k];
            }
          }
        }
      }
    } catch { /* no presets yet */ }
    this.#migrateGridSemantics();
  }

  // One-time cfg rebuild markers. v2: swaps keep the replacement's own size
  // like the engine always rendered links - the 3D viewer mirrors it via UV
  // repeats. v3: downscaled swaps keep full resolution in their image-ext gen
  // files (only the wal shrinks, carrying the tiling grid), so hi-res mode
  // (r_texture_overrides 31) stays sharp at dense tiling. v4: gen wals carry
  // transparency as palette index 255, so alphatest swaps work in wal mode.
  // v1.5 -> this build: the weapon Skin studio is gone. Its game-side files and
  // the inline skin link lines are dropped once per install (flag persisted).
  dropLegacySkins() {
    if (this.data.skinsRemoved) return;
    if (!this.install.upscale) throw new Error('dropLegacySkins needs the upscaler (materialize would skip upscale links)');
    try { fs.rmSync(path.join(this.dir, 'skins'), { recursive: true, force: true }); } catch { /* not there */ }
    this.materialize();
    this.data.skinsRemoved = true;
    try { this.#saveJson(); } catch { /* saved on next action */ }
  }

  #migrateGridSemantics() {
    if (this.data.gridSemantics === 4) return;
    this.data.gridSemantics = 4;
    try { this.#saveJson(); } catch { /* saved on next action */ }
    // gen/ is purely derived data; wipe it so every file regenerates under
    // the new rules (also clears stale experiment-era -g<w>x<h> files)
    try {
      const genDir = path.join(this.install.writeDir, 'texswap', 'gen');
      for (const f of fs.readdirSync(genDir)) {
        try { fs.unlinkSync(path.join(genDir, f)); } catch { /* in use */ }
      }
    } catch { /* no gen dir yet */ }
    // the Install ctor runs the rebuild once we are fully wired up
    this.pendingHeal = Object.keys(this.data.maps || {}).length > 0;
  }

  recentFlats() {
    return this.data.recentFlats || [];
  }

  favTextures() {
    return this.data.favTextures || [];
  }

  // Store an uploaded replacement image (png/jpg/tga) and swap to it.
  setCustomSwap(mapName, from, filename, buf, scale = 1) {
    let ext = path.extname(filename).toLowerCase();
    if (ext === '.jpeg') ext = '.jpg';
    if (!['.png', '.jpg', '.tga'].includes(ext)) {
      throw new Error('unsupported image type ' + (ext || '(none)') + ' - use png, jpg or tga');
    }
    const img = decodeImage(buf, ext, this.install.palette);
    const master = encodePngFile(img);
    const hash = crypto.createHash('sha1').update(master).digest('hex').slice(0, 8);
    const rel = `custom/${sanitize(from)}-${hash}.png`;
    const abs = path.join(this.dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, master);
    const spec = { type: 'custom', file: rel, w: img.width, h: img.height };
    if (scale && scale !== 1) spec.scale = scale;
    return this.setSwap(mapName, from, spec);
  }

  missingFixConfig() {
    return this.data.missingFix || cleanMissingFix(null);
  }

  setMissingFix(cfg) {
    parseColor(cfg.color); // throws on bad input
    if (!FLAT_STYLES.includes(cfg.style)) throw new Error('bad style ' + cfg.style);
    if (cfg.color2) parseColor(cfg.color2);
    this.data.missingFix = cleanMissingFix(cfg);
    return this.#saveAndMaterialize();
  }

  setFavTexture(name, fav) {
    const set = new Set(this.data.favTextures || []);
    if (fav) set.add(name);
    else set.delete(name);
    this.data.favTextures = [...set].sort();
    this.#saveJson();
    return this.data.favTextures;
  }

  favSets() {
    return this.data.favSets || {};
  }

  // action: 'add' | 'remove' (texture in set) | 'create' | 'deleteSet'
  modifyFavSet(action, setName, texName) {
    const sets = this.data.favSets || (this.data.favSets = {});
    if (action === 'deleteSet') {
      delete sets[setName];
    } else {
      const clean = String(setName || '').trim().replace(/[^a-z0-9 _.,'&()-]/gi, '').slice(0, 30);
      if (!clean) throw new Error('invalid collection name');
      const arr = sets[clean] || (sets[clean] = []);
      if (action === 'add' && texName) {
        if (!arr.includes(texName)) arr.push(texName);
        arr.sort();
        // collections are subsets of "All favorites"
        const favs = new Set(this.data.favTextures || []);
        favs.add(texName);
        this.data.favTextures = [...favs].sort();
      } else if (action === 'remove' && texName) {
        sets[clean] = arr.filter(t => t !== texName);
      }
    }
    this.#saveJson();
    return { favSets: this.data.favSets, favTextures: this.data.favTextures };
  }

  #saveJson() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  lightingConfig() {
    return this.data.lighting;
  }

  setLighting(cfg) {
    this.data.lighting = {
      manage: Boolean(cfg && cfg.manage),
      global: cleanCvarMap(cfg && cfg.global),
      extra: typeof (cfg && cfg.extra) === 'string' ? cfg.extra.replace(/\r/g, '').slice(0, 2000) : '',
    };
    return this.#saveAndMaterialize();
  }

  mapLighting(mapName) {
    const e = this.data.maps[mapName];
    return e && e.lighting ? e.lighting : null;
  }

  setMapLighting(mapName, cvars) {
    const e = this.mapEntry(mapName, true);
    const clean = cleanCvarMap(cvars);
    e.lighting = Object.keys(clean).length ? clean : null;
    e.active = null;
    return this.#saveAndMaterialize();
  }

  get enabled() {
    return this.data.enabled !== false;
  }

  setEnabled(on) {
    this.data.enabled = Boolean(on);
    return this.#saveAndMaterialize();
  }

  mapEntry(mapName, create = false) {
    let e = this.data.maps[mapName];
    if (!e && create) e = this.data.maps[mapName] = { swaps: {}, sky: null };
    return e;
  }

  setSwap(mapName, from, spec) {
    if (spec && spec.type === 'invisible') {
      throw new Error('invisible swaps are not supported (see-through surfaces would be cheating)');
    }
    const e = this.mapEntry(mapName, true);
    if (spec === null) delete e.swaps[from];
    else e.swaps[from] = spec;
    if (spec && spec.type === 'flat') {
      const recents = (this.data.recentFlats || []).filter(c => c !== spec.color);
      recents.unshift(spec.color);
      this.data.recentFlats = recents.slice(0, 12);
    }
    e.active = null; // working state diverged from any saved preset
    return this.#saveAndMaterialize();
  }

  // Many swaps on one map in a single save/materialize (the upscale job).
  setSwapsBulk(mapName, specs) {
    const e = this.mapEntry(mapName, true);
    for (const [from, spec] of Object.entries(specs)) {
      if (spec === null) delete e.swaps[from];
      else e.swaps[from] = spec;
    }
    e.active = null;
    return this.#saveAndMaterialize();
  }

  removeUpscales(mapName) {
    const e = this.data.maps[mapName];
    if (!e) return { written: [], warnings: [], removed: 0 };
    let removed = 0;
    for (const [from, spec] of Object.entries(e.swaps)) {
      if (spec && spec.type === 'upscale') { delete e.swaps[from]; removed++; }
    }
    if (!removed) return { written: [], warnings: [], removed: 0 };
    e.active = null;
    return { ...this.#saveAndMaterialize(), removed };
  }

  setSky(mapName, to) {
    const e = this.mapEntry(mapName, true);
    e.sky = to ? { to } : null;
    e.active = null;
    return this.#saveAndMaterialize();
  }

  activePreset(mapName) {
    const e = this.data.maps[mapName];
    return e && e.active ? e.active : null;
  }

  resetMap(mapName) {
    const e = this.data.maps[mapName];
    if (e) {
      // keep saved presets; only clear the working state
      e.swaps = {};
      e.sky = null;
      e.lighting = null;
      e.active = null;
      if (!e.saved || !Object.keys(e.saved).length) delete this.data.maps[mapName];
    }
    return this.#saveAndMaterialize();
  }

  swapsFor(mapName) {
    const e = this.data.maps[mapName];
    return { swaps: e ? e.swaps : {}, sky: e && e.sky ? e.sky : null };
  }

  savedPresetNames(mapName) {
    const e = this.data.maps[mapName];
    return e && e.saved ? Object.keys(e.saved).sort() : [];
  }

  savePreset(mapName, name) {
    const clean = sanitizePresetName(name);
    const e = this.mapEntry(mapName, true);
    if (!e.saved) e.saved = {};
    e.saved[clean] = {
      swaps: structuredClone(e.swaps),
      sky: e.sky ? { ...e.sky } : null,
      lighting: e.lighting ? { ...e.lighting } : null,
    };
    e.active = clean;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return clean;
  }

  loadPreset(mapName, name) {
    const e = this.data.maps[mapName];
    if (!e || !e.saved || !e.saved[name]) throw new Error(`no preset "${name}" for ${mapName}`);
    e.swaps = structuredClone(e.saved[name].swaps);
    e.sky = e.saved[name].sky ? { ...e.saved[name].sky } : null;
    e.lighting = e.saved[name].lighting ? { ...e.saved[name].lighting } : null;
    e.active = name;
    return this.#saveAndMaterialize();
  }

  deletePreset(mapName, name) {
    const e = this.data.maps[mapName];
    if (e && e.saved) delete e.saved[name];
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  // The map's current working state as a shareable object (null if empty).
  // texturesOnly (team packs): just the swaps - sky and lighting are
  // personal taste and stay out of shared packs.
  #exportObj(mapName, texturesOnly = false) {
    const { swaps, sky } = this.swapsFor(mapName);
    const lighting = texturesOnly ? null : this.mapLighting(mapName);
    if (!Object.keys(swaps).length && (texturesOnly || (!sky && !lighting))) return null;
    const obj = {
      app: 'aq2-texture-swapper',
      format: 1,
      exported: new Date().toISOString(),
      map: mapName,
      swaps,
      sky: texturesOnly ? null : sky,
      lighting,
    };
    // embed uploaded images so the file is fully shareable
    const customFiles = {};
    for (const spec of Object.values(swaps)) {
      if (spec.type === 'custom' && spec.file) {
        try {
          customFiles[spec.file] = fs.readFileSync(path.join(this.dataDir, spec.file)).toString('base64');
        } catch { /* file missing; receiver gets a warning on import */ }
      }
    }
    if (Object.keys(customFiles).length) obj.customFiles = customFiles;
    return obj;
  }

  // Export the map's current working state as a shareable object; also writes
  // it to texswap/exports/ so the user has a file to send to friends.
  exportMap(mapName) {
    const obj = this.#exportObj(mapName);
    if (!obj) throw new Error('nothing to export - no swaps on this map');
    const dir = path.join(this.dir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${mapName}.aq2swap.json`);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return { obj, file };
  }

  // Every map with anything worth sharing (swaps, sky or lighting).
  packableMaps() {
    return Object.keys(this.data.maps)
      .filter(n => this.#exportObj(n, false) !== null)
      .sort();
  }

  // Team pack: the texture swaps of every customized map (or a chosen
  // subset) in one file - no sky or lighting, people keep their own.
  // withStyle: include each map's sky + lighting in the pack (a personal
  // "style" export); off = textures only, receivers keep their own sky.
  exportPack(mapNames = null, packName = '', withStyle = false) {
    const names = mapNames && mapNames.length ? mapNames : this.packableMaps();
    const maps = [];
    for (const n of names) {
      const one = this.#exportObj(n, !withStyle);
      if (one) maps.push(one);
    }
    if (!maps.length) throw new Error('nothing to export - no maps have texture swaps');
    const sorted = maps.map(m => m.map).sort();
    // user-chosen name wins; otherwise the filename mirrors the selection,
    // so different packs never overwrite each other
    let base = sanitize(String(packName || '').trim()).slice(0, 48).replace(/^[_.]+|[_.]+$/g, '');
    if (!base) {
      const act = sorted.length === 1 ? this.activePreset(sorted[0]) : null;
      if (act) {
        // single map exported while a named preset is loaded: name after it
        base = `${sorted[0]}-${act}`;
      } else {
        const joined = 'teampack-' + sorted.join('+');
        base = sorted.length <= 3 && joined.length <= 64
          ? joined
          : `teampack-${sorted.length}maps-` +
            crypto.createHash('sha1').update(sorted.join(',')).digest('hex').slice(0, 6);
      }
      base = sanitize(base);
    }
    const obj = {
      app: 'aq2-texture-swapper',
      kind: 'pack',
      format: 1,
      name: base,
      exported: new Date().toISOString(),
      maps,
    };
    const dir = path.join(this.dir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, base + '.aq2pack.json');
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return { file, count: maps.length, maps: sorted };
  }

  importPack(obj) {
    if (!obj || obj.app !== 'aq2-texture-swapper' || obj.kind !== 'pack' || !Array.isArray(obj.maps)) {
      throw new Error('not a valid .aq2pack.json team pack file');
    }
    const warnings = [];
    const imported = [];
    for (const one of obj.maps.slice(0, 500)) {
      try {
        // entries that carry sky/lighting were exported as a full style and
        // apply it; plain entries leave the receiver's sky/lighting alone
        const hasStyle = Boolean((one && one.sky) || (one && one.lighting));
        const r = this.importMap(one, !hasStyle);
        imported.push(r.map);
        warnings.push(...(r.warnings || []));
      } catch (e) {
        warnings.push(`${one && one.map ? one.map : 'a map'}: ${e.message}`);
      }
    }
    return { pack: true, count: imported.length, maps: imported, warnings };
  }

  // texturesOnly (pack entries): apply the swaps but leave the receiver's
  // own sky and lighting on that map untouched.
  importMap(obj, texturesOnly = false) {
    if (!obj || obj.app !== 'aq2-texture-swapper' || !obj.map || typeof obj.swaps !== 'object') {
      throw new Error('not a valid .aq2swap.json preset file');
    }
    const warnings = [];
    const known = this.install.listMaps().some(m => m.name === obj.map);
    if (!known) warnings.push(`map "${obj.map}" is not in this install - preset stored, applies if you get the map`);
    const customOk = /^custom\/[a-z0-9_.-]+\.png$/i;
    const swaps = {};
    let pendingUpscales = 0;
    for (const [from, spec] of Object.entries(obj.swaps)) {
      if (spec && spec.scale !== undefined) {
        const sc = Number(spec.scale);
        if (Number.isFinite(sc) && sc >= 0.25 && sc <= 8 && sc !== 1) spec.scale = sc;
        else delete spec.scale;
      }
      if (spec && spec.type === 'flat' && typeof spec.color === 'string') swaps[from] = spec;
      else if (spec && spec.type === 'upscale') {
        if (!this.install.fs.has('textures/' + from + '.wal')) {
          warnings.push(`${from}: AI upscale skipped - no .wal here, the engine would tile it ${spec.factor || 4}x denser`);
          continue;
        }
        const f = [2, 3, 4].includes(Number(spec.factor)) ? Number(spec.factor) : 4;
        const clean = { type: 'upscale', factor: f };
        if (spec.src === 'low') clean.src = 'low';
        if (spec.model === 'smooth') clean.model = 'smooth';
        if ([25, 50, 75, 100].includes(Number(spec.grain))) clean.grain = Number(spec.grain);
        swaps[from] = clean;
        if (!this.install.upscale || !this.install.upscale.cachedFile(from, f, clean.src || 'auto', clean.model || 'detail', clean.grain || 0)) pendingUpscales++;
      }
      else if (spec && spec.type === 'invisible') {
        warnings.push(`invisible swap for ${from} skipped - the invisible feature was removed (cheat risk)`);
      }
      else if (spec && spec.type === 'stock' && typeof spec.to === 'string') {
        if (!this.install.fs.findFirst('textures/' + spec.to, ALL_TEX_EXTS.concat('.pcx'))) {
          warnings.push(`replacement "${spec.to}" not found here - skipped for ${from}`);
          continue;
        }
        swaps[from] = spec;
      } else if (spec && spec.type === 'custom' && customOk.test(spec.file || '')) {
        const b64 = obj.customFiles && obj.customFiles[spec.file];
        if (!b64) {
          warnings.push(`custom image for ${from} missing from the file - skipped`);
          continue;
        }
        const abs = path.join(this.dataDir, spec.file);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
        swaps[from] = spec;
      }
    }
    const e = this.mapEntry(obj.map, true);
    e.swaps = swaps;
    if (!texturesOnly) {
      e.sky = obj.sky && obj.sky.to ? { to: obj.sky.to } : null;
      const impLighting = cleanCvarMap(obj.lighting);
      e.lighting = Object.keys(impLighting).length ? impLighting : null;
    }
    const result = this.#saveAndMaterialize();
    if (pendingUpscales) {
      // the generated files are not shared (too big); the receiver's GPU makes them
      warnings.unshift(`${pendingUpscales} AI-upscaled texture${pendingUpscales === 1 ? '' : 's'} need generating here - open the map and run "AI upscale textures"`);
      const perTex = result.warnings.filter(w => !w.includes('AI upscale not generated'));
      return { map: obj.map, known, warnings: warnings.concat(perTex), written: result.written, pendingUpscales };
    }
    return { map: obj.map, known, warnings: warnings.concat(result.warnings), written: result.written };
  }

  swapCount(mapName) {
    const e = this.data.maps[mapName];
    return e ? Object.keys(e.swaps).length + (e.sky ? 1 : 0) : 0;
  }

  #saveAndMaterialize() {
    fs.mkdirSync(path.join(this.dir, 'gen'), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.materialize();
  }

  // Which extensions can the engine request for this texture? Depends on the
  // player's r_override_textures / r_texture_overrides settings: hi-res mode
  // asks .png/.tga/.jpg first, low-res mode asks the original .wal directly.
  // Cover both: shadow every existing real variant, plus canonical .png
  // (hi-res) and .wal (low-res) so the swap works at any setting.
  // (.pcx-only sources aren't shadowed in low-res mode — rare, v1 limitation.)
  #fromExts(fromTexture, spec = null) {
    if (spec && spec.type === 'upscale') {
      // an AI upscale only replaces what override mode samples; the .wal keeps
      // its grid (tiling untouched) and low-res mode stays stock
      const exts = new Set(['.png', '.tga', '.jpg'].filter(ext => this.install.fs.has('textures/' + fromTexture + ext)));
      exts.add('.png');
      return [...exts];
    }
    const exts = new Set(ALL_TEX_EXTS.filter(ext => this.install.fs.has('textures/' + fromTexture + ext)));
    exts.add('.png');
    exts.add('.wal');
    return [...exts];
  }

  // Ensure the gen file for a swap spec exists in the requested extension.
  // Returns the link target path (game-relative) or null on failure.
  // Swap semantics: the replacement keeps ITS OWN size (looks identical on
  // every surface it is applied to, like the engine always rendered links);
  // the optional scale multiplies that. The 3D viewer mirrors this by
  // scaling its UVs to the served file's grid.
  #ensureGen(spec, ext, warnings, from = null) {
    let fileBase, make, alwaysWrite = false;
    if (spec.type === 'upscale') {
      const factor = [2, 3, 4].includes(Number(spec.factor)) ? Number(spec.factor) : 4;
      const cached = from && this.install.upscale ? this.install.upscale.cachedFile(from, factor, spec.src === 'low' ? 'low' : 'auto', spec.model === 'smooth' ? 'smooth' : 'detail', Number(spec.grain) || 0) : null;
      if (!cached) {
        warnings.push(`${from}: AI upscale not generated on this PC yet - run "AI upscale textures" on the map`);
        return null;
      }
      // the gen name carries the cache file's content hash + recipe, so a
      // different source (wal vs hi-res) or recipe never reuses a stale file
      fileBase = 'up-' + sanitize(from) + '-' + path.basename(cached, '.png');
      make = () => {
        const buf = fs.readFileSync(cached);
        if (ext === '.png') return buf;
        return encodeAs(ext, decodeImage(buf, '.png', this.install.palette), this.install.palette, fileBase);
      };
    } else if (spec.type === 'flat') {
      const c2 = spec.color2 ? '-' + spec.color2.replace('#', '') : '';
      const sc = spec.scale && spec.scale !== 1 ? '-x' + String(spec.scale).replace('.', '_') : '';
      fileBase = `flat-${spec.color.replace('#', '')}-${spec.style || 'solid'}${c2}${sc}`;
      make = () => encodeAs(ext, flatImage(spec.color, spec.style, 128, spec.color2 || null, spec.scale || 1), this.install.palette, fileBase);
      alwaysWrite = true; // cheap to generate; guarantees pattern tweaks reach disk
    } else if (spec.type === 'stock') {
      const sc = spec.scale && spec.scale !== 1 ? '-x' + String(spec.scale).replace('.', '_') : '';
      fileBase = sanitize(spec.to) + sc;
      // Downscales (<1) shrink only the WAL: the wal carries the tiling grid,
      // and in hi-res mode (r_texture_overrides 31) the engine tiles by that
      // grid while sampling the image override - png/tga/jpg keep the source's
      // full resolution so dense tiling stays sharp there.
      make = () => {
        const s = spec.scale || 1;
        const eff = ext !== '.wal' && s < 1 ? 1 : s;
        return transcode(this.install.fs, this.install.palette, 'textures/' + spec.to, ext, fileBase, eff);
      };
    } else if (spec.type === 'custom') {
      const sc = spec.scale && spec.scale !== 1 ? '-x' + String(spec.scale).replace('.', '_') : '';
      fileBase = 'custom-' + path.basename(spec.file, '.png') + sc;
      make = () => {
        const buf = fs.readFileSync(path.join(this.dataDir, spec.file));
        let img = decodeImage(buf, '.png', this.install.palette);
        const s = spec.scale || 1;
        // same rule as stock: image exts keep full res on downscales
        if (s !== 1 && (ext === '.wal' || s > 1)) img = resizeToGrid(img, img.width * s, img.height * s);
        return encodeAs(ext, img, this.install.palette, fileBase);
      };
    } else {
      warnings.push(`unknown swap type ${spec.type}`);
      return null;
    }
    const relPath = `texswap/gen/${fileBase}${ext}`;
    // the same gen file is often needed for many links in one materialize run
    // (the missing-texture fix links one flat to thousands of names) - encode
    // and write each unique file only once per run
    if (this.genDone && this.genDone.has(relPath)) return relPath;
    const absPath = path.join(this.install.writeDir, 'texswap', 'gen', fileBase + ext);
    if (alwaysWrite || !fs.existsSync(absPath)) {
      try {
        fs.writeFileSync(absPath, make());
      } catch (e) {
        warnings.push(`could not generate ${relPath}: ${e.message}`);
        return null;
      }
    }
    if (this.genDone) this.genDone.add(relPath);
    return relPath;
  }

  materialize() {
    const written = [];
    const warnings = [];
    this.genDone = new Set();

    // every lighting cvar the app can override anywhere - the save/restore
    // plumbing (texswap_prev_* cvars + lightrestore.cfg) covers this union
    const lightCvarUnion = [...new Set([
      ...Object.keys((this.data.lighting && this.data.lighting.global) || {}),
      ...Object.values(this.data.maps).flatMap(e => e && e.lighting ? Object.keys(e.lighting) : []),
    ])];
    fs.mkdirSync(path.join(this.dir, 'gen'), { recursive: true });

    const maps = this.install.listMaps();
    for (const map of maps) {
      if (map.error) continue;
      const entry = this.enabled ? this.data.maps[map.name] : null;
      const lines = [
        `// TexSwap - auto-generated for map "${map.name}", do not edit`,
        'unlink --all',
      ];
      let active = 0;

      if (entry) {
        for (const [from, spec] of Object.entries(entry.swaps)) {
          const exts = this.#fromExts(from, spec);
          for (const ext of exts) {
            const target = this.#ensureGen(spec, ext, warnings, from);
            if (target) {
              lines.push(`link textures/${from}${ext} ${target}`);
              active++;
            }
          }
        }
        if (entry.sky && entry.sky.to && map.sky) {
          lines.push(`link env/${map.sky} env/${entry.sky.to}`);
          active++;
        }
      }

      // global missing-texture fix: every texture the install lacks gets the
      // user's chosen placeholder style, on every map (explicit swaps win)
      const MF = this.data.missingFix;
      if (this.enabled && MF && MF.enabled) {
        const spec = { type: 'flat', color: MF.color, style: MF.style };
        if (MF.color2) spec.color2 = MF.color2;
        if (MF.scale && MF.scale !== 1) spec.scale = MF.scale;
        for (const name of this.install.missingTextures(map.file)) {
          if (entry && entry.swaps[name]) continue;
          for (const ext of ['.png', '.wal']) {
            const target = this.#ensureGen(spec, ext, warnings);
            if (target) {
              lines.push(`link textures/${name}${ext} ${target}`);
              active++;
            }
          }
        }
      }

      // lighting: the manage toggle gates the GLOBAL defaults; a per-map
      // override is an explicit choice and always applies on its map
      const cfgPath = path.join(this.dir, `${map.name}.cfg`);
      let prev = null;
      try { prev = fs.readFileSync(cfgPath, 'utf8'); } catch { /* new file */ }
      let lightingActive = false;
      const L = this.data.lighting;
      const perMap = entry && entry.lighting ? entry.lighting : null;
      const lightSet = new Map();
      let extra = [];
      if (this.enabled && (L.manage || perMap)) {
        const merged = { ...(L.manage ? L.global : {}), ...(perMap || {}) };
        extra = L.manage
          ? (L.extra || '').split('\n').map(s => s.trim()).filter(Boolean)
          : [];
        for (const [k, v] of Object.entries(merged)) lightSet.set(k, v);
      }

      // sticky-cvar hygiene via engine macros: before overriding, the cfg
      // SAVES the player's live values (whatever they are right now - launch
      // config, an exec'd profile cfg, console tweaks) into texswap_prev_*
      // and marks texswap_light_dirty; every cfg opens by invoking the
      // restore alias (defined in hook.cfg), which puts the saved values
      // back exactly once when something was overridden.
      if (lightSet.size || extra.length) {
        lines.push('texswap_lightrestore${texswap_light_dirty}');
        for (const k of lightCvarUnion) lines.push(`set texswap_prev_${k} \${${k}}`);
        lines.push('// lighting');
        for (const [k, v] of lightSet) lines.push(`set ${k} "${v}"`);
        lines.push(...extra);
        lines.push('set texswap_light_dirty 1');
        lightingActive = true;
      } else if (lightCvarUnion.length) {
        // nothing to set here: restore (with its own r_reload) only fires
        // when a previous map's override left values behind
        lines.push('texswap_lightrestorer${texswap_light_dirty}');
      }

      // A map that HAD links (from swaps or the missing-fix) must r_reload
      // even with zero links now, otherwise unlink alone leaves the old
      // images in the engine's texture cache and stock never comes back.
      const touched = Boolean(this.data.maps[map.name]) || Boolean(prev && /^link /m.test(prev));
      if (active || lightingActive) {
        lines.push(`echo [texswap] applied ${active} link(s)${lightingActive ? ' + lighting' : ''} for ${map.name}`);
        lines.push('r_reload');
      } else if (touched) {
        lines.push(`echo [texswap] ${map.name} back to stock`);
        lines.push('r_reload');
      }
      const text = lines.join('\n') + '\n';
      if (prev !== text) {
        fs.writeFileSync(cfgPath, text);
        written.push(`texswap/${map.name}.cfg`);
      }
    }

    const hook = [
      '// TexSwap hook - exec\'d from autoexec.cfg',
      '// Applies this map\'s texture preset every time a map starts,',
      '// and binds F9 to re-apply instantly while playing.',
      // ${...} braces are required: "$cl_mapname.cfg" would parse the macro
      // name as "cl_mapname.cfg" and expand to nothing (engine-verified).
      'set cl_beginmapcmd "exec texswap/${cl_mapname}.cfg"',
      // manual re-apply always forces a texture reload, so removing swaps
      // reverts visually even when the cfg itself carries no r_reload
      'bind F9 "exec texswap/${cl_mapname}.cfg; r_reload"',
      '// lighting save/restore plumbing: per-map cfgs save your live values',
      '// into texswap_prev_* before overriding and flag texswap_light_dirty;',
      '// the restore aliases put them back (lightrestore.cfg is generated)',
      'set texswap_light_dirty 0',
      'alias texswap_lightrestore0 " "',
      'alias texswap_lightrestorer0 " "',
      'alias texswap_lightrestore1 "exec texswap/lightrestore.cfg"',
      'alias texswap_lightrestorer1 "exec texswap/lightrestore.cfg;r_reload"',
      '',
    ].join('\n');
    const restoreCfg = [
      '// TexSwap - puts your own light values back after a map override',
      ...lightCvarUnion.map(k => `set ${k} \${texswap_prev_${k}}`),
      'set texswap_light_dirty 0',
      '',
    ].join('\n');
    const restorePath = path.join(this.dir, 'lightrestore.cfg');
    let prevRestore = null;
    try { prevRestore = fs.readFileSync(restorePath, 'utf8'); } catch { /* new file */ }
    if (prevRestore !== restoreCfg) {
      fs.writeFileSync(restorePath, restoreCfg);
      written.push('texswap/lightrestore.cfg');
    }
    const hookPath = path.join(this.dir, 'hook.cfg');
    let prevHook = null;
    try { prevHook = fs.readFileSync(hookPath, 'utf8'); } catch { /* new file */ }
    if (prevHook !== hook) {
      fs.writeFileSync(hookPath, hook);
      written.push('texswap/hook.cfg');
    }

    return { written, warnings };
  }

  hookStatus() {
    const autoexec = path.join(this.install.writeDir, 'autoexec.cfg');
    let installed = false;
    try {
      installed = fs.readFileSync(autoexec, 'utf8').includes('texswap/hook');
    } catch { /* no autoexec yet */ }
    return { autoexec, installed };
  }

  installHook() {
    const { autoexec, installed } = this.hookStatus();
    if (!installed) {
      let text = '';
      try { text = fs.readFileSync(autoexec, 'utf8'); } catch { /* creating */ }
      if (text.length && !text.endsWith('\n')) text += '\n';
      text += `${HOOK_LINE}   // added by TexSwap\n`;
      fs.writeFileSync(autoexec, text);
    }
    this.materialize();
    return this.hookStatus();
  }
}
