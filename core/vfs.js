// GameFS — a read-only virtual filesystem over an AQ2/AQtion game dir (e.g. baseaq):
// loose files + .pak (Quake PACK) + .pkz (zip) archives, case-insensitive paths.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZIP_EOCD = 0x06054b50;
const ZIP_CDIR = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

function readZipIndex(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === ZIP_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('no zip end-of-central-directory');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOfs = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOfs);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== ZIP_CDIR) break;
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOfs = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (!name.endsWith('/')) {
        entries.set(normPath(name), { method, csize, usize, localOfs });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { fd, entries };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

function readZipEntry(fd, entry) {
  const head = Buffer.alloc(30);
  fs.readSync(fd, head, 0, 30, entry.localOfs);
  if (head.readUInt32LE(0) !== ZIP_LOCAL) throw new Error('bad zip local header');
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const data = Buffer.alloc(entry.csize);
  fs.readSync(fd, data, 0, entry.csize, entry.localOfs + 30 + nameLen + extraLen);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error('unsupported zip compression method ' + entry.method);
}

function readPakIndex(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a PACK file');
    const dirOfs = head.readUInt32LE(4);
    const dirLen = head.readUInt32LE(8);
    const dir = Buffer.alloc(dirLen);
    fs.readSync(fd, dir, 0, dirLen, dirOfs);
    const entries = new Map();
    for (let p = 0; p + 64 <= dirLen; p += 64) {
      let name = dir.toString('latin1', p, p + 56);
      const nul = name.indexOf('\0');
      if (nul >= 0) name = name.slice(0, nul);
      entries.set(normPath(name), { ofs: dir.readUInt32LE(p + 56), len: dir.readUInt32LE(p + 60) });
    }
    return { fd, entries };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

export function normPath(p) {
  return p.replaceAll('\\', '/').toLowerCase();
}

function walkLoose(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let items;
    try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const childRel = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) stack.push(childRel);
      else if (it.isFile()) out.push(childRel);
    }
  }
  return out;
}

export class GameFS {
  constructor(gameDir) {
    this.gameDir = gameDir;
    this.warnings = [];
    // Search order (first hit wins): loose files, then archives sorted Z→A so pak9 beats
    // pak0 like the engine's newest-on-top behavior. TODO(verify vs q2pro source): exact
    // loose-vs-pak precedence; irrelevant for scanning unless duplicates differ.
    this.index = new Map(); // normPath -> { source, read() ref data }
    this.archives = [];

    const loose = walkLoose(gameDir);
    for (const rel of loose) {
      const n = normPath(rel);
      if (n.endsWith('.pak') || n.endsWith('.pkz') || n.endsWith('.zip')) continue;
      if (!this.index.has(n)) this.index.set(n, { source: 'loose', abs: path.join(gameDir, rel) });
    }

    const archNames = loose
      .filter(r => /\.(pak|pkz|zip)$/i.test(r) && !r.includes('/'))
      .sort((a, b) => b.localeCompare(a, 'en'));
    for (const rel of archNames) {
      const abs = path.join(gameDir, rel);
      try {
        const isPak = /\.pak$/i.test(rel);
        const arch = isPak ? readPakIndex(abs) : readZipIndex(abs);
        arch.name = rel;
        arch.isPak = isPak;
        this.archives.push(arch);
        for (const [n, entry] of arch.entries) {
          if (!this.index.has(n)) this.index.set(n, { source: rel, arch, entry });
        }
      } catch (e) {
        this.warnings.push(`skipped archive ${rel}: ${e.message}`);
      }
    }
  }

  describeSources() {
    return this.archives.map(a => `${a.name} (${a.entries.size} files)`);
  }

  has(p) {
    return this.index.has(normPath(p));
  }

  sourceOf(p) {
    const ref = this.index.get(normPath(p));
    return ref ? ref.source : null;
  }

  read(p) {
    const ref = this.index.get(normPath(p));
    if (!ref) return null;
    if (ref.source === 'loose') return fs.readFileSync(ref.abs);
    if (ref.arch.isPak) {
      const data = Buffer.alloc(ref.entry.len);
      fs.readSync(ref.arch.fd, data, 0, ref.entry.len, ref.entry.ofs);
      return data;
    }
    return readZipEntry(ref.arch.fd, ref.entry);
  }

  // All indexed paths matching a predicate, e.g. p => p.startsWith('maps/')
  list(pred) {
    const out = [];
    for (const p of this.index.keys()) if (pred(p)) out.push(p);
    out.sort();
    return out;
  }

  // Try basePath with each extension, return { path, buf } of first hit.
  findFirst(basePath, exts) {
    for (const ext of exts) {
      const p = normPath(basePath + ext);
      if (this.index.has(p)) return { path: p, buf: this.read(p) };
    }
    return null;
  }

  close() {
    for (const a of this.archives) {
      try { fs.closeSync(a.fd); } catch { /* already closed */ }
    }
  }
}
