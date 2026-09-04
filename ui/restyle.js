// Restyle engine for weapon skins: base materials (gradient maps over the
// skin's own shading, so detail survives), procedural pattern overlays,
// color adjustments, and protect boxes that keep areas (hands!) untouched.
// Pure canvas/JS - runs the same on every PC, no downloads.

export const MATERIALS = [
  { id: 'none', label: 'Original', stops: null },
  { id: 'gold', label: 'Gold', stops: [[0, '#1a1000'], [0.3, '#7a4f0c'], [0.6, '#d9a636'], [0.85, '#ffe9a8'], [1, '#ffffff']] },
  { id: 'rosegold', label: 'Rose gold', stops: [[0, '#1c0c08'], [0.35, '#8a4a3a'], [0.65, '#d9927e'], [0.88, '#ffd8c8'], [1, '#ffffff']] },
  { id: 'chrome', label: 'Chrome', stops: [[0, '#05070a'], [0.25, '#3a4048'], [0.5, '#b8c0c8'], [0.62, '#5a6470'], [0.8, '#e8eef4'], [1, '#ffffff']] },
  { id: 'silver', label: 'Brushed steel', stops: [[0, '#0c0e11'], [0.4, '#5c626a'], [0.75, '#aeb5bd'], [1, '#f2f4f6']] },
  { id: 'gunmetal', label: 'Gunmetal', stops: [[0, '#05060a'], [0.5, '#2c313b'], [0.85, '#5d6570'], [1, '#8a929c']] },
  { id: 'black', label: 'Black ops', stops: [[0, '#000000'], [0.6, '#121316'], [0.9, '#2a2c31'], [1, '#45484f']] },
  { id: 'copper', label: 'Copper', stops: [[0, '#150800'], [0.35, '#6e3416'], [0.65, '#c8733a'], [0.88, '#f5c9a0'], [1, '#ffffff']] },
  { id: 'bronze', label: 'Bronze', stops: [[0, '#120b02'], [0.4, '#5a4014'], [0.7, '#a8823a'], [1, '#e8d49a']] },
  { id: 'olive', label: 'Olive drab', stops: [[0, '#0a0c05'], [0.45, '#3d4a22'], [0.8, '#7a8a4a'], [1, '#c2cc99']] },
  { id: 'tan', label: 'Desert tan', stops: [[0, '#1a1208'], [0.4, '#7a6240'], [0.75, '#c8ac7c'], [1, '#f2e6cc']] },
  { id: 'arctic', label: 'Arctic white', stops: [[0, '#1c2028'], [0.35, '#7c8895'], [0.7, '#d8dee6'], [1, '#ffffff']] },
  { id: 'wood', label: 'Walnut', stops: [[0, '#140800'], [0.35, '#4a2410'], [0.7, '#8a4a22'], [1, '#d09a6a']] },
  { id: 'cherry', label: 'Cherry wood', stops: [[0, '#1a0404'], [0.4, '#6a1a12'], [0.75, '#b8402a'], [1, '#e8a080']] },
  { id: 'red', label: 'Blood red', stops: [[0, '#0e0000'], [0.45, '#7a0a0a'], [0.8, '#d82020'], [1, '#ff9a9a']] },
  { id: 'blue', label: 'Navy blue', stops: [[0, '#00030e'], [0.45, '#0e2a6a'], [0.8, '#2f62c8'], [1, '#a9c4ff']] },
  { id: 'green', label: 'Toxic green', stops: [[0, '#001000'], [0.45, '#1a6a10'], [0.8, '#48d020'], [1, '#c8ff9a']] },
  { id: 'purple', label: 'Royal purple', stops: [[0, '#08000e'], [0.45, '#3e106a'], [0.8, '#8a3ac8'], [1, '#e0b8ff']] },
  { id: 'pink', label: 'Hot pink', stops: [[0, '#14000a'], [0.45, '#8a0a4a'], [0.8, '#ff3aa0'], [1, '#ffc8e8']] },
];

export const PATTERNS = [
  { id: 'none', label: 'None' },
  { id: 'camo_wood', label: 'Woodland camo', colors: ['#2f3a1e', '#5a6a34', '#8a7a4a', '#1b1f14'] },
  { id: 'camo_desert', label: 'Desert camo', colors: ['#a08a5a', '#c8b482', '#7a6a44', '#d8ccaa'] },
  { id: 'camo_urban', label: 'Urban camo', colors: ['#3a3d42', '#6a6e74', '#9a9ea4', '#1e2024'] },
  { id: 'camo_arctic', label: 'Arctic camo', colors: ['#e8ecf0', '#b8c0c8', '#8a94a0', '#ffffff'] },
  { id: 'digital', label: 'Digital camo', colors: ['#2f3a1e', '#5a6a34', '#8a7a4a', '#1b1f14'], digital: true },
  { id: 'carbon', label: 'Carbon fibre' },
  { id: 'hex', label: 'Hex plating' },
  { id: 'stripes', label: 'Racing stripes' },
  { id: 'scratches', label: 'Scratches & wear' },
  { id: 'grit', label: 'Grit / grime' },
];

