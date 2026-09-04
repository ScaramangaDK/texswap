// LibraryStore — the skin collection: .aq2skin.json files from two places.
//   bundled: <app>/library/**  (ships with the program, read-only)
//   mine:    <app-data>/installs/<install>/library/  (saved + imported)
// An entry is one skin (and optionally a model) for one weapon; applying it
// hands the embedded files to the SkinStore. Thumbnails are decoded lazily.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeImage } from './decoders.js';
import { encodePng, resizeRgba } from './thumbs.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLED_DIR = path.join(APP_ROOT, 'library');

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) stack.push(p);
      else if (it.isFile() && /\.aq2skin\.json$/i.test(it.name)) out.push(p);
    }
  }
  return out.sort();
}

function cleanName(s, fallback) {
  const n = String(s || '').replace(/[^\w .()'&+-]/g, '').trim().slice(0, 40);
  return n || fallback;
}

export class LibraryStore {
  constructor(install) {
    this.install = install;
    this.dir = path.join(install.swaps.dataDir, 'library');
    fs.mkdirSync(this.dir, { recursive: true });
    this.index = null; // id -> entry
    this.thumbCache = new Map();
  }

  #id(file) {
    return crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 12);
  }

  // Read only the header fields of a skin file (the base64 payloads stay
  // on disk until applied), tolerating hand-edited or partial files.
  #peek(file, source) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    if (!obj || obj.kind !== 'skin' || !/^[a-z0-9_-]{1,32}$/.test(String(obj.weapon || ''))) return null;
    let st = null;
    try { st = fs.statSync(file); } catch { /* listed but unreadable */ }
    return {
      id: this.#id(file),
      file,
      source,
      weapon: obj.weapon,
      name: cleanName(obj.name, cleanName(obj.skin && obj.skin.label, path.basename(file, '.aq2skin.json'))),
      author: cleanName(obj.author, ''),
      skin: obj.skin ? { w: Number(obj.skin.w) || 0, h: Number(obj.skin.h) || 0 } : null,
      model: obj.model ? { frames: Number(obj.model.frames) || 0 } : null,
      at: st ? st.mtimeMs : 0,
      size: st ? st.size : 0,
    };
  }

  #load(force = false) {
    if (this.index && !force) return this.index;
    this.index = new Map();
    for (const f of walk(BUNDLED_DIR)) {
      const e = this.#peek(f, 'bundled');
      if (e) this.index.set(e.id, e);
    }
    for (const f of walk(this.dir)) {
      const e = this.#peek(f, 'mine');
      if (e) this.index.set(e.id, e);
    }
    return this.index;
  }

  refresh() {
    this.#load(true);
    this.thumbCache.clear();
  }

  list(weapon = null) {
    const all = [...this.#load().values()];
    const out = weapon ? all.filter(e => e.weapon === weapon) : all;
    // bundled first, then newest of mine
    out.sort((a, b) => (a.source === b.source ? 0 : a.source === 'bundled' ? -1 : 1) ||
      (a.source === 'mine' ? b.at - a.at : a.name.localeCompare(b.name, 'en')));
    return out.map(e => ({ ...e, file: undefined }));
  }

  entry(id) {
    const e = this.#load().get(String(id || ''));
    if (!e) throw new Error('not in the collection: ' + id);
    return e;
  }

  read(id) {
    const e = this.entry(id);
    return JSON.parse(fs.readFileSync(e.file, 'utf8'));
  }

  thumbPng(id, maxDim = 256) {
    const key = id + '@' + maxDim;
    if (this.thumbCache.has(key)) return this.thumbCache.get(key);
    let png = null;
    try {
      const obj = this.read(id);
      if (obj.skin && obj.skin.b64) {
        const img = decodeImage(Buffer.from(obj.skin.b64, 'base64'), '.png');
        png = encodePng(resizeRgba(img, maxDim));
      }
    } catch { png = null; }
    if (this.thumbCache.size > 200) this.thumbCache.clear();
    this.thumbCache.set(key, png);
    return png;
  }

  // Make the entry the weapon's active skin (and model, if it carries one).
  apply(id) {
    const e = this.entry(id);
    const r = this.install.skins.importSkin(this.read(id));
    return { ...r, applied: e.name };
  }

  #fileFor(weapon, name) {
    const base = `${weapon}-${name.replace(/[^\w-]+/g, '_').toLowerCase()}`.slice(0, 60);
    let f = path.join(this.dir, base + '.aq2skin.json');
    for (let n = 2; fs.existsSync(f); n++) f = path.join(this.dir, `${base}-${n}.aq2skin.json`);
    return f;
  }

  // Save the weapon's current custom skin/model into my collection.
  saveCurrent(weapon, name, author = '') {
    const obj = this.install.skins.exportObject(weapon);
    obj.name = cleanName(name, obj.label);
    if (author) obj.author = cleanName(author, '');
    const file = this.#fileFor(weapon, obj.name);
    fs.writeFileSync(file, JSON.stringify(obj));
    this.refresh();
    return { id: this.#id(file), name: obj.name, file };
  }

  // A skin file from a friend: keep it in the collection AND apply it.
  importSkin(obj, apply = true) {
    if (!obj || obj.kind !== 'skin') throw new Error('not a skin file');
    if (!/^[a-z0-9_-]{1,32}$/.test(String(obj.weapon || ''))) throw new Error('skin file has no valid weapon name');
    const name = cleanName(obj.name, cleanName(obj.skin && obj.skin.label, 'imported'));
    obj.name = name;
    const file = this.#fileFor(obj.weapon, name);
    fs.writeFileSync(file, JSON.stringify(obj));
    this.refresh();
    const result = { id: this.#id(file), name, weapon: obj.weapon, written: [], warnings: [] };
    if (apply) {
      const r = this.install.skins.importSkin(obj);
      result.written = r.written; result.warnings = r.warnings; result.label = r.label;
    }
    return result;
  }

  delete(id) {
    const e = this.entry(id);
    if (e.source !== 'mine') throw new Error('shipped skins cannot be deleted');
    fs.unlinkSync(e.file);
    this.refresh();
    return { ok: true };
  }
}
