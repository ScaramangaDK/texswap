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

export class SwapStore {
  constructor(install) {
    this.install = install;
    this.dir = path.join(install.writeDir, 'texswap');
    this.file = path.join(this.dir, 'presets.json');
    this.data = { version: 1, maps: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.maps) this.data = raw;
    } catch { /* no presets yet */ }
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
    delete this.data.maps[mapName];
    return this.#saveAndMaterialize();
  }

  swapsFor(mapName) {
    const e = this.data.maps[mapName];
    return { swaps: e ? e.swaps : {}, sky: e && e.sky ? e.sky : null };
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
      const entry = this.data.maps[map.name];
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

      if (active) lines.push('r_reload');
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
      'set cl_beginmapcmd "exec texswap/$cl_mapname.cfg"',
      'bind F9 "exec texswap/$cl_mapname.cfg"',
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
