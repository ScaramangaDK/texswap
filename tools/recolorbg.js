// Recolor an image's outer background (flood-filled from the edges over
// near-black pixels) to a given hex color, leaving interior darks untouched:
// node tools/recolorbg.js <src> <dst> <hex> [threshold]
import fs from 'node:fs';
import path from 'node:path';
import { decodeImage } from '../core/decoders.js';
import { encodePng } from '../core/thumbs.js';

const [src, dst, hex, thr] = process.argv.slice(2);
const threshold = Number(thr) || 30;
const m = /^#?([0-9a-f]{6})$/i.exec(hex);
if (!m) throw new Error('bad hex color');
const v = parseInt(m[1], 16);
const [tr, tg, tb] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];

const img = decodeImage(fs.readFileSync(src), path.extname(src).toLowerCase());
const { width: w, height: h, data } = img;
const dark = i => Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) <= threshold || data[i * 4 + 3] < 40;
const seen = new Uint8Array(w * h);
const stack = [];
for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
let filled = 0;
while (stack.length) {
  const i = stack.pop();
  if (seen[i] || !dark(i)) continue;
  seen[i] = 1;
  data[i * 4] = tr; data[i * 4 + 1] = tg; data[i * 4 + 2] = tb; data[i * 4 + 3] = 255;
  filled++;
  const x = i % w, y = (i / w) | 0;
  if (x > 0) stack.push(i - 1);
  if (x < w - 1) stack.push(i + 1);
  if (y > 0) stack.push(i - w);
  if (y < h - 1) stack.push(i + w);
}
fs.writeFileSync(dst, encodePng(img));
console.log(`wrote ${dst}: recolored ${filled} background pixels of ${w}x${h}`);
