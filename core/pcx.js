// PCX encoder (8-bit paletted, RLE) for model skins: the engine's low-res
// path reads the .pcx a model names, so a swapped skin needs one next to
// the hi-res .png. Colors snap to the Quake 2 palette (index 255 = hole).

function nearestIndex(palette, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < 255; i++) {
    const dr = palette[i * 3] - r, dg = palette[i * 3 + 1] - g, db = palette[i * 3 + 2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function encodePcxFile(img, palette) {
  if (!palette) throw new Error('pcx encoding needs the Q2 palette');
  const { width: w, height: h, data } = img;
  const bpl = w + (w & 1); // even scanline stride, like the original tools
  const cache = new Map();
  const rows = [];
  let total = 0;
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(bpl * 2); // worst case: every byte escaped
    let o = 0;
    let run = 0, prev = -1;
    const flush = () => {
      while (run > 0) {
        const n = Math.min(run, 63);
        if (n === 1 && (prev & 0xc0) !== 0xc0) row[o++] = prev;
        else { row[o++] = 0xc0 | n; row[o++] = prev; }
        run -= n;
      }
    };
    for (let x = 0; x < bpl; x++) {
      let idx = 0;
      if (x < w) {
        const s = (y * w + x) * 4;
        if (data[s + 3] < 128) idx = 255;
        else {
          const key = (data[s] << 16) | (data[s + 1] << 8) | data[s + 2];
          idx = cache.get(key);
          if (idx === undefined) { idx = nearestIndex(palette, data[s], data[s + 1], data[s + 2]); cache.set(key, idx); }
        }
      }
      if (idx === prev) run++;
      else { flush(); prev = idx; run = 1; }
    }
    flush();
    rows.push(row.subarray(0, o));
    total += o;
  }
  const out = Buffer.alloc(128 + total + 769);
  out[0] = 0x0a; out[1] = 5; out[2] = 1; out[3] = 8;
  out.writeUInt16LE(0, 4); out.writeUInt16LE(0, 6);
  out.writeUInt16LE(w - 1, 8); out.writeUInt16LE(h - 1, 10);
  out.writeUInt16LE(72, 12); out.writeUInt16LE(72, 14);
  out[65] = 1;
  out.writeUInt16LE(bpl, 66);
  out.writeUInt16LE(1, 68);
  let p = 128;
  for (const r of rows) { r.copy(out, p); p += r.length; }
  out[p++] = 0x0c;
  Buffer.from(palette.subarray(0, 768)).copy(out, p);
  return out;
}