export const DEFAULT_PARAMS = {
  material: 'none', strength: 0.85,
  pattern: 'none', patternScale: 1, patternOpacity: 0.6,
  hue: 0, sat: 100, bright: 100, contrast: 100,
  protect: [], // [{x, y, w, h}] normalized 0..1
};

// ---------- helpers ----------

function hexRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const lutCache = new Map();
function gradientLut(mat) {
  if (lutCache.has(mat.id)) return lutCache.get(mat.id);
  const lut = new Uint8ClampedArray(256 * 3);
  const stops = mat.stops.map(([t, c]) => [t, hexRgb(c)]);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
    }
    const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[1][c] + (b[1][c] - a[1][c]) * f;
  }
  lutCache.set(mat.id, lut);
  return lut;
}

// deterministic value noise (same pattern at every preview size)
function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, seed) {
  return (vnoise(x, y, seed) * 0.55 + vnoise(x * 2.1, y * 2.1, seed + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, seed + 13) * 0.15);
}

// Pattern color for pixel (x, y) in pattern space; returns [r, g, b, weight]
// or null. `u` is the pattern cell size in pixels.
function patternAt(p, x, y, u, w, h) {
  switch (p.id) {
    case 'camo_wood': case 'camo_desert': case 'camo_urban': case 'camo_arctic': {
      const n1 = fbm(x / u, y / u, 1), n2 = fbm(x / u + 31.7, y / u - 17.3, 2);
      const cols = p.colors.map(hexRgb);
      const idx = n1 < 0.42 ? 0 : n1 < 0.55 ? 1 : n2 < 0.5 ? 2 : 3;
      return [...cols[idx], 1];
    }
    case 'digital': {
      const cell = Math.max(2, u / 4);
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      const n = fbm(gx * cell / u, gy * cell / u, 3);
      const cols = p.colors.map(hexRgb);
      const idx = n < 0.42 ? 0 : n < 0.55 ? 1 : hash(gx, gy, 5) < 0.6 ? 2 : 3;
      return [...cols[idx], 1];
    }
    case 'carbon': {
      const s = Math.max(2, u / 3);
      const cx = Math.floor(x / s), cy = Math.floor(y / s);
      const horiz = (cx + cy) % 2 === 0;
      const t = horiz ? (y % s) / s : (x % s) / s;
      const shade = 0.35 + 0.65 * Math.sin(Math.PI * t);
      const v = Math.round(20 + 70 * shade);
      return [v, v + 2, v + 6, 1];
    }
    case 'hex': {
      const r = Math.max(3, u / 2);
      const hw = Math.sqrt(3) * r, hh = 1.5 * r;
      const row = Math.floor(y / hh);
      const ox = row % 2 ? hw / 2 : 0;
      const col = Math.floor((x - ox) / hw);
      const cxp = ox + col * hw + hw / 2, cyp = row * hh + r;
      const dx = Math.abs(x - cxp), dy = Math.abs(y - cyp);
      // distance to hex edge (approx): hex with flat top
      const d = Math.max(dy / r, (dx * Math.sqrt(3) / 2 + dy / 2) / r);
      const edge = d > 0.86 ? 1 : 0;
      return edge ? [12, 14, 18, 1] : null;
    }
    case 'stripes': {
      const period = u * 2.5;
      const t = ((x + y * 0.15) % period + period) % period / period;
      if (t < 0.32) return [235, 235, 235, 1];
      if (t < 0.36 || (t > 0.44 && t < 0.48)) return [20, 20, 24, 1];
      if (t >= 0.36 && t <= 0.44) return [200, 30, 30, 1];
      return null;
    }
    case 'grit': {
      const n = vnoise(x / (u * 0.35), y / (u * 0.35), 9) * 0.6 + vnoise(x * 1.7, y * 1.7, 11) * 0.4;
      const dark = n < 0.42 ? (0.42 - n) * 2.4 : 0;
      return dark > 0 ? [30, 26, 20, Math.min(1, dark)] : null;
    }
    default: return null;
  }
}

