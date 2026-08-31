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
  33554432: 'alphatest', // q2pro extended (1<<25): masked textures, fully transparent holes
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

// Renderable geometry for the 3D viewer: triangulated faces grouped by
// texture, texel-space UVs from the texinfo axes, and player spawn points.
export function extractBspGeometry(buf) {
  const magic = buf.toString('latin1', 0, 4);
  const extended = magic === 'QBSP';
  if (magic !== 'IBSP' && !extended) throw new Error(`not a Quake 2 BSP (magic "${magic}")`);

  const lumps = [];
  for (let i = 0; i < 19; i++) {
    lumps.push({ ofs: buf.readUInt32LE(8 + i * 8), len: buf.readUInt32LE(12 + i * 8) });
  }

  // inline brush models (lump 13): model 0 = world, 1..N = brush entities
  const ml = lumps[13];
  const models = [];
  for (let p = ml.ofs; p + 48 <= ml.ofs + ml.len; p += 48) {
    models.push({ firstface: buf.readInt32LE(p + 40), numfaces: buf.readInt32LE(p + 44) });
  }

  // entities lump: player spawns + brush entities that are invisible in-game
  // (trigger volumes, areaportals) whose faces must not be drawn
  const entText = cstr(buf, lumps[LUMP_ENTITIES].ofs, lumps[LUMP_ENTITIES].ofs + lumps[LUMP_ENTITIES].len);
  const spawns = [];
  const hiddenFaces = new Set();
  const entRe = /\{([^}]*)\}/g;
  let em;
  while ((em = entRe.exec(entText)) !== null) {
    const props = {};
    const re = /"([^"]*)"\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(em[1])) !== null) props[m[1].toLowerCase()] = m[2];
    const cls = (props.classname || '').toLowerCase();
    if (/^info_player_(start|deathmatch)$/.test(cls) && props.origin) {
      const [x, y, z] = props.origin.split(/\s+/).map(Number);
      if ([x, y, z].every(Number.isFinite)) spawns.push([x, y, z, Number(props.angle || 0) || 0]);
    }
    const mm = /^\*(\d+)$/.exec(props.model || '');
    if (mm && (cls.startsWith('trigger_') || cls === 'func_areaportal')) {
      const model = models[Number(mm[1])];
      if (model) {
        for (let f = model.firstface; f < model.firstface + model.numfaces; f++) hiddenFaces.add(f);
      }
    }
  }

  const ti = lumps[LUMP_TEXINFO];
  const texinfos = [];
  for (let p = ti.ofs; p + 76 <= ti.ofs + ti.len; p += 76) {
    texinfos.push({
      u: [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8), buf.readFloatLE(p + 12)],
      v: [buf.readFloatLE(p + 16), buf.readFloatLE(p + 20), buf.readFloatLE(p + 24), buf.readFloatLE(p + 28)],
      flags: buf.readUInt32LE(p + 32),
      name: cstr(buf, p + 40, p + 72).replaceAll('\\', '/').toLowerCase(),
    });
  }

  const vl = lumps[LUMP_VERTICES];
  const numVerts = Math.floor(vl.len / 12);
  const vert = i => {
    const p = vl.ofs + i * 12;
    return [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)];
  };
  const el = lumps[LUMP_EDGES];
  const edgeStride = extended ? 8 : 4;
  const numEdges = Math.floor(el.len / edgeStride);
  const edge = i => {
    const p = el.ofs + i * edgeStride;
    return extended
      ? [buf.readUInt32LE(p), buf.readUInt32LE(p + 4)]
      : [buf.readUInt16LE(p), buf.readUInt16LE(p + 2)];
  };
  const sl = lumps[LUMP_SURFEDGES];
  const numSurfedges = Math.floor(sl.len / 4);
  const surfedge = i => buf.readInt32LE(sl.ofs + i * 4);

  const fl = lumps[LUMP_FACES];
  const faceStride = extended ? 28 : 20;
  const numFaces = Math.floor(fl.len / faceStride);

  const ll = lumps[7]; // lighting lump: 3-byte RGB luxels

  const SKIP_FLAGS = 4 | 128; // SURF_SKY | SURF_NODRAW
  const SURF_WARP = 8;
  const SKIP_NAMES = /(^|\/)(clip|hint|skip|trigger|origin|null)$/;
  const bounds = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };

  // pass 1: gather faces with texel UVs and lightmap block info
  const facesOut = [];
  for (let i = 0; i < numFaces; i++) {
    if (hiddenFaces.has(i)) continue;
    const p = fl.ofs + i * faceStride;
    let firstEdge, numFEdges, texinfoIdx, lightofs;
    if (extended) {
      firstEdge = buf.readInt32LE(p + 8);
      numFEdges = buf.readInt32LE(p + 12);
      texinfoIdx = buf.readInt32LE(p + 16);
      lightofs = buf.readInt32LE(p + 24);
    } else {
      firstEdge = buf.readInt32LE(p + 4);
      numFEdges = buf.readUInt16LE(p + 8);
      texinfoIdx = buf.readUInt16LE(p + 10);
      lightofs = buf.readInt32LE(p + 16);
    }
    const info = texinfos[texinfoIdx];
    if (!info || numFEdges < 3 || numFEdges > 128) continue;
    if (info.flags & SKIP_FLAGS) continue;
    if (SKIP_NAMES.test(info.name)) continue;

    const poly = [];
    let valid = true;
    for (let e = 0; e < numFEdges; e++) {
      const seIdx = firstEdge + e;
      if (seIdx < 0 || seIdx >= numSurfedges) { valid = false; break; }
      const se = surfedge(seIdx);
      const ei = Math.abs(se);
      if (ei >= numEdges) { valid = false; break; }
      const [a, b] = edge(ei);
      const vi = se >= 0 ? a : b;
      if (vi >= numVerts) { valid = false; break; }
      const pt = vert(vi);
      const tu = pt[0] * info.u[0] + pt[1] * info.u[1] + pt[2] * info.u[2] + info.u[3];
      const tv = pt[0] * info.v[0] + pt[1] * info.v[1] + pt[2] * info.v[2] + info.v[3];
      poly.push({ pt, tu, tv });
      for (let k = 0; k < 3; k++) {
        if (pt[k] < bounds.min[k]) bounds.min[k] = pt[k];
        if (pt[k] > bounds.max[k]) bounds.max[k] = pt[k];
      }
    }
    if (!valid) continue;

    // lightmap block (style-0) dims from texel extents, 16 texels per luxel
    let lm = null;
    if (lightofs >= 0 && ll.len > 0) {
      let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
      for (const v of poly) {
        if (v.tu < umin) umin = v.tu;
        if (v.tu > umax) umax = v.tu;
        if (v.tv < vmin) vmin = v.tv;
        if (v.tv > vmax) vmax = v.tv;
      }
      const smin = Math.floor(umin / 16), tmin = Math.floor(vmin / 16);
      const w = Math.ceil(umax / 16) - smin + 1;
      const h = Math.ceil(vmax / 16) - tmin + 1;
      if (w > 0 && h > 0 && w <= 66 && h <= 66 && lightofs + w * h * 3 <= ll.len) {
        lm = { w, h, ofs: lightofs, smin, tmin };
      }
    }
    facesOut.push({ name: info.name, flags: info.flags, poly, lm });
  }

  // pass 2: shelf-pack lightmap blocks into one RGB atlas (1px padded)
  const ATLAS_W = 1024;
  const MASKED_BITS = 8 | 16 | 32 | 33554432; // warp | trans33 | trans66 | alphatest
  const lit = facesOut.filter(f => f.lm).sort((a, b) => b.lm.h - a.lm.h);
  // (0,0)..(4,4) reserved white (unlit), (6,0)..(10,4) reserved mid-grey
  let cx = 12, cy = 0, shelfH = 6;
  for (const f of lit) {
    const bw = f.lm.w + 2, bh = f.lm.h + 2;
    if (cx + bw > ATLAS_W) { cx = 0; cy += shelfH; shelfH = bh; }
    if (bh > shelfH) shelfH = bh;
    f.lm.ax = cx + 1;
    f.lm.ay = cy + 1;
    cx += bw;
  }
  let atlasH = 4;
  for (let p2 = 4; p2 <= 8192; p2 *= 2) { if (p2 >= cy + shelfH) { atlasH = p2; break; } }
  const atlas = Buffer.alloc(ATLAS_W * atlasH * 3, 255);
  for (let y = 0; y < 4 && y < atlasH; y++) {
    for (let x = 6; x < 10; x++) {
      const d = (y * ATLAS_W + x) * 3;
      atlas[d] = atlas[d + 1] = atlas[d + 2] = 128;
    }
  }
  for (const f of lit) {
    const { w, h, ofs, ax, ay } = f.lm;
    let lumSum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ll.ofs + ofs + (y * w + x) * 3;
        const d = ((ay + y) * ATLAS_W + (ax + x)) * 3;
        atlas[d] = buf[s];
        atlas[d + 1] = buf[s + 1];
        atlas[d + 2] = buf[s + 2];
        lumSum += buf[s] + buf[s + 1] + buf[s + 2];
      }
    }
    // masked overlays whose bake is essentially black (compiler lit them as
    // inside the wall) fall back to neutral grey instead of glowing or vanishing
    const avg = lumSum / (w * h * 3);
    if ((f.flags & MASKED_BITS) && avg < 8) f.useGrey = true;
  }

  // pass 3: triangulate into groups keyed by texture + surface type, so the
  // same texture used as plain wall AND masked overlay gets separate materials
  const groups = new Map();
  const whiteU = 2 / ATLAS_W, whiteV = 2 / atlasH;
  const greyU = 8 / ATLAS_W, greyV = 2 / atlasH;
  for (const f of facesOut) {
    const key = f.name + '|' + (f.flags & MASKED_BITS);
    let g = groups.get(key);
    if (!g) {
      g = { name: f.name, flags: 0, positions: [], uvs: [], luvs: [] };
      groups.set(key, g);
    }
    g.flags |= f.flags;
    const pushVert = v => {
      g.positions.push(Math.round(v.pt[0] * 10) / 10, Math.round(v.pt[1] * 10) / 10, Math.round(v.pt[2] * 10) / 10);
      g.uvs.push(Math.round(v.tu * 100) / 100, Math.round(v.tv * 100) / 100);
      if (f.useGrey) {
        g.luvs.push(greyU, greyV);
      } else if (f.lm) {
        const lu = (f.lm.ax + (v.tu / 16 - f.lm.smin) + 0.5) / ATLAS_W;
        const lv = (f.lm.ay + (v.tv / 16 - f.lm.tmin) + 0.5) / atlasH;
        g.luvs.push(Math.round(lu * 100000) / 100000, Math.round(lv * 100000) / 100000);
      } else {
        g.luvs.push(whiteU, whiteV);
      }
    };
    for (let t = 1; t + 1 < f.poly.length; t++) {
      pushVert(f.poly[0]);
      pushVert(f.poly[t]);
      pushVert(f.poly[t + 1]);
    }
  }

  return {
    extended,
    groups: [...groups.values()],
    spawns,
    bounds,
    lightAtlas: { width: ATLAS_W, height: atlasH, rgb: atlas },
  };
}
