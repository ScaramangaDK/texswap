// Quake 2 MD2 model reader (IDP2 v8): header, skin names, texcoords,
// triangles and per-frame vertex positions - enough to preview a weapon
// model with a skin, draw its UV layout, and validate an uploaded
// replacement. Nothing here writes models.

const IDENT = 0x32504449; // "IDP2"
const VERSION = 8;
const MAX_VERTS = 2048;
const MAX_TRIS = 4096;
const MAX_FRAMES = 512;

export function isMd2(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 68 && buf.readInt32LE(0) === IDENT && buf.readInt32LE(4) === VERSION;
}

// Parse the whole model. frames[i].verts is a Float32Array(nVerts*3) in
// Quake coordinates (x forward, y left, z up).
export function parseMd2(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 68) throw new Error('not an md2 (too small)');
  if (buf.readInt32LE(0) !== IDENT) throw new Error('not an md2 (bad magic)');
  if (buf.readInt32LE(4) !== VERSION) throw new Error('unsupported md2 version ' + buf.readInt32LE(4));
  const h = {
    skinW: buf.readInt32LE(8), skinH: buf.readInt32LE(12), frameSize: buf.readInt32LE(16),
    nSkins: buf.readInt32LE(20), nVerts: buf.readInt32LE(24), nSt: buf.readInt32LE(28),
    nTris: buf.readInt32LE(32), nGl: buf.readInt32LE(36), nFrames: buf.readInt32LE(40),
    ofsSkins: buf.readInt32LE(44), ofsSt: buf.readInt32LE(48), ofsTris: buf.readInt32LE(52),
    ofsFrames: buf.readInt32LE(56), ofsGl: buf.readInt32LE(60), ofsEnd: buf.readInt32LE(64),
  };
  if (h.nVerts < 1 || h.nVerts > MAX_VERTS) throw new Error('md2: bad vertex count ' + h.nVerts);
  if (h.nTris < 1 || h.nTris > MAX_TRIS) throw new Error('md2: bad triangle count ' + h.nTris);
  if (h.nFrames < 1 || h.nFrames > MAX_FRAMES) throw new Error('md2: bad frame count ' + h.nFrames);
  if (h.nSt < 1 || h.nSt > 65535) throw new Error('md2: bad texcoord count');
  if (h.skinW < 1 || h.skinH < 1 || h.skinW > 8192 || h.skinH > 8192) throw new Error('md2: bad skin size');
  if (h.frameSize !== 40 + h.nVerts * 4) throw new Error('md2: frame size mismatch');
  const need = Math.max(
    h.ofsSkins + h.nSkins * 64,
    h.ofsSt + h.nSt * 4,
    h.ofsTris + h.nTris * 12,
    h.ofsFrames + h.nFrames * h.frameSize,
  );
  if (need > buf.length) throw new Error('md2: truncated file');

  const skins = [];
  for (let i = 0; i < h.nSkins; i++) {
    const s = buf.toString('latin1', h.ofsSkins + i * 64, h.ofsSkins + i * 64 + 64);
    skins.push(s.split('\0')[0]);
  }
  const st = new Int16Array(h.nSt * 2);
  for (let i = 0; i < h.nSt; i++) {
    st[i * 2] = buf.readInt16LE(h.ofsSt + i * 4);
    st[i * 2 + 1] = buf.readInt16LE(h.ofsSt + i * 4 + 2);
  }
  const tris = new Uint16Array(h.nTris * 6); // v0 v1 v2 st0 st1 st2
  for (let i = 0; i < h.nTris; i++) {
    for (let k = 0; k < 6; k++) {
      const v = buf.readInt16LE(h.ofsTris + i * 12 + k * 2);
      const lim = k < 3 ? h.nVerts : h.nSt;
      if (v < 0 || v >= lim) throw new Error('md2: triangle index out of range');
      tris[i * 6 + k] = v;
    }
  }
  const frames = [];
  for (let f = 0; f < h.nFrames; f++) {
    const b = h.ofsFrames + f * h.frameSize;
    const sx = buf.readFloatLE(b), sy = buf.readFloatLE(b + 4), sz = buf.readFloatLE(b + 8);
    const tx = buf.readFloatLE(b + 12), ty = buf.readFloatLE(b + 16), tz = buf.readFloatLE(b + 20);
    const name = buf.toString('latin1', b + 24, b + 40).split('\0')[0];
    const verts = new Float32Array(h.nVerts * 3);
    for (let v = 0; v < h.nVerts; v++) {
      const p = b + 40 + v * 4;
      verts[v * 3] = buf[p] * sx + tx;
      verts[v * 3 + 1] = buf[p + 1] * sy + ty;
      verts[v * 3 + 2] = buf[p + 2] * sz + tz;
    }
    frames.push({ name, verts });
  }
  return { ...h, skins, st, tris, frames };
}