// Scratches are thin bright/dark lines: cheaper to draw with the 2D API.
function scratchLayer(w, h, u) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const n = Math.round((w * h) / (u * u) * 0.9);
  let seed = 17;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h;
    const len = u * (0.4 + rnd() * 2.2), ang = rnd() * Math.PI;
    const bright = rnd() < 0.55;
    ctx.strokeStyle = bright ? `rgba(255,255,255,${0.25 + rnd() * 0.45})` : `rgba(0,0,0,${0.3 + rnd() * 0.4})`;
    ctx.lineWidth = Math.max(0.6, u * (0.02 + rnd() * 0.05));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  // edge wear: darker grime along a soft noise field
  return ctx.getImageData(0, 0, w, h).data;
}

// ---------- main ----------

// Render `img` (Image or canvas) restyled by `params` into a canvas no wider
// than maxWidth (full size when maxWidth is 0).
export function restyle(img, params, maxWidth = 0) {
  const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  const scale = maxWidth && sw > maxWidth ? maxWidth / sw : 1;
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0, w, h);
  const orig = sctx.getImageData(0, 0, w, h);
  const out = new ImageData(new Uint8ClampedArray(orig.data), w, h);
  const d = out.data, o = orig.data;

  const mat = MATERIALS.find(m => m.id === params.material) || MATERIALS[0];
  const pat = PATTERNS.find(p => p.id === params.pattern) || PATTERNS[0];
  const strength = Math.max(0, Math.min(1, Number(params.strength) || 0));
  const pop = Math.max(0, Math.min(1, Number(params.patternOpacity) || 0));
  // pattern unit: scale 1 = 1/40 of the skin width, so patterns look the
  // same in the preview and in the full-size bake
  const u = Math.max(2, (w / 40) * (Number(params.patternScale) || 1));
  const lut = mat.stops ? gradientLut(mat) : null;
  const scratches = pat.id === 'scratches' && pop > 0 ? scratchLayer(w, h, u) : null;

  if (lut || (pat.id !== 'none' && pop > 0)) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let r = o[i], g = o[i + 1], b = o[i + 2];
        const lum = (r * 0.299 + g * 0.587 + b * 0.114);
        if (lut) {
          const li = Math.round(lum) * 3;
          r += (lut[li] - r) * strength;
          g += (lut[li + 1] - g) * strength;
          b += (lut[li + 2] - b) * strength;
        }
        if (pat.id !== 'none' && pop > 0) {
          if (scratches) {
            const a = scratches[i + 3] / 255 * pop;
            if (a > 0) {
              r += (scratches[i] - r) * a; g += (scratches[i + 1] - g) * a; b += (scratches[i + 2] - b) * a;
            }
          } else {
            const pc = patternAt(pat, x, y, u, w, h);
            if (pc) {
              // keep the skin's shading: pattern color lit by the pixel's luminance
              const shade = 0.45 + (lum / 255) * 0.9;
              const a = pop * pc[3];
              r += (Math.min(255, pc[0] * shade) - r) * a;
              g += (Math.min(255, pc[1] * shade) - g) * a;
              b += (Math.min(255, pc[2] * shade) - b) * a;
            }
          }
        }
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
    }
  }

  const work = document.createElement('canvas');
  work.width = w; work.height = h;
  const wctx = work.getContext('2d');
  wctx.putImageData(out, 0, 0);

  // color adjustments through the browser's filter pipeline
  const result = document.createElement('canvas');
  result.width = w; result.height = h;
  const rctx = result.getContext('2d');
  const f = [];
  if (Number(params.hue)) f.push(`hue-rotate(${params.hue}deg)`);
  if (Number(params.sat) !== 100) f.push(`saturate(${params.sat}%)`);
  if (Number(params.bright) !== 100) f.push(`brightness(${params.bright}%)`);
  if (Number(params.contrast) !== 100) f.push(`contrast(${params.contrast}%)`);
  rctx.filter = f.length ? f.join(' ') : 'none';
  rctx.drawImage(work, 0, 0);
  rctx.filter = 'none';

  // protected boxes: the original pixels, untouched by anything above
  for (const box of params.protect || []) {
    const bx = Math.round(box.x * w), by = Math.round(box.y * h);
    const bw = Math.round(box.w * w), bh = Math.round(box.h * h);
    if (bw > 0 && bh > 0) rctx.drawImage(src, bx, by, bw, bh, bx, by, bw, bh);
  }
  return result;
}

export function isIdentity(p) {
  return (!p.material || p.material === 'none') && (!p.pattern || p.pattern === 'none') &&
    !Number(p.hue) && Number(p.sat) === 100 && Number(p.bright) === 100 && Number(p.contrast) === 100;
}
