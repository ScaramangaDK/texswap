// Quake 3 MD3 reader (IDP3 v15) - the "improved model" format q2pro/AQtion
// loads by header ident, so an MD3 can stand in for a tris.md2 through the
// same link. Read-only: enough for the studio's preview, validation and the
// frame-count check. Writing MD3s is the Blender pipeline's job.

const IDENT = 0x33504449; // "IDP3"
const VERSION = 15;
const XYZ_SCALE = 1 / 64;
const MAX_FRAMES = 1024;
const MAX_MESHES = 32;

export function isMd3(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 108 && buf.readInt32LE(0) === IDENT && buf.readInt32LE(4) === VERSION;
}

function cstr(buf, ofs, len) {
  return buf.toString('latin1', ofs, ofs + len).split('\0')[0];
}

export function parseMd3(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 108) throw new Error('not an md3 (too small)');
  if (buf.readInt32LE(0) !== IDENT) throw new Error('not an md3 (bad magic)');
  if (buf.readInt32LE(4) !== VERSION) throw new Error('unsupported md3 version ' + buf.readInt32LE(4));
  const h = {
    name: cstr(buf, 8, 64), flags: buf.readInt32LE(72),
    nFrames: buf.readInt32LE(76), nTags: buf.readInt32LE(80), nSurfaces: buf.readInt32LE(84), nSkins: buf.readInt32LE(88),
    ofsFrames: buf.readInt32LE(92), ofsTags: buf.readInt32LE(96), ofsSurfaces: buf.readInt32LE(100), ofsEnd: buf.readInt32LE(104),
  };
  if (h.nFrames < 1 || h.nFrames > MAX_FRAMES) throw new Error('md3: bad frame count ' + h.nFrames);
  if (h.nSurfaces < 1 || h.nSurfaces > MAX_MESHES) throw new Error('md3: bad surface count ' + h.nSurfaces);
  if (h.ofsFrames + h.nFrames * 56 > buf.length) throw new Error('md3: truncated frames');
  const frames = [];
  for (let f = 0; f < h.nFrames; f++) {
    const b = h.ofsFrames + f * 56;
    frames.push({ name: cstr(buf, b + 40, 16), radius: buf.readFloatLE(b + 36) });
  }
  const surfaces = [];
  let p = h.ofsSurfaces;
  for (let s = 0; s < h.nSurfaces; s++) {
    if (p + 108 > buf.length || buf.readInt32LE(p) !== IDENT) throw new Error('md3: bad surface header');
    const sh = {
      name: cstr(buf, p + 4, 64), flags: buf.readInt32LE(p + 68),
      nFrames: buf.readInt32LE(p + 72), nShaders: buf.readInt32LE(p + 76), nVerts: buf.readInt32LE(p + 80), nTris: buf.readInt32LE(p + 84),
      ofsTris: buf.readInt32LE(p + 88), ofsShaders: buf.readInt32LE(p + 92), ofsSt: buf.readInt32LE(p + 96), ofsXyz: buf.readInt32LE(p + 100), ofsEnd: buf.readInt32LE(p + 104),
    };
    if (sh.nFrames !== h.nFrames) throw new Error('md3: surface frame count mismatch');
    if (sh.nVerts < 1 || sh.nVerts > 8192 || sh.nTris < 1 || sh.nTris > 16384) throw new Error('md3: bad surface size');
    const need = Math.max(sh.ofsTris + sh.nTris * 12, sh.ofsShaders + sh.nShaders * 68, sh.ofsSt + sh.nVerts * 8, sh.ofsXyz + sh.nVerts * sh.nFrames * 8);
    if (p + need > buf.length) throw new Error('md3: truncated surface');
    const shaders = [];
    for (let i = 0; i < sh.nShaders; i++) shaders.push(cstr(buf, p + sh.ofsShaders + i * 68, 64));
    const tris = new Uint32Array(sh.nTris * 3);
    for (let i = 0; i < sh.nTris * 3; i++) {
      const v = buf.readInt32LE(p + sh.ofsTris + i * 4);
      if (v < 0 || v >= sh.nVerts) throw new Error('md3: triangle index out of range');
      tris[i] = v;
    }
    const uvs = new Float32Array(sh.nVerts * 2);
    for (let i = 0; i < sh.nVerts * 2; i++) uvs[i] = buf.readFloatLE(p + sh.ofsSt + i * 4);
    const verts = []; // per frame Float32Array(nVerts*3), Quake coords
    for (let f = 0; f < sh.nFrames; f++) {
      const arr = new Float32Array(sh.nVerts * 3);
      const base = p + sh.ofsXyz + f * sh.nVerts * 8;
      for (let v = 0; v < sh.nVerts; v++) {
        arr[v * 3] = buf.readInt16LE(base + v * 8) * XYZ_SCALE;
        arr[v * 3 + 1] = buf.readInt16LE(base + v * 8 + 2) * XYZ_SCALE;
        arr[v * 3 + 2] = buf.readInt16LE(base + v * 8 + 4) * XYZ_SCALE;
      }
      verts.push(arr);
    }
    surfaces.push({ name: sh.name, shaders, nVerts: sh.nVerts, nTris: sh.nTris, tris, uvs, verts });
    p += sh.ofsEnd;
  }
  return { ...h, frames, surfaces };
}

