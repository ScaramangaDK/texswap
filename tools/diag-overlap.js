// Find coplanar overlapping face pairs in a map (z-fight candidates):
// node tools/diag-overlap.js <installRoot> <mapname> [textureSubstring]
import path from 'node:path';
import { Install } from '../core/scanner.js';

const [root, mapName, filter] = process.argv.slice(2);
const inst = new Install(root);
const bspPath = inst.fs.list(x => x.startsWith('maps/') && x.endsWith('.bsp'))
  .find(p => path.basename(p, '.bsp') === mapName.toLowerCase());
if (!bspPath) throw new Error(`map not found: ${mapName}`);
const buf = inst.fs.read(bspPath);

const magic = buf.toString('latin1', 0, 4);
const extended = magic === 'QBSP';
const lumps = [];
for (let i = 0; i < 19; i++) lumps.push({ ofs: buf.readUInt32LE(8 + i * 8), len: buf.readUInt32LE(12 + i * 8) });

const ml = lumps[13];
const models = [];
for (let p = ml.ofs; p + 48 <= ml.ofs + ml.len; p += 48) {
  models.push({ firstface: buf.readInt32LE(p + 40), numfaces: buf.readInt32LE(p + 44) });
}
const cstr = (s, e) => { const nul = buf.indexOf(0, s); return buf.toString('latin1', s, nul >= 0 && nul < e ? nul : e); };
const entText = cstr(lumps[0].ofs, lumps[0].ofs + lumps[0].len);
const hiddenFaces = new Set();
const faceModel = new Map();
const entRe = /\{([^}]*)\}/g;
let em;
while ((em = entRe.exec(entText)) !== null) {
  const props = {};
  const re = /"([^"]*)"\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(em[1])) !== null) props[m[1].toLowerCase()] = m[2];
  const cls = (props.classname || '').toLowerCase();
  const mm = /^\*(\d+)$/.exec(props.model || '');
  if (mm) {
    const model = models[Number(mm[1])];
    if (!model) continue;
    for (let f = model.firstface; f < model.firstface + model.numfaces; f++) faceModel.set(f, `*${mm[1]} ${cls}`);
    if (cls.startsWith('trigger_') || cls === 'func_areaportal') {
      for (let f = model.firstface; f < model.firstface + model.numfaces; f++) hiddenFaces.add(f);
    }
  }
}

// Q2 lumps: 0 entities, 1 planes, 2 vertices, 3 vis, 4 nodes, 5 texinfo,
// 6 faces, 7 lighting, 8 leaves, 9 leaffaces, 10 leafbrushes, 11 edges,
// 12 surfedges, 13 models
const ti = lumps[5];
const texinfos = [];
for (let p = ti.ofs; p + 76 <= ti.ofs + ti.len; p += 76) {
  texinfos.push({ flags: buf.readUInt32LE(p + 32), name: cstr(p + 40, p + 72).replaceAll('\\', '/').toLowerCase() });
}
const pl = lumps[1];
const plane = i => {
  const p = pl.ofs + i * 20;
  return [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8), buf.readFloatLE(p + 12)];
};
const vl = lumps[2];
const vert = i => { const p = vl.ofs + i * 12; return [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)]; };
const el = lumps[11];
const eStride = extended ? 8 : 4;
const edge = i => { const p = el.ofs + i * eStride; return extended ? [buf.readUInt32LE(p), buf.readUInt32LE(p + 4)] : [buf.readUInt16LE(p), buf.readUInt16LE(p + 2)]; };
const sl = lumps[12];
const surfedge = i => buf.readInt32LE(sl.ofs + i * 4);

const F = lumps[6];
const faceStride = extended ? 28 : 20;
const numFaces = Math.floor(F.len / faceStride);
const lf = lumps[9];
const lfStride = extended ? 4 : 2;
const visibleFaces = new Set();
for (let p = lf.ofs; p + lfStride <= lf.ofs + lf.len; p += lfStride) {
  visibleFaces.add(extended ? buf.readUInt32LE(p) : buf.readUInt16LE(p));
}
for (let mi = 1; mi < models.length; mi++) {
  const mo = models[mi];
  for (let f = mo.firstface; f < mo.firstface + mo.numfaces; f++) visibleFaces.add(f);
}

