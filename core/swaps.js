// SwapStore — per-install swap presets plus materialization into the game:
// texswap/<map>.cfg files (hard `link` commands), generated texture files in
// texswap/gen/, hook.cfg, and the autoexec.cfg hook line.
//
// Everything written lives under <writeDir>/texswap/ except one appended line
// in <writeDir>/autoexec.cfg. Shipped game files are never modified.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { flatImage, transcode, encodeAs, encodePngFile } from './gen.js';
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

// Per-user data root: presets survive game reinstalls/deletions here.
function appDataRoot() {
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
    this.data = { version: 2, enabled: true, lighting: { manage: false, global: {}, extra: '' }, recentFlats: [], favTextures: [], favSets: {}, maps: {} };
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
          recentFlats: Array.isArray(raw.recentFlats) ? raw.recentFlats.slice(0, 12) : [],
          favTextures: Array.isArray(raw.favTextures) ? raw.favTextures : [],
          favSets: (raw.favSets && typeof raw.favSets === 'object' && !Array.isArray(raw.favSets))
            ? Object.fromEntries(Object.entries(raw.favSets)
                .filter(([, v]) => Array.isArray(v))
                .map(([k, v]) => [k, v.filter(x => typeof x === 'string')]))
            : {},
          maps: raw.maps,
        };
        // the invisible swap type was removed before release (see-through
        // surfaces are a cheat risk): drop any stored ones, presets included
        for (const e of Object.values(this.data.maps)) {
          if (!e) continue;
          const sets = [e.swaps, ...Object.values(e.saved || {}).map(p => p && p.swaps)];
          for (const swaps of sets) {
            if (!swaps) continue;
            for (const [k, v] of Object.entries(swaps)) {
              if (v && v.type === 'invisible') delete swaps[k];
            }
          }
        }
      }
    } catch { /* no presets yet */ }
  }

  recentFlats() {
    return this.data.recentFlats || [];
  }

  favTextures() {
    return this.data.favTextures || [];
  }

  // Store an uploaded replacement image (png/jpg/tga) and swap to it.
  setCustomSwap(mapName, from, filename, buf) {
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
    return this.setSwap(mapName, from, { type: 'custom', file: rel, w: img.width, h: img.height });
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

  // Export the map's current working state as a shareable object; also writes
  // it to texswap/exports/ so the user has a file to send to friends.
  exportMap(mapName) {
    const { swaps, sky } = this.swapsFor(mapName);
    const lighting = this.mapLighting(mapName);
    if (!Object.keys(swaps).length && !sky && !lighting) throw new Error('nothing to export - no swaps on this map');
    const obj = {
      app: 'aq2-texture-swapper',
      format: 1,
      exported: new Date().toISOString(),
      map: mapName,
      swaps,
      sky,
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
    const dir = path.join(this.dir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${mapName}.aq2swap.json`);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return { obj, file };
  }

  importMap(obj) {
    if (!obj || obj.app !== 'aq2-texture-swapper' || !obj.map || typeof obj.swaps !== 'object') {
      throw new Error('not a valid .aq2swap.json preset file');
    }
    const warnings = [];
    const known = this.install.listMaps().some(m => m.name === obj.map);
    if (!known) warnings.push(`map "${obj.map}" is not in this install - preset stored, applies if you get the map`);
    const customOk = /^custom\/[a-z0-9_.-]+\.png$/i;
    const swaps = {};
    for (const [from, spec] of Object.entries(obj.swaps)) {
      if (spec && spec.type === 'flat' && typeof spec.color === 'string') swaps[from] = spec;
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
    e.sky = obj.sky && obj.sky.to ? { to: obj.sky.to } : null;
    const impLighting = cleanCvarMap(obj.lighting);
    e.lighting = Object.keys(impLighting).length ? impLighting : null;
    const result = this.#saveAndMaterialize();
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
  #fromExts(fromTexture) {
    const exts = new Set(ALL_TEX_EXTS.filter(ext => this.install.fs.has('textures/' + fromTexture + ext)));
    exts.add('.png');
    exts.add('.wal');
    return [...exts];
  }

  // Ensure the gen file for a swap spec exists in the requested extension.
  // Returns the link target path (game-relative) or null on failure.
  #ensureGen(spec, ext, warnings) {
    let fileBase, make, alwaysWrite = false;
    if (spec.type === 'flat') {
      fileBase = `flat-${spec.color.replace('#', '')}-${spec.style || 'solid'}`;
      make = () => encodeAs(ext, flatImage(spec.color, spec.style), this.install.palette, fileBase);
      alwaysWrite = true; // cheap to generate; guarantees pattern tweaks reach disk
    } else if (spec.type === 'stock') {
      fileBase = sanitize(spec.to);
      make = () => transcode(this.install.fs, this.install.palette, 'textures/' + spec.to, ext, fileBase);
    } else if (spec.type === 'custom') {
      fileBase = 'custom-' + path.basename(spec.file, '.png');
      make = () => {
        const buf = fs.readFileSync(path.join(this.dataDir, spec.file));
        return encodeAs(ext, decodeImage(buf, '.png', this.install.palette), this.install.palette, fileBase);
      };
    } else {
      warnings.push(`unknown swap type ${spec.type}`);
      return null;
    }
    const relPath = `texswap/gen/${fileBase}${ext}`;
    const absPath = path.join(this.install.writeDir, 'texswap', 'gen', fileBase + ext);
    if (alwaysWrite || !fs.existsSync(absPath)) {
      try {
        fs.writeFileSync(absPath, make());
      } catch (e) {
        warnings.push(`could not generate ${relPath}: ${e.message}`);
        return null;
      }
    }
    return relPath;
  }

  materialize() {
    const written = [];
    const warnings = [];
    fs.mkdirSync(path.join(this.dir, 'gen'), { recursive: true });

    const maps = this.install.listMaps();
    for (const map of maps) {
      if (map.error) continue;
      const entry = this.enabled ? this.data.maps[map.name] : null;
      const lines = [
        `// AQ2 Texture Swapper - auto-generated for map "${map.name}", do not edit`,
        'unlink --all',
      ];
      let active = 0;

      if (entry) {
        for (const [from, spec] of Object.entries(entry.swaps)) {
          const exts = this.#fromExts(from);
          for (const ext of exts) {
            const target = this.#ensureGen(spec, ext, warnings);
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

      // lighting: global defaults + per-map overrides, only when managed & enabled
      let lightingActive = false;
      const L = this.data.lighting;
      if (this.enabled && L.manage) {
        const merged = { ...L.global, ...(entry && entry.lighting ? entry.lighting : {}) };
        const extra = (L.extra || '').split('\n').map(s => s.trim()).filter(Boolean);
        if (Object.keys(merged).length || extra.length) {
          lines.push('// lighting');
          for (const [k, v] of Object.entries(merged)) lines.push(`set ${k} "${v}"`);
          lines.push(...extra);
          lightingActive = true;
        }
      }

      // A map the user ever touched must r_reload even with zero links now,
      // otherwise clearing a swap leaves the old image in the texture cache.
      const touched = Boolean(this.data.maps[map.name]);
      if (active || lightingActive) {
        lines.push(`echo [texswap] applied ${active} link(s)${lightingActive ? ' + lighting' : ''} for ${map.name}`);
        lines.push('r_reload');
      } else if (touched) {
        lines.push(`echo [texswap] ${map.name} back to stock`);
        lines.push('r_reload');
      }
      const cfgPath = path.join(this.dir, `${map.name}.cfg`);
      const text = lines.join('\n') + '\n';
      let prev = null;
      try { prev = fs.readFileSync(cfgPath, 'utf8'); } catch { /* new file */ }
      if (prev !== text) {
        fs.writeFileSync(cfgPath, text);
        written.push(`texswap/${map.name}.cfg`);
      }
    }

    const hook = [
      '// AQ2 Texture Swapper hook - exec\'d from autoexec.cfg',
      '// Applies this map\'s texture preset every time a map starts,',
      '// and binds F9 to re-apply instantly while playing.',
      // ${...} braces are required: "$cl_mapname.cfg" would parse the macro
      // name as "cl_mapname.cfg" and expand to nothing (engine-verified).
      'set cl_beginmapcmd "exec texswap/${cl_mapname}.cfg"',
      // manual re-apply always forces a texture reload, so removing swaps
      // reverts visually even when the cfg itself carries no r_reload
      'bind F9 "exec texswap/${cl_mapname}.cfg; r_reload"',
      '',
    ].join('\n');
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
      text += `${HOOK_LINE}   // added by AQ2 Texture Swapper\n`;
      fs.writeFileSync(autoexec, text);
    }
    this.materialize();
    return this.hookStatus();
  }
}
