// Thumbnail pipeline: resolve a texture name to its best image file
// (engine-style hi-res first), decode, downscale, encode as PNG.
import { PNG } from 'pngjs';
import { decodeImage, imageSize } from './decoders.js';

// Hi-res-first mirrors the engine's override mode; low-res-first mirrors
// playing with world texture overrides off (original .wal/.pcx files).
export const TEXTURE_EXTS = ['.png', '.tga', '.jpg', '.wal', '.pcx'];
export const TEXTURE_EXTS_LOW = ['.wal', '.pcx', '.png', '.tga', '.jpg'];

export function resolveImage(gameFs, basePath, exts = TEXTURE_EXTS) {
  for (const ext of exts) {
    const p = (basePath + ext).toLowerCase();
    if (gameFs.has(p)) return { path: p, ext, source: gameFs.sourceOf(p) };
  }
  return null;
}

export function loadRgba(gameFs, basePath, palette, exts = TEXTURE_EXTS) {
  const hit = resolveImage(gameFs, basePath, exts);
  if (!hit) return null;
  const buf = gameFs.read(hit.path);
  return { ...decodeImage(buf, hit.ext, palette), path: hit.path, ext: hit.ext, source: hit.source };
}

export function sizeOf(gameFs, basePath, exts = TEXTURE_EXTS) {
  const hit = resolveImage(gameFs, basePath, exts);
  if (!hit) return null;
  const buf = gameFs.read(hit.path);
  const dims = imageSize(buf, hit.ext);
  return dims ? { ...dims, ext: hit.ext, source: hit.source } : null;
}

// Simple box-filter downscale to fit maxDim.
export function resizeRgba(img, maxDim = 128) {
  const { width: sw, height: sh, data: src } = img;
  if (sw <= maxDim && sh <= maxDim) return img;
  const scale = Math.min(maxDim / sw, maxDim / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sh / dh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sw / dw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const q = (yy * sw + xx) * 4;
          r += src[q]; g += src[q + 1]; b += src[q + 2]; a += src[q + 3];
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n; dst[o + 3] = a / n;
    }
  }
  return { width: dw, height: dh, data: dst };
}

export function encodePng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

export function makeThumbPng(gameFs, basePath, palette, maxDim = 128, exts = TEXTURE_EXTS) {
  const img = loadRgba(gameFs, basePath, palette, exts);
  if (!img) return null;
  return encodePng(resizeRgba(img, maxDim));
}
