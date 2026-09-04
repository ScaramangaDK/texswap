// TextureUpscaler — AI-upscaled copies of map textures (Real-ESRGAN) as a
// per-map swap type `upscale`. The upscaled image only ever replaces the
// hi-res override (.png/.tga/.jpg): the .wal keeps its grid, so tiling is
// untouched and low-res mode stays stock. Results are cached once per
// texture CONTENT in app-data and reused by every map and every install.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appDataRoot } from './swaps.js';
import { loadRgba, resolveImage, encodePng, resizeRgba, TEXTURE_EXTS, TEXTURE_EXTS_LOW } from './thumbs.js';
import { decodeImage, imageSize } from './decoders.js';
import { upscalePng, upscalerStatus } from './tools.js';

export const MAX_GAME_TEX = 4096;
const FACTORS = [4, 3, 2];
// Tiling textures are upscaled with a wrapped border so the repeat edges
// stay seamless (the upscaler otherwise sees each edge as a hard cut).
const WRAP_PAD = 16;
// bump when the generation recipe changes: old cache files are regenerated
// (v3: 2x/3x are now a proper downscale of the 4x result; 4x files unchanged)
const recipe = factor => (factor === 4 ? 'v2' : 'v3');
// keep-grain percentage, snapped to the dropdown steps
export function cleanGrain(g) {
  const v = Number(g) || 0;
  return [25, 50, 75, 100].includes(v) ? v : 0;
}

// pad an RGBA image by wrapping it around itself on all four sides
function wrapPad(img, pad) {
  const { width: w, height: h, data } = img;
  const W = w + pad * 2, H = h + pad * 2;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = ((y - pad) % h + h) % h;
    for (let x = 0; x < W; x++) {
      const sx = ((x - pad) % w + w) % w;
      data.copy(out, (y * W + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
    }
  }
  return { width: W, height: H, data: out };
}

function crop(img, x0, y0, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.data.copy(out, y * w * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4);
  }
  return { width: w, height: h, data: out };
}

function cacheDir() {
  const d = path.join(appDataRoot(), 'upscale');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// nearest-neighbour resize of the alpha channel to the upscaled size
function fitAlpha(src, dw, dh) {
  const { width: sw, height: sh, data } = src;
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / dh));
    for (let x = 0; x < dw; x++) {
      out[y * dw + x] = data[(sy * sw + Math.min(sw - 1, Math.floor(x * sw / dw))) * 4 + 3];
    }
  }
  return out;
}


// ---- grain re-injection ----
// The AI paints flat where the original was grain (rust, dirt, dithered
// plaster). "Keep grain" adds the original's fine detail back: enlarge the
// source with a plain bilinear filter, take its high-pass (detail minus a
// blur), blend that over the AI result. Structure stays from the AI, the
// surface feel from the original.
function resizeBilinear(img, dw, dh) {
  const { width: sw, height: sh, data: src } = img;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, (y + 0.5) * sh / dh - 0.5);
    const y0 = Math.min(sh - 1, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, (x + 0.5) * sw / dw - 0.5);
      const x0 = Math.min(sw - 1, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let k = 0; k < 4; k++) {
        out[o + k] = (src[a + k] * (1 - wx) + src[b + k] * wx) * (1 - wy) + (src[c + k] * (1 - wx) + src[d + k] * wx) * wy;
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

// separable box blur (two passes ~ gaussian), radius in pixels, wraps at
// the edges so tiling stays seamless
function boxBlur(img, radius) {
  const { width: w, height: h } = img;
  let src = img.data;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = Buffer.alloc(w * h * 4);
    const n = radius * 2 + 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = ((x + k) % w + w) % w;
          const i = (y * w + xx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2];
        }
        const o = (y * w + x) * 4;
        tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n; tmp[o + 3] = 255;
      }
    }
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = ((y + k) % h + h) % h;
          const i = (yy * w + x) * 4;
          r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2];
        }
        const o = (y * w + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    src = out;
  }
  return { width: w, height: h, data: src };
}

