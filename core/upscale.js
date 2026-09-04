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

  #keyFor(name, factor, src, model = 'detail') {
    const b = this.#sourceBytes(name, src);
    if (!b) return null;
    const hash = crypto.createHash('sha1').update(b.buf).digest('hex').slice(0, 16);
    return { key: `${hash}-x${factor}-${recipe(factor)}${model === 'smooth' ? '-s2' : ''}`, ext: b.ext };
  }

  // Absolute path of the cached upscale for a texture, or null.
  cachedFile(name, factor, src = 'auto', model = 'detail') {
    const k = this.#keyFor(name, factor, src, model);
    if (!k) return null;
    const f = path.join(cacheDir(), k.key + '.png');
    return fs.existsSync(f) ? f : null;
  }

  // Which textures of a map would be upscaled, and why the rest would not.
  plan(mapName, { factor = 4, minSkip = 1024, src = 'auto', model = 'detail' } = {}) {
    model = model === 'smooth' ? 'smooth' : 'detail';
    const detail = this.install.mapDetail(mapName);
    const out = { map: mapName, factor, minSkip, src, model, eligible: [], cached: 0, skipHiRes: [], skipSwapped: [], skipMissing: [], skipUtility: 0, already: [], tooBig: [], noGrid: [] };
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
        const f = [2, 3, 4].includes(Number(t.swap.factor)) ? Number(t.swap.factor) : 4;
        const d = this.#sourceDims(t.name, sSrc);
        if (!d) { out.skipMissing.push(t.name); continue; }
        if (this.cachedFile(t.name, f, sSrc, sModel)) {
          // done: listed so it can be redone with the current settings
          out.already.push({ name: t.name, w: d.w, h: d.h, factor: f, ext: d.ext, src: sSrc, model: sModel });
          continue;
        }
        out.eligible.push({ name: t.name, w: d.w, h: d.h, factor: f, ext: d.ext, src: sSrc, model: sModel, regen: true });
        continue;
      }
      if (t.swap) { out.skipSwapped.push(t.name); continue; }
      const dims = this.#sourceDims(t.name, src);
      if (!dims) { out.skipMissing.push(t.name); continue; }
      if (Math.max(dims.w, dims.h) >= minSkip) { out.skipHiRes.push(t.name); continue; }
      const f = this.fittingFactor(dims.w, dims.h, factor);
      if (!f) { out.tooBig.push(t.name); continue; }
      out.eligible.push({ name: t.name, w: dims.w, h: dims.h, factor: f, ext: dims.ext });
      if (this.cachedFile(t.name, f, src, model)) out.cached++;
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
  async ensure(name, factor, model = 'detail', src = 'auto') {
    model = model === 'smooth' ? 'smooth' : 'detail';
    const k = this.#keyFor(name, factor, src, model);
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
    const up = crop(upPadded, Math.round(pad * f), Math.round(pad * f), Math.round(img.width * f), Math.round(img.height * f));
    if (hasAlpha) {
      const a = fitAlpha(img, up.width, up.height);
      for (let i = 0; i < a.length; i++) up.data[i * 4 + 3] = a[i];
    }
    fs.writeFileSync(file, encodePng(up));
    return file;
  }

  thumbPng(name, factor, maxDim = 128, src = 'auto', model = 'detail') {
    const f = this.cachedFile(name, factor, src, model);
    if (!f) return null;
    const key = `${f}@${maxDim}`;
    if (this.thumbCache.has(key)) return this.thumbCache.get(key);
    let png = null;
    try { png = encodePng(resizeRgba(decodeImage(fs.readFileSync(f), '.png'), maxDim)); } catch { png = null; }
    if (this.thumbCache.size > 300) this.thumbCache.clear();
    this.thumbCache.set(key, png);
    return png;
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
  start(mapName, { factor = 4, minSkip = 1024, model = 'detail', names = null, src = 'auto' } = {}) {
    if (this.job && this.job.running) throw new Error(`already upscaling ${this.job.map}`);
    if (!upscalerStatus().installed) throw new Error('AI upscaler is not installed');
    src = src === 'low' ? 'low' : 'auto';
    model = model === 'smooth' ? 'smooth' : 'detail';
    const plan = this.plan(mapName, { factor, minSkip, src, model });
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
          await this.ensure(t.name, t.factor, tModel, tSrc);
          const spec = { type: 'upscale', factor: t.factor };
          if (tSrc === 'low') spec.src = 'low';
          if (tModel === 'smooth') spec.model = 'smooth';
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
