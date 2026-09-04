// SkinStore — weapon model skins (and replacement models) per install.
// Masters live in app-data next to the texture presets; the game sees them
// through texswap/skins/<weapon>/ files plus `link` lines that the swap
// store writes INLINE into hook.cfg (startup, before the first map loads
// its models) and into every map cfg right after its `unlink --all`.
// Inline, not `exec`: the engine counts nested execs in one command-buffer
// run against a small loop guard (ALIAS_LOOP_COUNT), and a typical AQ2
// startup chain already sits near it. Shipped game files are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { decodeImage } from './decoders.js';
import { encodePng, resolveImage, resizeRgba } from './thumbs.js';
import { resizeToGrid, encodeAs } from './gen.js';
import { parseMd2, md2Info, isMd2, skinBase, md2ToClient, drawUvOverlay } from './md2.js';
import { encodePcxFile } from './pcx.js';
import { upscalePng } from './tools.js';

const SKIN_EXTS = ['.png', '.tga', '.jpg', '.pcx'];
// q2pro refuses images above MAX_TEXTURE_SIZE on either side ("invalid image
// dimensions") - masters may be bigger, but what the game gets is fitted.
export const MAX_GAME_TEX = 4096;
const WEAPON_RE = /^models\/weapons\/([a-z0-9_-]+)\/tris\.md2$/;

const NAMES = {
  aq2: {
    v_blast: 'MK23 Pistol', v_dual: 'Dual MK23', v_knife: 'Combat Knife', v_m4: 'M4 Assault Rifle',
    v_machn: 'MP5 Submachine Gun', v_shotg: 'M3 Super 90 Shotgun', v_cannon: 'Handcannon',
    v_sniper: 'SSG 3000 Sniper Rifle', v_handgr: 'Hand Grenade',
    g_cannon: 'Handcannon (dropped)', g_dual: 'Dual MK23 (dropped)', g_m4: 'M4 (dropped)',
    g_machn: 'MP5 (dropped)', g_shotg: 'M3 (dropped)', g_sniper: 'SSG 3000 (dropped)',
    grapple: 'Grapple hook', shell: 'Shell casing',
  },
  q2: {
    v_blast: 'Blaster', v_shotg: 'Shotgun', v_shotg2: 'Super Shotgun', v_machn: 'Machinegun',
    v_chain: 'Chaingun', v_launch: 'Grenade Launcher', v_rocket: 'Rocket Launcher',
    v_hyperb: 'HyperBlaster', v_rail: 'Railgun', v_bfg: 'BFG10K', v_handgr: 'Grenades',
    g_shotg: 'Shotgun (world)', g_shotg2: 'Super Shotgun (world)', g_machn: 'Machinegun (world)',
    g_chain: 'Chaingun (world)', g_launch: 'Grenade Launcher (world)', g_rocket: 'Rocket Launcher (world)',
    g_hyperb: 'HyperBlaster (world)', g_rail: 'Railgun (world)', g_bfg: 'BFG10K (world)',
  },
};

function kindOf(name) {
  if (name.startsWith('v_')) return 'view';
  if (name.startsWith('g_')) return 'world';
  return 'other';
}

function safeName(name) {
  return /^[a-z0-9_-]{1,32}$/.test(String(name || '')) ? name : null;
}

// nearest-neighbour enlarge (keeps texels crisp under the UV wireframe)
function enlargeNearest(img, factor) {
  const { width: sw, height: sh, data: src } = img;
  const dw = sw * factor, dh = sh * factor;
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < dw; x++) {
      const s = (sy * sw + Math.floor(x / factor)) * 4, d = (y * dw + x) * 4;
      dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
    }
  }
  return { width: dw, height: dh, data: dst };
}

