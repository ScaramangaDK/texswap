// Generated texture files: flat/visibility textures and same-extension
// transcodes of stock textures (the engine picks its image decoder by the
// requested extension, so link targets must match the source extension).
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { loadRgba, resizeRgba, TEXTURE_EXTS, TEXTURE_EXTS_LOW } from './thumbs.js';

// --- encoders (all take {width, height, data: RGBA Buffer}) ---

export function encodePngFile(img) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

export function encodeJpgFile(img) {
  return jpeg.encode({ width: img.width, height: img.height, data: img.data }, 90).data;
}

export function encodeTgaFile(img) {
  // type 2 (uncompressed truecolor), 32bpp, top-origin
  const { width: w, height: h, data } = img;
  const out = Buffer.alloc(18 + w * h * 4);
  out[2] = 2;
  out.writeUInt16LE(w, 12);
  out.writeUInt16LE(h, 14);
  out[16] = 32;
  out[17] = 0x28; // 8 alpha bits + top-origin
  for (let i = 0; i < w * h; i++) {
    const q = 18 + i * 4, s = i * 4;
    out[q] = data[s + 2]; out[q + 1] = data[s + 1]; out[q + 2] = data[s]; out[q + 3] = data[s + 3];
  }
  return out;
}

function nearestPaletteIndex(palette, r, g, b) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < 255; i++) { // skip 255 (transparency index)
    const dr = palette[i * 3] - r, dg = palette[i * 3 + 1] - g, db = palette[i * 3 + 2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

export function encodeWalFile(img, palette, name = 'texswap') {
  if (!palette) throw new Error('wal encoding needs the Q2 palette');
  // wal wants mippable dims: round down to multiple of 16 (4 mip levels).
  // Modern engines take large wals (AQtion ships 512s), so preserve the
  // source resolution - capping would change in-game tiling density.
  let scaled = resizeRgba(img, 1024);
  const w = Math.max(16, scaled.width & ~15);
  const h = Math.max(16, scaled.height & ~15);
  if (w !== scaled.width || h !== scaled.height) {
    scaled = exactResize(scaled, w, h);
  }
  // quantize with a small cache (flat textures hit it constantly)
  const cache = new Map();
  const mips = [];
  let mip = scaled;
  for (let level = 0; level < 4; level++) {
    const idx = Buffer.alloc(mip.width * mip.height);
    for (let i = 0; i < idx.length; i++) {
      // transparent texels become palette index 255 - the engine's hole
      // marker on trans/alphatest surfaces. Without this, swapped fences
      // and grates render as solid slabs in wal mode.
      if (mip.data[i * 4 + 3] < 128) { idx[i] = 255; continue; }
      const r = mip.data[i * 4], g = mip.data[i * 4 + 1], b = mip.data[i * 4 + 2];
      const key = (r << 16) | (g << 8) | b;
      let pi = cache.get(key);
      if (pi === undefined) { pi = nearestPaletteIndex(palette, r, g, b); cache.set(key, pi); }
      idx[i] = pi;
    }
    mips.push({ w: mip.width, h: mip.height, idx });
    if (level < 3) mip = exactResize(mip, Math.max(1, mip.width >> 1), Math.max(1, mip.height >> 1));
  }
  const header = 100;
  const total = header + mips.reduce((s, m) => s + m.idx.length, 0);
  const out = Buffer.alloc(total);
  out.write(name.slice(0, 31), 0, 'latin1');
  out.writeUInt32LE(w, 32);
  out.writeUInt32LE(h, 36);
  let ofs = header;
  mips.forEach((m, i) => { out.writeUInt32LE(ofs, 40 + i * 4); m.idx.copy(out, ofs); ofs += m.idx.length; });
  return out;
}

function exactResize(img, dw, dh) {
  const { width: sw, height: sh, data: src } = img;
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(x * sw / dw));
      const s = (sy * sw + sx) * 4, d = (y * dw + x) * 4;
      dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
    }
  }
  return { width: dw, height: dh, data: dst };
}

export function encodeAs(ext, img, palette, name) {
  switch (ext) {
    case '.png': return encodePngFile(img);
    case '.jpg': case '.jpeg': return encodeJpgFile(img);
    case '.tga': return encodeTgaFile(img);
    case '.wal': return encodeWalFile(img, palette, name);
    default: throw new Error('cannot encode ' + ext);
  }
}

// --- flat/visibility texture generator ---

