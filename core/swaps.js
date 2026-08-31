// SwapStore — per-install swap presets plus materialization into the game:
// texswap/<map>.cfg files (hard `link` commands), generated texture files in
// texswap/gen/, hook.cfg, and the autoexec.cfg hook line.
//
// Everything written lives under <writeDir>/texswap/ except one appended line
// in <writeDir>/autoexec.cfg. Shipped game files are never modified.
import fs from 'node:fs';
import path from 'node:path';
import { flatImage, transcode, encodeAs } from './gen.js';
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

export class SwapStore {
  constructor(install) {
    this.install = install;
    this.dir = path.join(install.writeDir, 'texswap');
    this.file = path.join(this.dir, 'presets.json');
    this.data = { version: 2, enabled: true, maps: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.maps) {
        this.data = { version: 2, enabled: raw.enabled !== false, maps: raw.maps };
      }
    } catch { /* no presets yet */ }
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
    const e = this.mapEntry(mapName, true);
    if (spec === null) delete e.swaps[from];
    else e.swaps[from] = spec;
    return this.#saveAndMaterialize();
  }

  setSky(mapName, to) {
    const e = this.mapEntry(mapName, true);
    e.sky = to ? { to } : null;
    return this.#saveAndMaterialize();
  }

  resetMap(mapName) {
    const e = this.data.maps[mapName];
    if (e) {
      // keep saved presets; only clear the working state
      e.swaps = {};
      e.sky = null;
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
    e.saved[clean] = { swaps: structuredClone(e.swaps), sky: e.sky ? { ...e.sky } : null };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return clean;
  }

  loadPreset(mapName, name) {
    const e = this.data.maps[mapName];
    if (!e || !e.saved || !e.saved[name]) throw new Error(`no preset "${name}" for ${mapName}`);
    e.swaps = structuredClone(e.saved[name].swaps);
    e.sky = e.saved[name].sky ? { ...e.saved[name].sky } : null;
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
    if (!Object.keys(swaps).length && !sky) throw new Error('nothing to export - no swaps on this map');
    const obj = {
      app: 'aq2-texture-swapper',
      format: 1,
      exported: new Date().toISOString(),
      map: mapName,
      swaps,
      sky,
    };
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
    const swaps = {};
    for (const [from, spec] of Object.entries(obj.swaps)) {
      if (spec && spec.type === 'flat' && typeof spec.color === 'string') swaps[from] = spec;
      else if (spec && spec.type === 'stock' && typeof spec.to === 'string') {
        if (!this.install.fs.findFirst('textures/' + spec.to, ALL_TEX_EXTS.concat('.pcx'))) {
          warnings.push(`replacement "${spec.to}" not found here - skipped for ${from}`);
          continue;
        }
        swaps[from] = spec;
      }
    }
    const e = this.mapEntry(obj.map, true);
    e.swaps = swaps;
    e.sky = obj.sky && obj.sky.to ? { to: obj.sky.to } : null;
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
    let fileBase, make;
    if (spec.type === 'flat') {
      fileBase = `flat-${spec.color.replace('#', '')}-${spec.style || 'solid'}`;
      make = () => encodeAs(ext, flatImage(spec.color, spec.style), this.install.palette, fileBase);
    } else if (spec.type === 'stock') {
      fileBase = sanitize(spec.to);
      make = () => transcode(this.install.fs, this.install.palette, 'textures/' + spec.to, ext, fileBase);
    } else {
      warnings.push(`unknown swap type ${spec.type}`);
      return null;
    }
    const relPath = `texswap/gen/${fileBase}${ext}`;
    const absPath = path.join(this.install.writeDir, 'texswap', 'gen', fileBase + ext);
    if (!fs.existsSync(absPath)) {
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
          for (const ext of this.#fromExts(from)) {
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

      if (active) {
        lines.push(`echo [texswap] applied ${active} link(s) for ${map.name}`);
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
      'bind F9 "exec texswap/${cl_mapname}.cfg"',
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