export class SkinStore {
  constructor(install) {
    this.install = install;
    this.dataDir = path.join(install.swaps.dataDir, 'skins');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.file = path.join(install.swaps.dataDir, 'skins.json');
    this.outDir = path.join(install.writeDir, 'texswap', 'skins');
    this.data = { version: 1, enabled: true, weapons: {} };
    this.parsedCache = new Map();
    this.imgCache = new Map();
    this.pngCache = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.weapons && typeof raw.weapons === 'object') {
        this.data.enabled = raw.enabled !== false;
        for (const [name, e] of Object.entries(raw.weapons)) {
          if (!safeName(name) || !e || typeof e !== 'object') continue;
          const clean = {};
          const ok = f => f && typeof f.file === 'string' && /^[a-z0-9_.-]+$/i.test(f.file) &&
            fs.existsSync(path.join(this.dataDir, f.file));
          if (ok(e.skin)) clean.skin = e.skin;
          if (ok(e.skinPrev)) clean.skinPrev = e.skinPrev;
          if (ok(e.model)) clean.model = e.model;
          if (Object.keys(clean).length) this.data.weapons[name] = clean;
        }
      }
    } catch { /* fresh */ }
  }

  #save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  #entry(name, create = false) {
    if (!this.data.weapons[name] && create) this.data.weapons[name] = {};
    return this.data.weapons[name] || null;
  }

  #label(name) {
    const table = NAMES[this.install.game === 'aq2' ? 'aq2' : 'q2'] || {};
    return table[name] || name;
  }

  weaponNames() {
    return this.install.fs.list(p => WEAPON_RE.test(p)).map(p => WEAPON_RE.exec(p)[1]);
  }

  #checkWeapon(name) {
    const n = safeName(name);
    if (!n || !this.install.fs.has(`models/weapons/${n}/tris.md2`)) throw new Error('unknown weapon model: ' + name);
    return n;
  }

  // Parsed current model (replacement if set, else the install's).
  parsedModel(name) {
    const e = this.#entry(name);
    const key = name + '|' + (e && e.model ? e.model.file : 'stock');
    if (this.parsedCache.has(key)) return this.parsedCache.get(key);
    const buf = e && e.model
      ? fs.readFileSync(path.join(this.dataDir, e.model.file))
      : this.install.fs.read(`models/weapons/${name}/tris.md2`);
    if (!buf) throw new Error('model file missing: ' + name);
    const parsed = parseMd2(buf);
    this.parsedCache.set(key, parsed);
    return parsed;
  }

  // Where the engine will ask for the current model's skin (no extension).
  skinBaseFor(name) {
    const parsed = this.parsedModel(name);
    return skinBase(parsed.skins[0], `models/weapons/${name}`);
  }

  // The install's own skin for the current model, decoded (null if the
  // install has no image for the path the model names).
  stockSkinImage(name) {
    const key = 'stock|' + name + '|' + this.skinBaseFor(name);
    if (this.imgCache.has(key)) return this.imgCache.get(key);
    let img = null;
    const dir = `models/weapons/${name}`;
    for (const base of [this.skinBaseFor(name), dir + '/skin']) {
      const hit = resolveImage(this.install.fs, base, SKIN_EXTS);
      if (!hit) continue;
      try {
        img = { ...decodeImage(this.install.fs.read(hit.path), hit.ext, this.install.palette), ext: hit.ext, path: hit.path, source: hit.source };
        break;
      } catch { /* try the next candidate */ }
    }
    this.imgCache.set(key, img);
    return img;
  }

  currentSkinImage(name) {
    const e = this.#entry(name);
    if (e && e.skin) {
      const key = 'master|' + e.skin.file;
      if (!this.imgCache.has(key)) {
        this.imgCache.set(key, decodeImage(fs.readFileSync(path.join(this.dataDir, e.skin.file)), '.png'));
      }
      return this.imgCache.get(key);
    }
    return this.stockSkinImage(name);
  }

  listWeapons() {
    const out = [];
    for (const name of this.weaponNames()) {
      const dir = `models/weapons/${name}`;
      const e = this.#entry(name) || {};
      const stockBuf = this.install.fs.read(dir + '/tris.md2');
      const stock = md2Info(stockBuf);
      const w = {
        name, dir, label: this.#label(name), kind: kindOf(name),
        source: this.install.fs.sourceOf(dir + '/tris.md2'),
        stock: stock ? { frames: stock.frames, skinW: stock.skinW, skinH: stock.skinH, tris: stock.tris, skin: stock.skins[0] || null } : null,
        skin: e.skin ? { w: e.skin.w, h: e.skin.h, label: e.skin.label || '', at: e.skin.at } : null,
        canUndo: Boolean(e.skinPrev),
        model: e.model ? { frames: e.model.frames, skinW: e.model.skinW, skinH: e.model.skinH, label: e.model.label || '', at: e.model.at, skin: (e.model.skins || [])[0] || null } : null,
        stockSkin: null,
        error: stock ? null : 'not a readable md2',
      };
      if (stock) {
        try {
          const s = this.stockSkinImage(name);
          w.stockSkin = s ? { w: s.width, h: s.height, ext: s.ext, source: s.source } : null;
          w.skinBase = this.skinBaseFor(name);
        } catch (err) {
          w.error = err.message;
        }
      }
      out.push(w);
    }
    const rank = { view: 0, world: 1, other: 2 };
    out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label, 'en'));
    return out;
  }

  summary() {
    const active = Object.entries(this.data.weapons).filter(([, e]) => e && (e.skin || e.model)).length;
    return { enabled: this.data.enabled, active };
  }

  active() {
    return this.data.enabled && this.summary().active > 0;
  }

  clientModel(name) {
    return md2ToClient(this.parsedModel(this.#checkWeapon(name)));
  }

  // PNG of the current or stock skin, optionally with the UV wireframe.
  imagePng(name, { which = 'current', uv = false, maxDim = 1024 } = {}) {
    name = this.#checkWeapon(name);
    const e = this.#entry(name) || {};
    const stamp = which === 'stock' ? 'stock' : (e.skin ? e.skin.at : 'stock') + '|' + (e.model ? e.model.at : 's');
    const key = `${name}|${which}|${uv ? 'uv' : 'plain'}|${maxDim}|${stamp}`;
    if (this.pngCache.has(key)) return this.pngCache.get(key);
    let img = which === 'stock' ? this.stockSkinImage(name) : this.currentSkinImage(name);
    if (!img) return null;
    img = { width: img.width, height: img.height, data: Buffer.from(img.data) };
    if (uv) {
      const factor = Math.max(1, Math.min(4, Math.ceil(1024 / img.width)));
      if (factor > 1) img = enlargeNearest(img, factor);
      drawUvOverlay(this.parsedModel(name), img);
    }
    const png = encodePng(resizeRgba(img, maxDim));
    if (this.pngCache.size > 40) this.pngCache.clear();
    this.pngCache.set(key, png);
    return png;
  }

  #storeFile(name, ext, buf) {
    const file = `${name}-${Date.now().toString(36)}${ext}`;
    fs.writeFileSync(path.join(this.dataDir, file), buf);
    return file;
  }

  #dropFile(f) {
    if (!f || !f.file) return;
    try { fs.unlinkSync(path.join(this.dataDir, f.file)); } catch { /* already gone */ }
  }

  // Shipped hi-res skins do not keep their model header's aspect (AQ2's
  // 512x256 M4 layout ships as a 1280x400 png), so the reference that says
  // whether an upload "fits" is the install's own skin when it has one.
  #aspectWarning(name, w, h, warnings) {
    try {
      const m = this.parsedModel(name);
      // with a replacement model the install's skin belongs to another
      // model, so the header of the new model is the only reference
      const e = this.#entry(name);
      const stock = e && e.model ? null : this.stockSkinImage(name);
      const rw = stock ? stock.width : m.skinW, rh = stock ? stock.height : m.skinH;
      const a = w / h, b = rw / rh;
      if (Math.abs(a - b) / b > 0.03) {
        warnings.push(`${name}: image is ${w}×${h}, the model's skin is ${rw}×${rh} - different proportions, so the skin will look stretched`);
      }
    } catch { /* model problems are reported elsewhere */ }
  }

  setSkinImage(name, buf, ext, label = '') {
    name = this.#checkWeapon(name);
    const warnings = [];
    const img = decodeImage(buf, ext, this.install.palette);
    if (img.width > 8192 || img.height > 8192) throw new Error('image too large (max 8192px)');
    const e = this.#entry(name, true);
    const file = this.#storeFile(name, '.png', ext === '.png' ? buf : encodePng(img));
    if (e.skin) {
      this.#dropFile(e.skinPrev);
      e.skinPrev = e.skin; // one-step undo
    }
    e.skin = { file, w: img.width, h: img.height, label: String(label || '').slice(0, 60), at: Date.now() };
    if (img.width > MAX_GAME_TEX || img.height > MAX_GAME_TEX) {
      warnings.push(`${name}: ${img.width}×${img.height} is above the game's ${MAX_GAME_TEX}px limit - the game gets a fitted copy, the full image stays in your collection`);
    }
    this.#aspectWarning(name, img.width, img.height, warnings);
    this.#save();
    const r = this.materialize();
    return { weapon: name, written: r.written, warnings: [...warnings, ...r.warnings] };
  }

  undoSkin(name) {
    name = this.#checkWeapon(name);
    const e = this.#entry(name);
    if (!e || !e.skinPrev) throw new Error('nothing to undo');
    this.#dropFile(e.skin);
    e.skin = e.skinPrev;
    delete e.skinPrev;
    this.#save();
    return { weapon: name, ...this.materialize() };
  }

  setModel(name, buf, label = '') {
    name = this.#checkWeapon(name);
    const warnings = [];
    if (!isMd2(buf)) throw new Error('not a Quake 2 md2 model');
    const parsed = parseMd2(buf); // throws on anything broken
    const stock = md2Info(this.install.fs.read(`models/weapons/${name}/tris.md2`));
    if (stock && parsed.nFrames < stock.frames) {
      warnings.push(`${name}: replacement has ${parsed.nFrames} frames, the original ${stock.frames} - the game plays the original's frame numbers, so some animations may look wrong`);
    }
    const e = this.#entry(name, true);
    this.#dropFile(e.model);
    const file = this.#storeFile(name, '.md2', buf);
    e.model = { file, frames: parsed.nFrames, skinW: parsed.skinW, skinH: parsed.skinH, skins: parsed.skins.slice(0, 4), label: String(label || '').slice(0, 60), at: Date.now() };
    this.parsedCache.clear();
    this.imgCache.clear();
    this.pngCache.clear();
    if (!e.skin) {
      const s = this.stockSkinImage(name);
      if (!s) warnings.push(`${name}: your install has no skin at the path this model names (${this.skinBaseFor(name)}) - upload a skin for it`);
      else warnings.push(`${name}: showing the install's ${s.width}×${s.height} skin on the new model - upload the model's own skin if it looks wrong`);
    } else {
      this.#aspectWarning(name, e.skin.w, e.skin.h, warnings);
    }
    this.#save();
    const r = this.materialize();
    return { weapon: name, written: r.written, warnings: [...warnings, ...r.warnings] };
  }

  async upscale(name, scale = 4, model = 'detail') {
    name = this.#checkWeapon(name);
    const img = this.currentSkinImage(name);
    if (!img) throw new Error('no skin image to upscale');
    const side = Math.max(img.width, img.height);
    const fits = s => side * s <= MAX_GAME_TEX;
    const wanted = [4, 3, 2].includes(Number(scale)) ? Number(scale) : 4;
    const use = [wanted, 3, 2].find(s => s <= wanted && fits(s));
    if (!use) throw new Error(`already ${img.width}×${img.height} - the game's limit is ${MAX_GAME_TEX}px per side, so it cannot be upscaled further`);
    const out = await upscalePng(encodePng({ width: img.width, height: img.height, data: img.data }), { scale: use, model });
    const e = this.#entry(name) || {};
    const prevLabel = e.skin && e.skin.label ? e.skin.label + ' · ' : '';
    const r = this.setSkinImage(name, out, '.png', `${prevLabel}AI ${use}x`);
    if (use !== wanted) r.warnings.unshift(`${name}: used ${use}x instead of ${wanted}x - ${wanted}x would exceed the game's ${MAX_GAME_TEX}px texture limit`);
    return r;
  }

  reset(name, what = 'all') {
    name = this.#checkWeapon(name);
    const e = this.#entry(name);
    if (!e) return { weapon: name, written: [], warnings: [] };
    if (what === 'skin' || what === 'all') { this.#dropFile(e.skin); this.#dropFile(e.skinPrev); delete e.skin; delete e.skinPrev; }
    if (what === 'model' || what === 'all') { this.#dropFile(e.model); delete e.model; }
    if (!e.skin && !e.model) delete this.data.weapons[name];
    this.parsedCache.clear();
    this.imgCache.clear();
    this.pngCache.clear();
    this.#save();
    return { weapon: name, ...this.materialize() };
  }

  setEnabled(on) {
    this.data.enabled = Boolean(on);
    this.#save();
    return this.materialize();
  }

  // Write texswap/skins/<weapon>/*, compute the link lines, then let the swap
  // store refresh hook.cfg and the map cfgs (they inline the lines when any
  // skin is active).
  materialize() {
    const written = [];
    const warnings = [];
    fs.mkdirSync(this.outDir, { recursive: true });
    const lines = [];
    const keep = new Set();
    if (this.data.enabled) {
      for (const [name, e] of Object.entries(this.data.weapons)) {
        if (!e || (!e.skin && !e.model)) continue;
        const dir = `models/weapons/${name}`;
        if (!this.install.fs.has(dir + '/tris.md2')) { warnings.push(`${name}: not in this install, skipped`); continue; }
        let parsed;
        try { parsed = this.parsedModel(name); } catch (err) { warnings.push(`${name}: ${err.message}`); continue; }
        const out = path.join(this.outDir, name);
        fs.mkdirSync(out, { recursive: true });
        keep.add(name);
        const rel = `texswap/skins/${name}`;
        if (e.model) {
          const src = path.join(this.dataDir, e.model.file);
          const dst = path.join(out, 'tris.md2');
          let same = false;
          try { same = fs.statSync(dst).size === fs.statSync(src).size && fs.readFileSync(dst).equals(fs.readFileSync(src)); } catch { /* missing */ }
          if (!same) { fs.copyFileSync(src, dst); written.push(`${rel}/tris.md2`); }
          lines.push(`link ${dir}/tris.md2 ${rel}/tris.md2`);
        }
        if (e.skin) {
          const base = skinBase(parsed.skins[0], dir);
          // shadow every extension the engine may ask for: hi-res overrides
          // (.png first; .tga/.jpg only when the install has one) and the
          // paletted .pcx the model names for the low-res path
          const exts = ['.png', '.pcx'];
          for (const ext of ['.tga', '.jpg']) if (this.install.fs.has(base + ext)) exts.push(ext);
          const stamp = `${e.skin.at}|${parsed.skinW}x${parsed.skinH}|${exts.join('')}|max${MAX_GAME_TEX}`;
          let prevStamp = null;
          try { prevStamp = fs.readFileSync(path.join(out, 'skin.stamp'), 'utf8'); } catch { /* new */ }
          if (prevStamp !== stamp || exts.some(x => !fs.existsSync(path.join(out, 'skin' + x)))) {
            const master = fs.readFileSync(path.join(this.dataDir, e.skin.file));
            let img = decodeImage(master, '.png');
            const fitted = img.width > MAX_GAME_TEX || img.height > MAX_GAME_TEX;
            if (fitted) img = resizeRgba(img, MAX_GAME_TEX);
            for (const ext of exts) {
              try {
                let bytes;
                if (ext === '.png') bytes = fitted ? encodePng(img) : master;
                else if (ext === '.pcx') {
                  if (!this.install.palette) throw new Error('no Q2 palette in this install');
                  bytes = encodePcxFile(resizeToGrid(img, parsed.skinW, parsed.skinH), this.install.palette);
                } else bytes = encodeAs(ext, img, this.install.palette, name);
                fs.writeFileSync(path.join(out, 'skin' + ext), bytes);
                written.push(`${rel}/skin${ext}`);
              } catch (err) {
                warnings.push(`${name}: could not write skin${ext}: ${err.message}`);
              }
            }
            fs.writeFileSync(path.join(out, 'skin.stamp'), stamp);
          }
          for (const ext of exts) {
            if (fs.existsSync(path.join(out, 'skin' + ext))) lines.push(`link ${base}${ext} ${rel}/skin${ext}`);
          }
        }
      }
    }
    // prune output for weapons no longer overridden
    try {
      for (const d of fs.readdirSync(this.outDir)) {
        if (!keep.has(d)) fs.rmSync(path.join(this.outDir, d), { recursive: true, force: true });
      }
    } catch { /* nothing to prune */ }
    this.lines = lines;
    // an early build exec'd a separate skins.cfg - it must not linger
    try { fs.unlinkSync(path.join(this.install.writeDir, 'texswap', 'skins.cfg')); } catch { /* none */ }
    const r = this.install.swaps.materialize();
    return { written: [...written, ...r.written], warnings: [...warnings, ...r.warnings] };
  }

  // The `link` lines the swap store inlines into hook.cfg and every map cfg.
  // Computed by materialize(); a fresh store computes them on first use.
  cfgLines() {
    if (!this.lines) {
      if (!this.active()) return [];
      // build without recursing into the swap store
      const swaps = this.install.swaps;
      const saved = swaps.materialize;
      swaps.materialize = () => ({ written: [], warnings: [] });
      try { this.materialize(); } finally { swaps.materialize = saved; }
    }
    return this.lines;
  }

  // The shareable object: skin + model embedded as base64.
  exportObject(name) {
    name = this.#checkWeapon(name);
    const e = this.#entry(name);
    if (!e || (!e.skin && !e.model)) throw new Error('nothing custom on ' + name);
    const obj = { kind: 'skin', app: 'TexSwap', version: 1, weapon: name, label: this.#label(name), skin: null, model: null };
    if (e.skin) {
      obj.skin = { w: e.skin.w, h: e.skin.h, label: e.skin.label || '', b64: fs.readFileSync(path.join(this.dataDir, e.skin.file)).toString('base64') };
    }
    if (e.model) {
      obj.model = { frames: e.model.frames, label: e.model.label || '', b64: fs.readFileSync(path.join(this.dataDir, e.model.file)).toString('base64') };
    }
    return obj;
  }

  exportSkin(name, displayName = '') {
    const obj = this.exportObject(name);
    if (displayName) obj.name = String(displayName).slice(0, 40);
    const expDir = path.join(this.install.writeDir, 'texswap', 'exports');
    fs.mkdirSync(expDir, { recursive: true });
    const file = path.join(expDir, `${name}.aq2skin.json`);
    fs.writeFileSync(file, JSON.stringify(obj));
    return { file, size: fs.statSync(file).size };
  }

  importSkin(obj) {
    if (!obj || obj.kind !== 'skin') throw new Error('not a skin file');
    const name = this.#checkWeapon(obj.weapon);
    const warnings = [];
    const written = [];
    if (obj.model && typeof obj.model.b64 === 'string') {
      const r = this.setModel(name, Buffer.from(obj.model.b64, 'base64'), obj.model.label || 'imported');
      warnings.push(...r.warnings); written.push(...r.written);
    }
    if (obj.skin && typeof obj.skin.b64 === 'string') {
      const r = this.setSkinImage(name, Buffer.from(obj.skin.b64, 'base64'), '.png', obj.skin.label || 'imported');
      warnings.push(...r.warnings); written.push(...r.written);
    }
    if (!obj.model && !obj.skin) throw new Error('skin file is empty');
    return { weapon: name, label: this.#label(name), written, warnings };
  }
}