export function md3Info(buf) {
  if (!isMd3(buf)) return null;
  try {
    const m = parseMd3(buf);
    return {
      frames: m.nFrames, surfaces: m.nSurfaces,
      verts: m.surfaces.reduce((a, s) => a + s.nVerts, 0), tris: m.surfaces.reduce((a, s) => a + s.nTris, 0),
      skins: m.surfaces.flatMap(s => s.shaders).slice(0, 8),
    };
  } catch { return null; }
}

// Same client payload shape as md2ToClient: one flattened triangle list, UVs
// already 0..1, all frames' positions as base64 Float32. MD3 UVs are per
// vertex, so the "st index" is the vertex index itself; surfaces are
// concatenated with offset indices.
export function md3ToClient(m, maxFrames = 400) {
  const nF = Math.min(m.nFrames, maxFrames);
  const nVerts = m.surfaces.reduce((a, s) => a + s.nVerts, 0);
  const nTris = m.surfaces.reduce((a, s) => a + s.nTris, 0);
  const tris = new Array(nTris * 6);
  const uvs = new Float32Array(nVerts * 2);
  const all = new Float32Array(nF * nVerts * 3);
  let vBase = 0, tBase = 0;
  for (const s of m.surfaces) {
    for (let t = 0; t < s.nTris; t++) {
      for (let k = 0; k < 3; k++) {
        tris[(tBase + t) * 6 + k] = vBase + s.tris[t * 3 + k];
        tris[(tBase + t) * 6 + 3 + k] = vBase + s.tris[t * 3 + k];
      }
    }
    uvs.set(s.uvs, vBase * 2);
    for (let f = 0; f < nF; f++) all.set(s.verts[f], f * nVerts * 3 + vBase * 3);
    vBase += s.nVerts;
    tBase += s.nTris;
  }
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nVerts; i++) {
    for (let k = 0; k < 3; k++) {
      const x = all[i * 3 + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  return {
    format: 'md3', skinW: 1, skinH: 1, nVerts, nTris, nFrames: nF, totalFrames: m.nFrames,
    skins: m.surfaces.flatMap(s => s.shaders),
    frameNames: m.frames.slice(0, nF).map(f => f.name),
    tris, uvs: Array.from(uvs, x => Math.round(x * 10000) / 10000),
    framesB64: Buffer.from(all.buffer, all.byteOffset, all.byteLength).toString('base64'),
    bounds: { min, max },
  };
}
