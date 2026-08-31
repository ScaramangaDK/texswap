// Image decoders for Quake 2 formats (WAL, PCX, TGA) plus PNG/JPG via libs.
// All decode to { width, height, data: Buffer(RGBA) }.
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const MAX_DIM = 8192;

function checkDims(w, h, what) {
  if (!(w > 0 && h > 0 && w <= MAX_DIM && h <= MAX_DIM)) {
    throw new Error(`${what}: implausible dimensions ${w}x${h}`);
  }
}

// --- WAL (8-bit paletted, needs the Q2 palette: Buffer of 768 RGB bytes) ---

export function decodeWal(buf, palette) {
  const w = buf.readUInt32LE(32);
  const h = buf.readUInt32LE(36);
  const ofs = buf.readUInt32LE(40);
  checkDims(w, h, 'wal');
  if (ofs + w * h > buf.length) throw new Error('wal: pixel data out of bounds');
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = buf[ofs + i] * 3;
    rgba[i * 4] = palette[c];
    rgba[i * 4 + 1] = palette[c + 1];
    rgba[i * 4 + 2] = palette[c + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data: rgba };
}

// --- PCX (8-bit RLE with trailing VGA palette) ---

export function decodePcx(buf) {
  if (buf[0] !== 0x0a) throw new Error('not a pcx');
  const bpp = buf[3];
  const xmin = buf.readUInt16LE(4), ymin = buf.readUInt16LE(6);
  const xmax = buf.readUInt16LE(8), ymax = buf.readUInt16LE(10);
  const planes = buf[65];
  const bpl = buf.readUInt16LE(66);
  const w = xmax - xmin + 1, h = ymax - ymin + 1;
  checkDims(w, h, 'pcx');
  if (bpp !== 8 || planes !== 1) throw new Error(`pcx: unsupported format (bpp=${bpp}, planes=${planes})`);

  const idx = Buffer.alloc(w * h);
  let p = 128;
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < bpl && p < buf.length) {
      let b = buf[p++];
      let n = 1;
      if ((b & 0xc0) === 0xc0) { n = b & 0x3f; b = buf[p++]; }
      for (let i = 0; i < n; i++) { if (x < w) idx[y * w + x] = b; x++; }
    }
  }
  let palette = null;
  if (buf.length > 769 && buf[buf.length - 769] === 0x0c) palette = buf.subarray(buf.length - 768);

  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (palette) {
      const c = idx[i] * 3;
      rgba[i * 4] = palette[c]; rgba[i * 4 + 1] = palette[c + 1]; rgba[i * 4 + 2] = palette[c + 2];
    } else {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = idx[i];
    }
    rgba[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data: rgba, palette };
}

// --- TGA (types 1/2/3 and RLE 9/10/11) ---

export function decodeTga(buf) {
  const idLen = buf[0], cmapType = buf[1], type = buf[2];
  const cmapFirst = buf.readUInt16LE(3), cmapLen = buf.readUInt16LE(5), cmapDepth = buf[7];
  const w = buf.readUInt16LE(12), h = buf.readUInt16LE(14);
  const bpp = buf[16], desc = buf[17];
  checkDims(w, h, 'tga');
  const topOrigin = (desc & 0x20) !== 0;
  let p = 18 + idLen;
  let cmap = null;
  if (cmapType === 1) {
    const cbytes = cmapLen * (cmapDepth >> 3);
    cmap = buf.subarray(p, p + cbytes);
    p += cbytes;
  }
  const bytes = Math.max(1, bpp >> 3);
  const count = w * h;
  const pix = Buffer.alloc(count * bytes);
  if (type === 2 || type === 3 || type === 1) {
    buf.copy(pix, 0, p, p + count * bytes);
  } else if (type === 9 || type === 10 || type === 11) {
    let o = 0;
    while (o < count * bytes && p < buf.length) {
      const hdr = buf[p++];
      const n = (hdr & 0x7f) + 1;
      if (hdr & 0x80) {
        for (let i = 0; i < n && o < count * bytes; i++) { buf.copy(pix, o, p, p + bytes); o += bytes; }
        p += bytes;
      } else {
        buf.copy(pix, o, p, p + n * bytes);
        o += n * bytes; p += n * bytes;
      }
    }
  } else {
    throw new Error('tga: unsupported image type ' + type);
  }

  const rgba = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) {
    let r = 0, g = 0, b = 0, a = 255;
    if (type === 1 || type === 9) {
      const cb = (pix[i] - cmapFirst) * (cmapDepth >> 3);
      if (cmap && cmapDepth >= 24) {
        b = cmap[cb]; g = cmap[cb + 1]; r = cmap[cb + 2];
        if (cmapDepth === 32) a = cmap[cb + 3];
      }
    } else if (type === 3 || type === 11) {
      r = g = b = pix[i];
    } else {
      const q = i * bytes;
      b = pix[q]; g = pix[q + 1]; r = pix[q + 2];
      if (bytes === 4) a = pix[q + 3];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }

  if (!topOrigin) {
    const row = w * 4;
    const tmp = Buffer.alloc(row);
    for (let y = 0; y < (h >> 1); y++) {
      const top = y * row, bot = (h - 1 - y) * row;
      rgba.copy(tmp, 0, top, top + row);
      rgba.copy(rgba, top, bot, bot + row);
      tmp.copy(rgba, bot);
    }
  }
  return { width: w, height: h, data: rgba };
}

// --- dispatch by extension ---

export function decodeImage(buf, ext, palette) {
  switch (ext) {
    case '.png': {
      const png = PNG.sync.read(buf);
      return { width: png.width, height: png.height, data: png.data };
    }
    case '.jpg':
    case '.jpeg': {
      const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
      return { width: img.width, height: img.height, data: Buffer.from(img.data) };
    }
    case '.tga': return decodeTga(buf);
    case '.pcx': return decodePcx(buf);
    case '.wal': {
      if (!palette) throw new Error('wal needs palette');
      return decodeWal(buf, palette);
    }
    default: throw new Error('unknown image extension ' + ext);
  }
}

// Cheap header-only dimension sniffing (no full decode).
export function imageSize(buf, ext) {
  try {
    switch (ext) {
      case '.png':
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
      case '.tga':
        return { w: buf.readUInt16LE(12), h: buf.readUInt16LE(14) };
      case '.wal':
        return { w: buf.readUInt32LE(32), h: buf.readUInt32LE(36) };
      case '.pcx':
        return { w: buf.readUInt16LE(8) - buf.readUInt16LE(4) + 1, h: buf.readUInt16LE(10) - buf.readUInt16LE(6) + 1 };
      case '.jpg':
      case '.jpeg': {
        let p = 2;
        while (p + 9 < buf.length) {
          if (buf[p] !== 0xff) { p++; continue; }
          const marker = buf[p + 1];
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { w: buf.readUInt16BE(p + 7), h: buf.readUInt16BE(p + 5) };
          }
          p += 2 + buf.readUInt16BE(p + 2);
        }
        return null;
      }
      default: return null;
    }
  } catch {
    return null;
  }
}
