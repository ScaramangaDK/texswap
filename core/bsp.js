// Quake 2 BSP parser (IBSP v38 + QBSP extended) — just what the app needs:
// worldspawn entity keys, per-texture face counts and surface areas.

const LUMP_ENTITIES = 0;
const LUMP_VERTICES = 2;
const LUMP_TEXINFO = 5;
const LUMP_FACES = 6;
const LUMP_EDGES = 11;
const LUMP_SURFEDGES = 12;

export const SURF_FLAGS = {
  1: 'light', 4: 'sky', 8: 'warp', 16: 'trans33', 32: 'trans66', 64: 'flowing', 128: 'nodraw',
};

function cstr(buf, start, end) {
  let s = buf.toString('latin1', start, end);
  const nul = s.indexOf('\0');
  if (nul >= 0) s = s.slice(0, nul);
  return s;
}

function parseFirstEntity(text) {
  const open = text.indexOf('{');
  if (open < 0) return {};
  const close = text.indexOf('}', open);
  const block = text.slice(open + 1, close < 0 ? undefined : close);
  const out = {};
  const re = /"([^"]*)"\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1].toLowerCase()] = m[2];
  return out;
}

export function parseBsp(buf) {
  const magic = buf.toString('latin1', 0, 4);
  const extended = magic === 'QBSP';
  if (magic !== 'IBSP' && !extended) throw new Error(`not a Quake 2 BSP (magic "${magic}")`);
  const version = buf.readUInt32LE(4);
  const warnings = [];
  if (!extended && version !== 38) warnings.push(`unexpected BSP version ${version}`);

  const lumps = [];
  for (let i = 0; i < 19; i++) {
    lumps.push({ ofs: buf.readUInt32LE(8 + i * 8), len: buf.readUInt32LE(12 + i * 8) });
  }
  const lump = i => {
    const l = lumps[i];
    if (l.ofs + l.len > buf.length) throw new Error(`lump ${i} out of bounds`);
    return l;
  };

  const entLump = lump(LUMP_ENTITIES);
  const worldspawn = parseFirstEntity(cstr(buf, entLump.ofs, entLump.ofs + entLump.len));

  // texinfo (76 bytes in both formats): flags @32, name[32] @40
  const ti = lump(LUMP_TEXINFO);
  const texinfos = [];
  for (let p = ti.ofs; p + 76 <= ti.ofs + ti.len; p += 76) {
    texinfos.push({
      flags: buf.readUInt32LE(p + 32),
      name: cstr(buf, p + 40, p + 72).replaceAll('\\', '/').toLowerCase(),
    });
  }

  const vl = lump(LUMP_VERTICES);
  const numVerts = Math.floor(vl.len / 12);
  const vert = i => {
    const p = vl.ofs + i * 12;
    return [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)];
  };

  const el = lump(LUMP_EDGES);
  const edgeStride = extended ? 8 : 4;
  const numEdges = Math.floor(el.len / edgeStride);
  const edge = i => {
    const p = el.ofs + i * edgeStride;
    return extended
      ? [buf.readUInt32LE(p), buf.readUInt32LE(p + 4)]
      : [buf.readUInt16LE(p), buf.readUInt16LE(p + 2)];
  };

  const sl = lump(LUMP_SURFEDGES);
  const numSurfedges = Math.floor(sl.len / 4);
  const surfedge = i => buf.readInt32LE(sl.ofs + i * 4);

  const fl = lump(LUMP_FACES);
  const faceStride = extended ? 28 : 20;
  if (fl.len % faceStride !== 0) warnings.push(`faces lump size ${fl.len} not divisible by ${faceStride}`);
  const numFaces = Math.floor(fl.len / faceStride);

  // Aggregate per texture name
  const byName = new Map();
  for (let i = 0; i < numFaces; i++) {
    const p = fl.ofs + i * faceStride;
    let firstEdge, numFEdges, texinfoIdx;
    if (extended) {
      firstEdge = buf.readInt32LE(p + 8);
      numFEdges = buf.readInt32LE(p + 12);
      texinfoIdx = buf.readInt32LE(p + 16);
    } else {
      firstEdge = buf.readInt32LE(p + 4);
      numFEdges = buf.readUInt16LE(p + 8);
      texinfoIdx = buf.readUInt16LE(p + 10);
    }
    const info = texinfos[texinfoIdx];
    if (!info) continue;

    // Polygon area via Newell's method
    let nx = 0, ny = 0, nz = 0;
    let valid = numFEdges >= 3;
    let prev = null, first = null;
    for (let e = 0; e < numFEdges && valid; e++) {
      const seIdx = firstEdge + e;
      if (seIdx < 0 || seIdx >= numSurfedges) { valid = false; break; }
      const se = surfedge(seIdx);
      const ei = Math.abs(se);
      if (ei >= numEdges) { valid = false; break; }
      const [a, b] = edge(ei);
      const vi = se >= 0 ? a : b;
      if (vi >= numVerts) { valid = false; break; }
      const v = vert(vi);
      if (prev) { nx += prev[1] * v[2] - prev[2] * v[1]; ny += prev[2] * v[0] - prev[0] * v[2]; nz += prev[0] * v[1] - prev[1] * v[0]; }
      else first = v;
      prev = v;
    }
    let area = 0;
    if (valid && prev && first) {
      nx += prev[1] * first[2] - prev[2] * first[1];
      ny += prev[2] * first[0] - prev[0] * first[2];
      nz += prev[0] * first[1] - prev[1] * first[0];
      area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    }

    let agg = byName.get(info.name);
    if (!agg) { agg = { name: info.name, faces: 0, area: 0, flags: 0 }; byName.set(info.name, agg); }
    agg.faces += 1;
    agg.area += area;
    agg.flags |= info.flags;
  }

  return {
    extended,
    version,
    warnings,
    worldspawn,
    textures: [...byName.values()],
  };
}

export function flagNames(flags) {
  const out = [];
  for (const [bit, name] of Object.entries(SURF_FLAGS)) {
    if (flags & Number(bit)) out.push(name);
  }
  return out;
}