function addGrain(aiImg, srcImg, factor, amount) {
  const big = resizeBilinear(srcImg, aiImg.width, aiImg.height);
  const blur = boxBlur(big, Math.max(1, Math.round(factor * 0.75)));
  const out = Buffer.from(aiImg.data);
  const k = amount / 100;
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = out[i + c] + k * (big.data[i + c] - blur.data[i + c]);
      out[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return { width: aiImg.width, height: aiImg.height, data: out };
}

export class TextureUpscaler {
  constructor(install) {
    this.install = install;
    this.job = null;
    this.thumbCache = new Map();
  }

  // src 'auto': the best image the engine would sample in override mode
  // (community hi-res first); src 'low': the original paletted .wal/.pcx -
  // the classic art itself, just redrawn sharper.
  #exts(src) {
    return src === 'low' ? TEXTURE_EXTS_LOW : TEXTURE_EXTS;
  }

  #source(name, src) {
    return loadRgba(this.install.fs, 'textures/' + name, this.install.palette, this.#exts(src), { transparent255: true });
  }

  #sourceBytes(name, src) {
    const hit = resolveImage(this.install.fs, 'textures/' + name, this.#exts(src));
    return hit ? { buf: this.install.fs.read(hit.path), ext: hit.ext } : null;
  }

  // Largest factor that keeps the result inside the engine's texture limit.
  fittingFactor(w, h, wanted) {
    const side = Math.max(w, h);
    return FACTORS.find(f => f <= wanted && side * f <= MAX_GAME_TEX) || 0;
  }

  #keyFor(name, factor, src, model = 'detail', grain = 0) {
    const b = this.#sourceBytes(name, src);
    if (!b) return null;
    const hash = crypto.createHash('sha1').update(b.buf).digest('hex').slice(0, 16);
    const g = cleanGrain(grain);
    return { key: `${hash}-x${factor}-${recipe(factor)}${model === 'smooth' ? '-s2' : ''}${g ? '-g' + g : ''}`, ext: b.ext };
  }

  // Absolute path of the cached upscale for a texture, or null.
  cachedFile(name, factor, src = 'auto', model = 'detail', grain = 0) {
    const k = this.#keyFor(name, factor, src, model, grain);
    if (!k) return null;
    const f = path.join(cacheDir(), k.key + '.png');
    return fs.existsSync(f) ? f : null;
  }

  // Which textures of a map would be upscaled, and why the rest would not.
  plan(mapName, { factor = 4, minSkip = 1024, src = 'auto', model = 'detail', grain = 0 } = {}) {
    model = model === 'smooth' ? 'smooth' : 'detail';
    grain = cleanGrain(grain);
    const detail = this.install.mapDetail(mapName);
    const out = { map: mapName, factor, minSkip, src, model, grain, eligible: [], cached: 0, skipHiRes: [], skipSwapped: [], skipMissing: [], skipUtility: 0, already: [], tooBig: [], noGrid: [] };
    for (const t of detail.textures) {
      if (t.utility) { out.skipUtility++; continue; }
      if (t.missing) { out.skipMissing.push(t.name); continue; }
      // engine-verified (q2pro images.c get_image_dimensions): a hi-res
      // override keeps its tiling only when the ORIGINAL .wal exists - its
      // header supplies the grid. A tga/png-only texture would tile by the
      // upscaled image's size, i.e. shrink by the factor on every brush.
      if (!this.hasGrid(t.name)) { out.noGrid.push(t.name); continue; }
      if (t.swap && t.swap.type === 'upscale') {
        // an upscale whose file is gone (cache cleared, recipe changed, preset
        // from a friend) is regenerated with its own settings
        const sSrc = t.swap.src === 'low' ? 'low' : 'auto';
        const sModel = t.swap.model === 'smooth' ? 'smooth' : 'detail';
        const sGrain = cleanGrain(t.swap.grain);
        const f = [2, 3, 4].includes(Number(t.swap.factor)) ? Number(t.swap.factor) : 4;
        const d = this.#sourceDims(t.name, sSrc);
        if (!d) { out.skipMissing.push(t.name); continue; }
        if (this.cachedFile(t.name, f, sSrc, sModel, sGrain)) {
          // done: listed so it can be redone with the current settings
          out.already.push({ name: t.name, w: d.w, h: d.h, factor: f, ext: d.ext, src: sSrc, model: sModel, grain: sGrain });
          continue;
        }
        out.eligible.push({ name: t.name, w: d.w, h: d.h, factor: f, ext: d.ext, src: sSrc, model: sModel, grain: sGrain, regen: true });
        continue;
      }
      if (t.swap) { out.skipSwapped.push(t.name); continue; }
      const dims = this.#sourceDims(t.name, src);
      if (!dims) { out.skipMissing.push(t.name); continue; }
      if (Math.max(dims.w, dims.h) >= minSkip) { out.skipHiRes.push(t.name); continue; }
      const f = this.fittingFactor(dims.w, dims.h, factor);
      if (!f) { out.tooBig.push(t.name); continue; }
      out.eligible.push({ name: t.name, w: dims.w, h: dims.h, factor: f, ext: dims.ext });
      if (this.cachedFile(t.name, f, src, model, grain)) out.cached++;
    }
    return out;
  }

  hasGrid(name) {
    return this.install.fs.has('textures/' + name + '.wal');
  }

  #sourceDims(name, src) {
    const b = this.#sourceBytes(name, src);
    if (!b) return null;
    const d = imageSize(b.buf, b.ext);
    return d ? { ...d, ext: b.ext } : null;
  }

  // Produce (or reuse) the upscaled png for one texture; returns its path.
  async ensure(name, factor, model = 'detail', src = 'auto', grain = 0) {
    model = model === 'smooth' ? 'smooth' : 'detail';
    grain = cleanGrain(grain);
    const k = this.#keyFor(name, factor, src, model, grain);
    if (!k) throw new Error('no image file for ' + name);
    const file = path.join(cacheDir(), k.key + '.png');
    if (fs.existsSync(file)) return file;
    const img = this.#source(name, src);
    if (!img) throw new Error('could not decode ' + name);
    let hasAlpha = false;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) { hasAlpha = true; break; }
    // the upscaler gets an opaque, wrap-padded image; the border is cropped
    // away afterwards (seamless repeats) and holes/alpha are re-applied
    const pad = Math.min(WRAP_PAD, Math.floor(Math.min(img.width, img.height) / 2));
    const padded = wrapPad(img, pad);
    if (hasAlpha) for (let i = 3; i < padded.data.length; i += 4) padded.data[i] = 255;
    const outPng = await upscalePng(encodePng(padded), { scale: factor, model });
    const upPadded = decodeImage(outPng, '.png');
    const f = upPadded.width / padded.width; // the tool's real factor
    let up = crop(upPadded, Math.round(pad * f), Math.round(pad * f), Math.round(img.width * f), Math.round(img.height * f));
    if (grain) up = addGrain(up, img, f, grain);
    if (hasAlpha) {
      const a = fitAlpha(img, up.width, up.height);
      for (let i = 0; i < a.length; i++) up.data[i * 4 + 3] = a[i];
    }
    fs.writeFileSync(file, encodePng(up));
    return file;
  }

  thumbPng(name, factor, maxDim = 128, src = 'auto', model = 'detail', grain = 0) {
    const f = this.cachedFile(name, factor, src, model, grain);
    if (!f) return null;
    const key = `${f}@${maxDim}`;
    if (this.thumbCache.has(key)) return this.thumbCache.get(key);
    let png = null;
    try { png = encodePng(resizeRgba(decodeImage(fs.readFileSync(f), '.png'), maxDim)); } catch { png = null; }
    if (this.thumbCache.size > 300) this.thumbCache.clear();
    this.thumbCache.set(key, png);
    return png;
  }

  // Every cache file some map (working state or saved preset) still points
  // at, by its file name; everything else in the cache is "unused".
  #referencedFiles() {
    const keep = new Set();
    const maps = this.install.swaps.data.maps || {};
    for (const e of Object.values(maps)) {
      if (!e) continue;
      const sets = [e.swaps, ...Object.values(e.saved || {}).map(p => p && p.swaps)];
      for (const swaps of sets) {
        if (!swaps) continue;
        for (const [name, spec] of Object.entries(swaps)) {
          if (!spec || spec.type !== 'upscale') continue;
          const f = [2, 3, 4].includes(Number(spec.factor)) ? Number(spec.factor) : 4;
          const k = this.#keyFor(name, f, spec.src === 'low' ? 'low' : 'auto', spec.model === 'smooth' ? 'smooth' : 'detail', cleanGrain(spec.grain));
          if (k) keep.add(k.key + '.png');
        }
      }
    }
    return keep;
  }

  cacheStats() {
    const dir = cacheDir();
    const keep = this.#referencedFiles();
    let files = 0, bytes = 0, unusedFiles = 0, unusedBytes = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.png')) continue;
      let size = 0;
      try { size = fs.statSync(path.join(dir, f)).size; } catch { continue; }
      files++; bytes += size;
      if (!keep.has(f)) { unusedFiles++; unusedBytes += size; }
    }
    return { dir, files, bytes, unusedFiles, unusedBytes };
  }

  // Delete cache files no map uses any more (they come back on the next run).
  clearUnused() {
    const dir = cacheDir();
    const keep = this.#referencedFiles();
    let removed = 0, bytes = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.png') || keep.has(f)) continue;
      try { bytes += fs.statSync(path.join(dir, f)).size; fs.unlinkSync(path.join(dir, f)); removed++; } catch { /* in use */ }
    }
    this.thumbCache.clear();
    return { removed, removedBytes: bytes, ...this.cacheStats() };
  }

  status() {
    const j = this.job;
    return {
      running: Boolean(j && j.running),
      map: j ? j.map : null,
      done: j ? j.done : 0,
      total: j ? j.total : 0,
      current: j ? j.current : null,
      failed: j ? j.failed : [],
      finished: Boolean(j && !j.running),
      cancelled: Boolean(j && j.cancelled),
      error: j ? j.error : null,
      applied: j ? j.applied : 0,
      tool: upscalerStatus(),
    };
  }

  // Background job: upscale every eligible texture of a map, then store the
  // swaps in one go. One job at a time (the GPU is the bottleneck anyway).
  start(mapName, { factor = 4, minSkip = 1024, model = 'detail', names = null, src = 'auto', grain = 0 } = {}) {
    if (this.job && this.job.running) throw new Error(`already upscaling ${this.job.map}`);
    if (!upscalerStatus().installed) throw new Error('AI upscaler is not installed');
    src = src === 'low' ? 'low' : 'auto';
    model = model === 'smooth' ? 'smooth' : 'detail';
    grain = cleanGrain(grain);
    const plan = this.plan(mapName, { factor, minSkip, src, model, grain });
    let list = names ? plan.eligible.filter(e => names.includes(e.name)) : plan.eligible;
    if (names) {
      // explicitly chosen textures that are already upscaled: redo them with
      // the CURRENT factor/source/look (not the settings they were made with)
      for (const a of plan.already) {
        if (!names.includes(a.name)) continue;
        const d = this.#sourceDims(a.name, src);
        if (!d) continue;
        const f = this.fittingFactor(d.w, d.h, factor);
        if (!f) continue;
        list.push({ name: a.name, w: d.w, h: d.h, factor: f, ext: d.ext, redo: true });
      }
    }
    const job = { running: true, map: mapName, total: list.length, done: 0, current: null, failed: [], cancelled: false, error: null, applied: 0 };
    this.job = job;
    (async () => {
      const specs = {};
      for (const t of list) {
        if (job.cancelled) break;
        job.current = t.name;
        try {
          const tSrc = t.src || src; // regenerated entries keep their own settings
          const tModel = t.model || model;
          const tGrain = t.regen ? cleanGrain(t.grain) : grain;
          await this.ensure(t.name, t.factor, tModel, tSrc, tGrain);
          const spec = { type: 'upscale', factor: t.factor };
          if (tSrc === 'low') spec.src = 'low';
          if (tModel === 'smooth') spec.model = 'smooth';
          if (tGrain) spec.grain = tGrain;
          specs[t.name] = spec;
        } catch (e) {
          job.failed.push(`${t.name}: ${e.message}`);
        }
        job.done++;
      }
      job.current = null;
      if (Object.keys(specs).length) {
        try {
          this.install.swaps.setSwapsBulk(mapName, specs);
          job.applied = Object.keys(specs).length;
        } catch (e) {
          job.error = 'could not store the swaps: ' + e.message;
        }
      }
    })().catch(e => { job.error = e.message; }).finally(() => { job.running = false; });
    return { total: list.length };
  }

  cancel() {
    if (this.job && this.job.running) this.job.cancelled = true;
  }
}
