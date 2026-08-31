// Crop a square region out of the logo and save small marks:
// node tools/croplogo.js <src> <dst> <x0Frac> <y0Frac> <sizeFrac> <outSize>
import fs from 'node:fs';
import path from 'node:path';
import { decodeImage } from '../core/decoders.js';
import { resizeRgba, encodePng } from '../core/thumbs.js';

const [src, dst, x0f, y0f, sf, outSize] = process.argv.slice(2);
const buf = fs.readFileSync(src);
const img = decodeImage(buf, path.extname(src).toLowerCase());
const s = Math.floor(img.width * Number(sf));
const x0 = Math.floor(img.width * Number(x0f));
const y0 = Math.floor(img.height * Number(y0f));
const crop = { width: s, height: s, data: Buffer.alloc(s * s * 4) };
for (let y = 0; y < s; y++) {
  const srcOff = ((y0 + y) * img.width + x0) * 4;
  img.data.copy(crop.data, y * s * 4, srcOff, srcOff + s * 4);
}
const out = resizeRgba(crop, Number(outSize) || 256);
fs.writeFileSync(dst, encodePng(out));
console.log(`wrote ${dst} (${out.width}x${out.height}) from ${s}x${s} @ (${x0},${y0}) of ${img.width}x${img.height}`);
