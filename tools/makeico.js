// Build a proper multi-size Windows .ico from one large transparent PNG:
// node tools/makeico.js <src.png> <dst.ico> [png256out] [png128out]
// - auto-crops to the artwork's alpha bounding box (+2% margin) so the art
//   fills the icon tile like a normal app icon
// - entries: BMP (32-bit BGRA + AND mask) for 16/24/32/48 - the format
//   Explorer is most reliable with at small sizes - and PNG for 64/128/256
import fs from 'node:fs';
import path from 'node:path';
import { decodeImage } from '../core/decoders.js';
import { resizeRgba, encodePng } from '../core/thumbs.js';

const [src, dst, png256out, png128out] = process.argv.slice(2);
const img = decodeImage(fs.readFileSync(src), path.extname(src).toLowerCase());

// auto-crop to alpha bounding box
let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] > 8) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error('image is fully transparent');
const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02);
minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
maxX = Math.min(img.width - 1, maxX + pad); maxY = Math.min(img.height - 1, maxY + pad);
// square crop centered on the bbox
const bw = maxX - minX + 1, bh = maxY - minY + 1;
const side = Math.max(bw, bh);
let sx = Math.max(0, minX - ((side - bw) >> 1));
let sy = Math.max(0, minY - ((side - bh) >> 1));
sx = Math.min(sx, img.width - side); sy = Math.min(sy, img.height - side);
const crop = { width: side, height: side, data: Buffer.alloc(side * side * 4) };
for (let y = 0; y < side; y++) {
  const so = ((sy + y) * img.width + sx) * 4;
  img.data.copy(crop.data, y * side * 4, so, so + side * 4);
}

const sizeTo = n => {
  const out = resizeRgba(crop, n);
  if (out.width === n && out.height === n) return out;
  // resizeRgba keeps aspect; crop is square so this only pads rounding cases
  const exact = { width: n, height: n, data: Buffer.alloc(n * n * 4) };
  for (let y = 0; y < Math.min(n, out.height); y++) {
    out.data.copy(exact.data, y * n * 4, y * out.width * 4, y * out.width * 4 + Math.min(n, out.width) * 4);
  }
  return exact;
};

function bmpEntry(im) {
  const { width: w, height: h, data } = im;
  const xorSize = w * h * 4;
  const andStride = ((w + 31) >> 5) * 4;
  const andSize = andStride * h;
  const buf = Buffer.alloc(40 + xorSize + andSize);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(w, 4);
  buf.writeInt32LE(h * 2, 8); // XOR + AND heights
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(xorSize + andSize, 20);
  // BGRA rows, bottom-up
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    const dstRow = 40 + y * w * 4;
    for (let x = 0; x < w; x++) {
      buf[dstRow + x * 4] = data[srcRow + x * 4 + 2];
      buf[dstRow + x * 4 + 1] = data[srcRow + x * 4 + 1];
      buf[dstRow + x * 4 + 2] = data[srcRow + x * 4];
      buf[dstRow + x * 4 + 3] = data[srcRow + x * 4 + 3];
    }
  }
  // AND mask stays zeroed - the 32-bit alpha channel governs transparency
  return buf;
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = SIZES.map(n => {
  const im = sizeTo(n);
  return { n, data: n <= 48 ? bmpEntry(im) : encodePng(im) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
const dir = Buffer.alloc(16 * entries.length);
let ofs = 6 + dir.length;
entries.forEach((e, i) => {
  const o = i * 16;
  dir[o] = e.n === 256 ? 0 : e.n;
  dir[o + 1] = e.n === 256 ? 0 : e.n;
  dir.writeUInt16LE(1, o + 4);
  dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(e.data.length, o + 8);
  dir.writeUInt32LE(ofs, o + 12);
  ofs += e.data.length;
});
fs.writeFileSync(dst, Buffer.concat([header, dir, ...entries.map(e => e.data)]));
console.log(`wrote ${dst}: ${entries.length} sizes (${SIZES.join(', ')}), cropped ${img.width}x${img.height} -> ${side}x${side}`);

if (png256out) fs.writeFileSync(png256out, encodePng(sizeTo(256)));
if (png128out) fs.writeFileSync(png128out, encodePng(sizeTo(128)));