const SKIP_FLAGS = 4 | 128;
const SKIP_NAMES = /(^|\/)(clip|hint|skip|trigger|origin|null)$/;
const out = [];
for (let i = 0; i < numFaces; i++) {
  if (!visibleFaces.has(i) || hiddenFaces.has(i)) continue;
  const p = F.ofs + i * faceStride;
  let planenum, side, firstEdge, numFEdges, texinfoIdx, lightofs;
  if (extended) {
    planenum = buf.readUInt32LE(p); side = buf.readUInt32LE(p + 4);
    firstEdge = buf.readInt32LE(p + 8); numFEdges = buf.readInt32LE(p + 12);
    texinfoIdx = buf.readInt32LE(p + 16); lightofs = buf.readInt32LE(p + 24);
  } else {
    planenum = buf.readUInt16LE(p); side = buf.readUInt16LE(p + 2);
    firstEdge = buf.readInt32LE(p + 4); numFEdges = buf.readUInt16LE(p + 8);
    texinfoIdx = buf.readUInt16LE(p + 10); lightofs = buf.readInt32LE(p + 16);
  }
  const info = texinfos[texinfoIdx];
  if (!info || numFEdges < 3 || numFEdges > 128) continue;
  if (info.flags & SKIP_FLAGS) continue;
  if (SKIP_NAMES.test(info.name)) continue;
  const poly = [];
  for (let e = 0; e < numFEdges; e++) {
    const se = surfedge(firstEdge + e);
    const [a, b] = edge(Math.abs(se));
    poly.push(vert(se >= 0 ? a : b));
  }
  out.push({ i, planenum, side, name: info.name, flags: info.flags, poly, lit: lightofs >= 0, model: faceModel.get(i) || 'world' });
}

// project polys on their plane's dominant axis, compute pairwise overlap area
const project = (poly, n) => {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const drop = az >= ax && az >= ay ? 2 : ay >= ax ? 1 : 0;
  return poly.map(v => drop === 2 ? [v[0], v[1]] : drop === 1 ? [v[0], v[2]] : [v[1], v[2]]);
};
const area2d = pts => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const clip = (subject, cp1, cp2) => {
  const res = [];
  for (let i = 0; i < subject.length; i++) {
    const cur = subject[i], prev = subject[(i + subject.length - 1) % subject.length];
    const sideOf = pt => (cp2[0] - cp1[0]) * (pt[1] - cp1[1]) - (cp2[1] - cp1[1]) * (pt[0] - cp1[0]);
    const c = sideOf(cur), pv = sideOf(prev);
    const inter = () => {
      const dc = [cp1[0] - cp2[0], cp1[1] - cp2[1]], dp = [cur[0] - prev[0], cur[1] - prev[1]];
      const n1 = cp1[0] * cp2[1] - cp1[1] * cp2[0], n2 = cur[0] * prev[1] - cur[1] * prev[0];
      const n3 = 1.0 / (dc[0] * dp[1] - dc[1] * dp[0]);
      return [(n1 * dp[0] - n2 * dc[0]) * n3, (n1 * dp[1] - n2 * dc[1]) * n3];
    };
    if (c >= 0) { if (pv < 0) res.push(inter()); res.push(cur); }
    else if (pv >= 0) res.push(inter());
  }
  return res;
};
const overlapArea = (a, b) => {
  // ensure CCW
  if (area2d(a) < 0) a = [...a].reverse();
  if (area2d(b) < 0) b = [...b].reverse();
  let poly = a;
  for (let i = 0; i < b.length && poly.length; i++) poly = clip(poly, b[i], b[(i + 1) % b.length]);
  return poly.length ? Math.abs(area2d(poly)) : 0;
};

const byPlane = new Map();
for (const f of out) {
  const k = f.planenum;
  if (!byPlane.has(k)) byPlane.set(k, []);
  byPlane.get(k).push(f);
}
const pairs = [];
for (const [pn, fs] of byPlane) {
  if (fs.length < 2) continue;
  const n = plane(pn);
  for (let i = 0; i < fs.length; i++) {
    for (let j = i + 1; j < fs.length; j++) {
      const A = fs[i], B = fs[j];
      const a2 = project(A.poly, n), b2 = project(B.poly, n);
      const ov = overlapArea(a2, b2);
      if (ov > 4) {
        pairs.push({
          plane: pn, tex: [A.name, B.name], flags: [A.flags.toString(16), B.flags.toString(16)],
          sides: [A.side, B.side], faces: [A.i, B.i], models: [A.model, B.model],
          areas: [Math.abs(area2d(a2)) | 0, Math.abs(area2d(b2)) | 0], overlap: ov | 0,
          lit: [A.lit, B.lit],
        });
      }
    }
  }
}
const sameSide = pairs.filter(p => p.sides[0] === p.sides[1]);
const shown = filter ? pairs.filter(p => p.tex[0].includes(filter) || p.tex[1].includes(filter)) : sameSide;
console.log(`coplanar overlapping pairs (same planenum): ${pairs.length} total, ` +
  `${sameSide.length} SAME-side (real z-fights even one-sided), showing ${shown.length}`);
for (const p of shown.slice(0, 60)) {
  console.log(`plane ${p.plane} sides ${p.sides} faces ${p.faces} overlap ${p.overlap} areas ${p.areas}` +
    ` | ${p.tex[0]} (0x${p.flags[0]}, ${p.models[0]}, lit=${p.lit[0]})` +
    ` vs ${p.tex[1]} (0x${p.flags[1]}, ${p.models[1]}, lit=${p.lit[1]})`);
}
