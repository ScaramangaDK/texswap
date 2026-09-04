// External helper tools the app fetches on demand into app-data (never
// bundled - keeps the portable exe small). Today: Real-ESRGAN, the open
// source AI upscaler, as the ncnn/Vulkan build that runs on any GPU without
// Python or CUDA. Source: the project's official GitHub release.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appDataRoot } from './swaps.js';
import { readZipIndex, readZipEntry } from './vfs.js';
import { decodeImage } from './decoders.js';
import { encodePng, resizeRgba } from './thumbs.js';

const RESR = {
  url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip',
  sizeMB: 45,
  exe: 'realesrgan-ncnn-vulkan.exe',
  // only what the exe needs: binary, OpenMP runtime, model weights
  keep: /^(realesrgan-ncnn-vulkan\.exe|vcomp140d?\.dll|models\/[a-z0-9_.-]+\.(bin|param))$/i,
};

export const UPSCALE_MODELS = {
  // photo-like detail (default): best for realistic gun/wood/metal skins
  detail: 'realesrgan-x4plus',
  // smoother, flatter result: cleaner on cartoon-ish or already-clean art
  smooth: 'realesr-animevideov3',
};

function toolDir() {
  return path.join(appDataRoot(), 'tools', 'realesrgan');
}

const state = { installing: false, done: 0, total: 0, error: null, phase: '' };

export function upscalerStatus() {
  const dir = toolDir();
  const exe = path.join(dir, RESR.exe);
  const installed = fs.existsSync(exe) &&
    fs.existsSync(path.join(dir, 'models', UPSCALE_MODELS.detail + '.bin'));
  return {
    installed,
    installing: state.installing,
    phase: state.phase,
    progress: { done: state.done, total: state.total },
    error: state.error,
    dir,
    downloadMB: RESR.sizeMB,
    source: RESR.url,
  };
}

// Download + unpack in the background; poll upscalerStatus() for progress.
export function installUpscaler() {
  if (state.installing) return;
  state.installing = true;
  state.error = null;
  state.done = 0;
  state.total = 0;
  state.phase = 'downloading';
  (async () => {
    const dir = toolDir();
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    const zipPath = path.join(dir, 'download.zip');
    const res = await fetch(RESR.url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    state.total = Number(res.headers.get('content-length')) || RESR.sizeMB * 1024 * 1024;
    const out = fs.createWriteStream(zipPath);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state.done += value.length;
      if (!out.write(value)) await new Promise(r => out.once('drain', r));
    }
    await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
    state.phase = 'unpacking';
    const { fd, entries } = readZipIndex(zipPath);
    try {
      let n = 0;
      for (const [name, entry] of entries) {
        if (!RESR.keep.test(name)) continue;
        const abs = path.join(dir, name);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, readZipEntry(fd, entry));
        n++;
      }
      if (!n) throw new Error('archive had none of the expected files');
    } finally {
      fs.closeSync(fd);
    }
    try { fs.unlinkSync(zipPath); } catch { /* leftover zip is harmless */ }
    if (!upscalerStatus().installed) throw new Error('unpacked, but the upscaler binary is missing');
    state.phase = 'done';
  })().catch(e => {
    state.error = e.message;
    state.phase = 'failed';
  }).finally(() => {
    state.installing = false;
  });
}

// Run the upscaler on a PNG; resolves to the output PNG bytes.
// scale: 2, 3 or 4. model key: 'detail' | 'smooth'.
// Both models are only trustworthy at 4x in this ncnn build: x4plus asked
// for -s 2 returns a 2x-sized CROP of the 4x result (a zoomed corner), and
// animevideov3's x2 weights return half-transparent garbage. So every run
// is 4x, box-filtered down to the wanted scale afterwards.
export async function upscalePng(pngBuf, { scale = 4, model = 'detail' } = {}) {
  const wanted = [2, 3, 4].includes(Number(scale)) ? Number(scale) : 4;
  const out = await runUpscaler(pngBuf, { scale: 4, model });
  if (wanted === 4) return out;
  const img = decodeImage(out, '.png');
  const target = Math.round(Math.max(img.width, img.height) / 4 * wanted);
  return encodePng(resizeRgba(img, target));
}

function runUpscaler(pngBuf, { scale = 4, model = 'detail' } = {}) {
  const st = upscalerStatus();
  if (!st.installed) return Promise.reject(new Error('AI upscaler is not installed'));
  const modelName = UPSCALE_MODELS[model] || UPSCALE_MODELS.detail;
  const s = [2, 3, 4].includes(Number(scale)) ? Number(scale) : 4;
  const tmp = path.join(appDataRoot(), 'tools', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const inFile = path.join(tmp, `in-${tag}.png`);
  const outFile = path.join(tmp, `out-${tag}.png`);
  fs.writeFileSync(inFile, pngBuf);
  return new Promise((resolve, reject) => {
    const exe = path.join(st.dir, RESR.exe);
    const child = spawn(exe, ['-i', inFile, '-o', outFile, '-n', modelName, '-s', String(s), '-f', 'png'],
      { cwd: st.dir, windowsHide: true });
    let err = '';
    child.stderr.on('data', d => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('upscaler timed out (10 min)')); }, 10 * 60 * 1000);
    child.on('error', e => { clearTimeout(timer); reject(new Error('could not start upscaler: ' + e.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      try { fs.unlinkSync(inFile); } catch { /* tmp */ }
      if (code !== 0 || !fs.existsSync(outFile)) {
        const tail = err.trim().split('\n').slice(-3).join(' | ');
        return reject(new Error(`upscaler failed (exit ${code})${tail ? ': ' + tail : ''}`));
      }
      const out = fs.readFileSync(outFile);
      try { fs.unlinkSync(outFile); } catch { /* tmp */ }
      resolve(out);
    });
  });
}