export function parseColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) throw new Error('bad color ' + hex);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export const FLAT_STYLES = ['solid', 'grid', 'checker', 'stripes', 'diag', 'diamond'];

// q2pro's generated "notexture" shown on missing textures in-game: an 8x8
// red-on-black dot pattern built from dottexture[i & 3][j & 3] (see q2pro
// src/refresh/texture.c GL_InitDefaultTexture). Reproduced texel-exact.
const NOTEX_DOT4 = [
  [0, 0, 0, 0],
  [0, 0, 1, 1],
  [0, 1, 1, 1],
  [0, 1, 1, 1],
];
export function notextureImage(size = 128) {
  // in-game the tiny 8x8 texture repeats across the whole surface, so the
  // preview tiles it too (2px texels at 128) - a dense field of red dots
  const texel = Math.max(1, Math.round(size / 64));
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = NOTEX_DOT4[Math.floor(y / texel) & 3][Math.floor(x / texel) & 3];
      const i = (y * size + x) * 4;
      data[i] = on ? 255 : 0;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

export function flatImage(colorHex, style = 'solid', size = 128, patternHex = null, scale = 1) {
  const [r, g, b] = parseColor(colorHex);
  const data = Buffer.alloc(size * size * 4);
  // pattern lines: explicit second color if given, else a darker shade
  const dark = patternHex
    ? parseColor(patternHex)
    : [Math.max(0, r - 28), Math.max(0, g - 28), Math.max(0, b - 28)];
  const sc = Math.min(8, Math.max(0.25, Number(scale) || 1));
  const cell = Math.max(4, Math.round(size / 4 * sc)); // 32px cells at 128, 1x
  const lw = Math.max(1, Math.round(size / 64));       // 2px lines at 128
  const half = Math.floor(cell / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let isDark = false;
      switch (style) {
        case 'grid':
          // lines centered in the tile so previews look symmetric and tiling stays seamless
          isDark = ((x + half) % cell) < lw || ((y + half) % cell) < lw;
          break;
        case 'checker':
          isDark = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) === 1;
          break;
        case 'stripes':
          isDark = ((y + half) % cell) < lw;
          break;
        case 'diag':
          isDark = (((x - y) % cell) + cell) % cell < lw;
          break;
        case 'diamond':
          // both 45-degree directions crossing - a diagonal lattice
          isDark = (((x - y) % cell) + cell) % cell < lw || (x + y) % cell < lw;
          break;
      }
      const px = isDark ? dark : [r, g, b];
      const o = (y * size + x) * 4;
      data[o] = px[0]; data[o + 1] = px[1]; data[o + 2] = px[2]; data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

// Fully transparent RGBA image (for "invisible" swaps; png/tga only - WAL has no alpha).
export function transparentImage(size = 64) {
  return { width: size, height: size, data: Buffer.alloc(size * size * 4) };
}

// Resample by a scale factor: box-filter down, crisp nearest up.
export function scaleRgba(img, scale) {
  if (!scale || scale === 1) return img;
  if (scale < 1) {
    return resizeRgba(img, Math.max(16, Math.round(Math.max(img.width, img.height) * scale)));
  }
  return exactResize(img,
    Math.min(2048, Math.round(img.width * scale)),
    Math.min(2048, Math.round(img.height * scale)));
}

// Resample to an exact grid. The engine tiles by the served file's dims, so
// gen files are built in the ORIGINAL surface's mapping grid (times the swap
// scale) - that keeps the game and the 3D viewer in lockstep.
export function resizeToGrid(img, gridW, gridH) {
  const w = Math.max(16, Math.min(2048, Math.round(gridW)));
  const h = Math.max(16, Math.min(2048, Math.round(gridH)));
  if (img.width === w && img.height === h) return img;
  return exactResize(img, w, h);
}

// Decode the best existing variant of a texture and re-encode it as `ext`,
// optionally rescaled (the served size is what the engine tiles by).
// Holes decode to alpha 0 (wal/pcx index 255, or real image alpha) so every
// encoder can carry them through; wal output prefers the wal/pcx source,
// where index-255 hole placement is the engine truth.
export function transcode(gameFs, palette, targetBasePath, ext, name, scale = 1) {
  const order = ext === '.wal' ? TEXTURE_EXTS_LOW : TEXTURE_EXTS;
  const img = loadRgba(gameFs, targetBasePath, palette, order, { transparent255: true });
  if (!img) throw new Error('target has no image file: ' + targetBasePath);
  return encodeAs(ext, scaleRgba(img, scale), palette, name);
}