// Header-only summary (cheap; for lists).
export function md2Info(buf) {
  if (!isMd2(buf)) return null;
  const nSkins = buf.readInt32LE(20), ofsSkins = buf.readInt32LE(44);
  const skins = [];
  for (let i = 0; i < Math.min(nSkins, 8) && ofsSkins + i * 64 + 64 <= buf.length; i++) {
    skins.push(buf.toString('latin1', ofsSkins + i * 64, ofsSkins + i * 64 + 64).split('\0')[0]);
  }
  return {
    skinW: buf.readInt32LE(8), skinH: buf.readInt32LE(12),
    verts: buf.readInt32LE(24), tris: buf.readInt32LE(32), frames: buf.readInt32LE(40),
    skins,
  };
}

// The base path (no extension) the engine will ask the skin under. Models
// name a .pcx; the engine tries hi-res overrides (.png/.tga/.jpg) first.
export function skinBase(skinName, modelDir) {
  const s = String(skinName || '').replaceAll('\\', '/').toLowerCase();
  if (!s) return modelDir + '/skin';
  const noExt = s.replace(/\.[a-z0-9]+$/, '');
  // some tools write a bare file name; the engine looks next to the model
  return noExt.includes('/') ? noExt : modelDir + '/' + noExt;
}

// Client payload: triangles, UVs (0..1 against the header skin size) and all
// frames' positions as base64 Float32 (Quake coords - the viewer converts).
export function md2ToClient(m, maxFrames = 400) {
  const nF = Math.min(m.nFrames, maxFrames);
  const all = new Float32Array(nF * m.nVerts * 3);
  for (let f = 0; f < nF; f++) all.set(m.frames[f].verts, f * m.nVerts * 3);
  const uvs = new Float32Array(m.nSt * 2);
  for (let i = 0; i < m.nSt; i++) {
    uvs[i * 2] = m.st[i * 2] / m.skinW;
    uvs[i * 2 + 1] = m.st[i * 2 + 1] / m.skinH;
  }
  // bounds over the first frame (the pose everything is framed around)
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const v0 = m.frames[0].verts;
  for (let i = 0; i < m.nVerts; i++) {
    for (let k = 0; k < 3; k++) {
      const x = v0[i * 3 + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  return {
    skinW: m.skinW, skinH: m.skinH, nVerts: m.nVerts, nTris: m.nTris, nFrames: nF,
    totalFrames: m.nFrames, skins: m.skins,
    frameNames: m.frames.slice(0, nF).map(f => f.name),
    tris: Array.from(m.tris),
    uvs: Array.from(uvs, x => Math.round(x * 10000) / 10000),
    framesB64: Buffer.from(all.buffer, all.byteOffset, all.byteLength).toString('base64'),
    bounds: { min, max },
  };
}

// Draw the model's UV wireframe over an RGBA image (in place). Lines land in
// image space regardless of the image's resolution vs the header skin size.
export function drawUvOverlay(m, img, rgb = [0, 255, 80]) {
  const { width: w, height: h, data } = img;
  const sx = w / m.skinW, sy = h / m.skinH;
  const plot = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
  };
  const line = (x0, y0, x1, y1) => {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const stx = x0 < x1 ? 1 : -1, sty = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let n = 0; n < 100000; n++) {
      plot(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += stx; }
      if (e2 <= dx) { err += dx; y0 += sty; }
    }
  };
  const seen = new Set();
  for (let t = 0; t < m.nTris; t++) {
    const a = m.tris[t * 6 + 3], b = m.tris[t * 6 + 4], c = m.tris[t * 6 + 5];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? p * 65536 + q : q * 65536 + p;
      if (seen.has(key)) continue;
      seen.add(key);
      line(m.st[p * 2] * sx, m.st[p * 2 + 1] * sy, m.st[q * 2] * sx, m.st[q * 2 + 1] * sy);
    }
  }
  return img;
}
