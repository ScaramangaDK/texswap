// GameFS — a read-only virtual filesystem mirroring the q2pro/AQtion search
// path across one or more game dirs (e.g. action layered over baseaq):
// per dir, non-numbered archives (Z→A) beat numbered pakN archives (high→low),
// which beat loose files; earlier game dirs beat later ones. Also applies the
// engine's *soft* links (from the shipped cfg chain) as a fallback when a file
// is missing — matching observed engine behavior.
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
    if (eocd < 0) {
      // people rename downloaded packs to .pkz without repacking - the game
      // can't read those either, so say what the file really is
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      if (head.toString('latin1').startsWith('Rar!')) {
        throw new Error('this is a RAR archive renamed to .pkz - the game cannot read it either; repack it as a zip');
      }
      if (head[0] === 0x37 && head[1] === 0x7a) {
        throw new Error('this is a 7z archive renamed to .pkz - the game cannot read it either; repack it as a zip');
      }
      throw new Error('no zip end-of-central-directory');
    }
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
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOfs = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (!name.endsWith('/')) {
        entries.set(normPath(name), { method, csize, localOfs });
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

const NUMBERED_PAK = /^pak(\d+)\.(pak|pkz)$/i;

export class GameFS {
  // rootDir: install root; gameDirs: ordered dir names, highest priority first
  constructor(rootDir, gameDirs) {
    this.rootDir = rootDir;
    this.gameDirs = gameDirs;
    this.warnings = [];
    this.index = new Map();
    this.archives = [];
    this.searchOrder = [];

    for (const gd of gameDirs) {
      const dirAbs = path.join(rootDir, gd);
      let top;
      try { top = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { continue; }
      const archNames = top
        .filter(it => it.isFile() && /\.(pak|pkz|zip)$/i.test(it.name))
        .map(it => it.name);
      const numbered = archNames.filter(n => NUMBERED_PAK.test(n))
        .sort((a, b) => Number(NUMBERED_PAK.exec(b)[1]) - Number(NUMBERED_PAK.exec(a)[1]));
      const others = archNames.filter(n => !NUMBERED_PAK.test(n))
        .sort((a, b) => b.localeCompare(a, 'en'));

      for (const name of [...others, ...numbered]) {
        const abs = path.join(dirAbs, name);
        const label = `${gd}/${name}`;
        try {
          const isPak = /\.pak$/i.test(name);
          const arch = isPak ? readPakIndex(abs) : readZipIndex(abs);
          arch.label = label;
          arch.isPak = isPak;
          this.archives.push(arch);
          this.searchOrder.push(`${label} (${arch.entries.size} files)`);
          for (const [n, entry] of arch.entries) {
            if (!this.index.has(n)) this.index.set(n, { source: label, arch, entry });
          }
        } catch (e) {
          this.warnings.push(`skipped archive ${label}: ${e.message}`);
        }
      }

      const label = `${gd} (loose)`;
      this.searchOrder.push(label);
      for (const rel of walkLoose(dirAbs)) {
        if (/\.(pak|pkz|zip)$/i.test(rel) && !rel.includes('/')) continue;
        const n = normPath(rel);
        if (!this.index.has(n)) this.index.set(n, { source: label, abs: path.join(dirAbs, rel) });
      }
    }

    this.softLinks = this.#loadSoftLinks();
  }

  // Parse the engine's shipped soft-link chain: default.cfg exec's cfg files
  // full of `softlink <name> <target>` lines. We honor them as missing-file
  // fallbacks, exactly like the engine does.
  #loadSoftLinks() {
    const links = [];
    const seen = new Set();
    const parseCfg = (name, depth) => {
      const n = normPath(name);
      if (depth > 4 || seen.has(n)) return;
      seen.add(n);
      const buf = this.#rawRead(n) || this.#rawRead('configs/' + n);
      if (!buf) return;
      for (let line of buf.toString('latin1').split('\n')) {
        line = line.trim();
        let m = /^exec\s+"?([^"\s]+)"?/i.exec(line);
        if (m) {
          parseCfg(m[1].includes('.') ? m[1] : m[1] + '.cfg', depth + 1);
          continue;
        }
        m = /^softlink\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?/i.exec(line);
        if (m) links.push({ name: normPath(m[1]), target: normPath(m[2]) });
      }
    };
    parseCfg('default.cfg', 0);
    return links;
  }

  #rawRead(p) {
    const ref = this.index.get(normPath(p));
    return ref ? this.#readRef(ref) : null;
  }

  #readRef(ref) {
    if (ref.abs) return fs.readFileSync(ref.abs);
    if (ref.arch.isPak) {
      const data = Buffer.alloc(ref.entry.len);
      fs.readSync(ref.arch.fd, data, 0, ref.entry.len, ref.entry.ofs);
      return data;
    }
    return readZipEntry(ref.arch.fd, ref.entry);
  }

  // Engine-visible lookup: real file first, then soft-link prefix fallback.
  #lookup(p) {
    const n = normPath(p);
    const direct = this.index.get(n);
    if (direct) return direct;
    for (const link of this.softLinks) {
      if (n.startsWith(link.name)) {
        const resolved = this.index.get(link.target + n.slice(link.name.length));
        if (resolved) return resolved;
      }
    }
    return null;
  }

  describeSources() {
    return this.searchOrder;
  }

  has(p) {
    return this.#lookup(p) !== null;
  }

  sourceOf(p) {
    const ref = this.#lookup(p);
    return ref ? ref.source : null;
  }

  read(p) {
    const ref = this.#lookup(p);
    return ref ? this.#readRef(ref) : null;
  }

  // All directly indexed paths matching a predicate (soft links not expanded).
  list(pred) {
    const out = [];
    for (const p of this.index.keys()) if (pred(p)) out.push(p);
    out.sort();
    return out;
  }

  findFirst(basePath, exts) {
    for (const ext of exts) {
      const p = normPath(basePath + ext);
      if (this.has(p)) return { path: p, buf: this.read(p) };
    }
    return null;
  }

  close() {
    for (const a of this.archives) {
      try { fs.closeSync(a.fd); } catch { /* already closed */ }
    }
  }
}
