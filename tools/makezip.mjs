// Packs dist/win-unpacked into dist/TexSwap-win64.zip with everything under
// a top-level TexSwap/ folder, so "extract here" gives one tidy folder and
// nobody drags a bare exe out of the archive. Dependency-free zip writer
// (deflate via node:zlib).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'dist', 'win-unpacked');
const OUT = path.join(ROOT, 'dist', 'TexSwap-win64.zip');
const PREFIX = 'TexSwap/';

const crc32 = buf => zlib.crc32(buf) >>> 0;

function dosDateTime(mtime) {
  const d = new Date(mtime);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function* walk(dir, rel = '') {
  for (const it of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, it.name);
    const r = rel ? rel + '/' + it.name : it.name;
    if (it.isDirectory()) yield* walk(abs, r);
    else if (it.isFile()) yield { abs, rel: r };
  }
}

if (!fs.existsSync(path.join(SRC, 'TexSwap.exe'))) {
  console.error('dist/win-unpacked/TexSwap.exe not found - run electron-builder first');
  process.exit(1);
}
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
const fd = fs.openSync(OUT, 'w');
let offset = 0;
const central = [];
let files = 0;

for (const { abs, rel } of walk(SRC)) {
  const raw = fs.readFileSync(abs);
  const crc = crc32(raw);
  let method = 8;
  let data = zlib.deflateRawSync(raw, { level: 6 });
  if (data.length >= raw.length) { method = 0; data = raw; }
  const name = Buffer.from(PREFIX + rel.replaceAll('\\', '/'), 'utf8');
  const { time, date } = dosDateTime(fs.statSync(abs).mtimeMs);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(time, 12);
  cen.writeUInt16LE(date, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([cen, name]));

  fs.writeSync(fd, local);
  fs.writeSync(fd, name);
  fs.writeSync(fd, data);
  offset += local.length + name.length + data.length;
  files++;
}

const cdStart = offset;
for (const c of central) {
  fs.writeSync(fd, c);
  offset += c.length;
}
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files, 8);
eocd.writeUInt16LE(files, 10);
eocd.writeUInt32LE(offset - cdStart, 12);
eocd.writeUInt32LE(cdStart, 16);
fs.writeSync(fd, eocd);
fs.closeSync(fd);
console.log(`dist/TexSwap-win64.zip: ${files} files, ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(0)} MB`);

// Mirror the fresh build into the extracted run folder (if one exists), so
// the local test install updates in place without re-extracting the zip.
const RUN = path.join(ROOT, 'dist', 'TexSwap-win64', 'TexSwap');
function syncDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const want = new Set();
  for (const it of fs.readdirSync(src, { withFileTypes: true })) {
    want.add(it.name);
    const s = path.join(src, it.name);
    const d = path.join(dst, it.name);
    if (it.isDirectory()) syncDir(s, d);
    else fs.copyFileSync(s, d);
  }
  for (const name of fs.readdirSync(dst)) {
    if (!want.has(name)) fs.rmSync(path.join(dst, name), { recursive: true, force: true });
  }
}
if (fs.existsSync(RUN)) {
  try {
    syncDir(SRC, RUN);
    console.log('run folder updated in place: ' + RUN);
  } catch (e) {
    console.log('run folder NOT updated (' + e.code + ') - close TexSwap and run npm run dist again');
  }
}
