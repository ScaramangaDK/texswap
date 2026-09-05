// MapSource — uncompiled .map support for the Mapper tab: parse TrenchBroom
// Valve220 and classic QERadiant Quake 2 brush syntax, rebuild renderable
// face windings with engine-true UVs, compute per-texture stats, lint the
// map, and retexture faces with SURGICAL writes (only the touched tokens are
// spliced; every other byte of the mapper's source survives verbatim).
import fs from 'node:fs';
import path from 'node:path';
import { appDataRoot } from './swaps.js';

const EPS = 0.01;
const BOGUS = 128 * 1024;

// ---------- tokenizer ----------
// Splits one face line into tokens with char offsets so writes can splice
// exact fields. Tokens: '(' ')' '[' ']' numbers and names.
function tokenize(line) {
  const out = [];
  const re = /[()\[\]]|[^\s()\[\]]+/g;
  let m;
  while ((m = re.exec(line))) out.push({ t: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

function num(tok) {
  const v = parseFloat(tok);
  return Number.isFinite(v) ? v : 0;
}

// ---------- parse ----------
// Returns { format, lines, entities, faces, warnings } where faces is a flat
// array: { id, ent, brush, line, tex, texStart, texEnd, pts[3][3],
//          axes: {u,v,uo,vo}|null, rot, sx, sy, fieldOffs, extra }
export function parseMapSource(text) {
  const lines = text.split('\n');
  const entities = [];
  const faces = [];
  const warnings = [];
  let format = null; // 'valve' | 'classic' (per-face; mixed is possible in theory)
  let depth = 0;
  let ent = null;
  let brush = -1;
  let inPatch = false;

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('{')) {
      depth++;
      if (depth === 1) {
        ent = { idx: entities.length, line: li, props: {}, propLines: {}, brushes: 0, firstBrushLine: -1 };
        entities.push(ent);
      } else if (depth === 2) {
        brush = ent.brushes++;
        if (ent.firstBrushLine < 0) ent.firstBrushLine = li;
        // Radiant "brushDef"/patchDef blocks are not brush faces
        inPatch = false;
      }
      continue;
    }
    if (line.startsWith('}')) {
      depth--;
      if (depth < 0) { warnings.push(`line ${li + 1}: unbalanced }`); depth = 0; }
      if (depth === 0) ent = null;
      if (depth === 1) inPatch = false;
      continue;
    }
    if (depth === 1 && ent && line.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) {
        if (!(m[1] in ent.props)) { ent.props[m[1]] = m[2]; ent.propLines[m[1]] = li; }
      }
      continue;
    }
    if (depth === 2 && (line.startsWith('patchDef') || line.startsWith('brushDef'))) {
      inPatch = true;
      warnings.push(`line ${li + 1}: ${line.split(/\s/)[0]} block skipped (Radiant primitives are not supported)`);
      continue;
    }
    if (depth >= 2 && !inPatch && line.startsWith('(')) {
      const toks = tokenize(raw);
      // three point groups: ( x y z )
      const pts = [];
      let i = 0;
      let ok = true;
      for (let p = 0; p < 3 && ok; p++) {
        while (i < toks.length && toks[i].t !== '(') i++;
        if (i + 4 >= toks.length || toks[i + 4].t !== ')') { ok = false; break; }
        pts.push([num(toks[i + 1].t), num(toks[i + 2].t), num(toks[i + 3].t)]);
        i += 5;
      }
      if (!ok || i >= toks.length) { warnings.push(`line ${li + 1}: unreadable face`); continue; }
      const texTok = toks[i];
      if ('()[]'.includes(texTok.t)) { warnings.push(`line ${li + 1}: face without texture name`); continue; }
      i++;
      const face = {
        id: faces.length, ent: ent ? ent.idx : 0, brush, line: li,
        tex: texTok.t, texStart: texTok.start, texEnd: texTok.end,
        pts, axes: null, rot: 0, sx: 1, sy: 1, fieldOffs: {}, extra: null,
      };
      if (i < toks.length && toks[i].t === '[') {
        // valve220: [ ux uy uz uoff ] [ vx vy vz voff ] rot sx sy
        format = format || 'valve';
        const u = [num(toks[i + 1].t), num(toks[i + 2].t), num(toks[i + 3].t)];
        const uoT = toks[i + 4];
        const v = [num(toks[i + 7].t), num(toks[i + 8].t), num(toks[i + 9].t)];
        const voT = toks[i + 10];
        if (!uoT || !voT || toks[i + 5].t !== ']' || toks[i + 11].t !== ']') {
          warnings.push(`line ${li + 1}: bad texture axes`); continue;
        }
        face.axes = { u, v, uo: num(uoT.t), vo: num(voT.t) };
        face.fieldOffs.uo = { start: uoT.start, end: uoT.end };
        face.fieldOffs.vo = { start: voT.start, end: voT.end };
        i += 12;
        const rotT = toks[i], sxT = toks[i + 1], syT = toks[i + 2];
        if (sxT && syT) {
          face.rot = num(rotT.t); face.sx = num(sxT.t) || 1; face.sy = num(syT.t) || 1;
          face.fieldOffs.sx = { start: sxT.start, end: sxT.end };
          face.fieldOffs.sy = { start: syT.start, end: syT.end };
          i += 3;
        }
      } else {
        // classic: ox oy rot sx sy
        format = format || 'classic';
        const oxT = toks[i], oyT = toks[i + 1], rotT = toks[i + 2], sxT = toks[i + 3], syT = toks[i + 4];
        if (!syT) { warnings.push(`line ${li + 1}: bad texture fields`); continue; }
        face.axes = null;
        face.ox = num(oxT.t); face.oy = num(oyT.t);
        face.rot = num(rotT.t); face.sx = num(sxT.t) || 1; face.sy = num(syT.t) || 1;
        face.fieldOffs.ox = { start: oxT.start, end: oxT.end };
        face.fieldOffs.oy = { start: oyT.start, end: oyT.end };
        face.fieldOffs.sx = { start: sxT.start, end: sxT.end };
        face.fieldOffs.sy = { start: syT.start, end: syT.end };
        i += 5;
      }
      // optional trailing: contents flags value (offsets recorded so the
      // flag editor can splice or strip them surgically)
      if (i + 2 < toks.length + 1 && toks[i] && !'()[]'.includes(toks[i].t)) {
        const c = toks[i], f = toks[i + 1], v = toks[i + 2];
        if (c && f && v) {
          face.extra = { contents: num(c.t), flags: num(f.t), value: num(v.t) };
          face.fieldOffs.ec = { start: c.start, end: c.end };
          face.fieldOffs.ef = { start: f.start, end: f.end };
          face.fieldOffs.ev = { start: v.start, end: v.end };
        }
      }
      face.lineEnd = toks[toks.length - 1].end;
      faces.push(face);
    }
  }
  if (depth !== 0) warnings.push('unbalanced braces at end of file');
  return { format: format || 'valve', lines, entities, faces, warnings };
}

// ---------- geometry ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm3 = a => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

// Plane through the face's three points, normal facing OUT of the brush
// (qbsp convention: points run clockwise seen from the front).
function planeFromFace(f) {
  const n = norm3(cross(sub(f.pts[2], f.pts[0]), sub(f.pts[1], f.pts[0])));
  if (!n) return null;
  return { n, d: dot(n, f.pts[0]) };
}

function baseWinding(plane) {
  // pick the major axis, build s/t vectors on the plane, huge quad
  const a = plane.n.map(Math.abs);
  const up = a[2] >= a[0] && a[2] >= a[1] ? [1, 0, 0] : [0, 0, 1];
  const s = norm3(cross(plane.n, up));
  const t = cross(plane.n, s);
  const org = scale3(plane.n, plane.d);
  return [
    add3(add3(org, scale3(s, -BOGUS)), scale3(t, -BOGUS)),
    add3(add3(org, scale3(s, BOGUS)), scale3(t, -BOGUS)),
    add3(add3(org, scale3(s, BOGUS)), scale3(t, BOGUS)),
    add3(add3(org, scale3(s, -BOGUS)), scale3(t, BOGUS)),
  ];
}

// clip winding, keeping the part BEHIND the plane (dot - d <= 0)
function clipWinding(w, plane) {
  const dists = w.map(p => dot(plane.n, p) - plane.d);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const j = (i + 1) % w.length;
    const di = dists[i], dj = dists[j];
    if (di <= EPS) out.push(w[i]);
    if ((di < -EPS && dj > EPS) || (di > EPS && dj < -EPS)) {
      const t = di / (di - dj);
      out.push(add3(w[i], scale3(sub(w[j], w[i]), t)));
    }
  }
  return out.length >= 3 ? out : null;
}

function windingArea(w) {
  let area = 0;
  for (let i = 2; i < w.length; i++) {
    area += Math.hypot(...cross(sub(w[i - 1], w[0]), sub(w[i], w[0]))) / 2;
  }
  return area;
}

// classic Q2 texture projection (QuakeEd axis table + rotation)
const BASEAXIS = [
  [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
  [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
  [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
  [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
];

function classicAxes(normal, rot) {
  let best = 0, bestDot = -Infinity;
  for (let i = 0; i < 6; i++) {
    const d = dot(normal, BASEAXIS[i][0]);
    if (d > bestDot + 1e-6) { bestDot = d; best = i; }
  }
  let u = [...BASEAXIS[best][1]], v = [...BASEAXIS[best][2]];
  if (rot) {
    const ang = rot * Math.PI / 180;
    const sinv = Math.sin(ang), cosv = Math.cos(ang);
    let sv = u[0] ? 0 : u[1] ? 1 : 2;
    let tv = v[0] ? 0 : v[1] ? 1 : 2;
    for (const vec of [u, v]) {
      const ns = cosv * vec[sv] - sinv * vec[tv];
      const nt = sinv * vec[sv] + cosv * vec[tv];
      vec[sv] = ns; vec[tv] = nt;
    }
  }
  return { u, v };
}

// texel-space UV for a point on a face
function faceUV(f, p) {
  if (f.axes) {
    return [dot(p, f.axes.u) / (f.sx || 1) + f.axes.uo, dot(p, f.axes.v) / (f.sy || 1) + f.axes.vo];
  }
  if (!f._cAxes) f._cAxes = classicAxes(f._plane.n, f.rot);
  return [dot(p, f._cAxes.u) / (f.sx || 1) + f.ox, dot(p, f._cAxes.v) / (f.sy || 1) + f.oy];
}

// Build windings for every face. Returns { faceGeo: Map(id -> {winding,
// area, plane}), dropped }.
export function buildWindings(parsed) {
  const byBrush = new Map();
  for (const f of parsed.faces) {
    const key = f.ent + ':' + f.brush;
    let arr = byBrush.get(key);
    if (!arr) byBrush.set(key, arr = []);
    arr.push(f);
  }
  const faceGeo = new Map();
  let dropped = 0;
  for (const brushFaces of byBrush.values()) {
    const planes = brushFaces.map(planeFromFace);
    for (let i = 0; i < brushFaces.length; i++) {
      const f = brushFaces[i];
      const plane = planes[i];
      if (!plane) { dropped++; continue; }
      f._plane = plane;
      let w = baseWinding(plane);
      for (let j = 0; j < brushFaces.length && w; j++) {
        if (j === i || !planes[j]) continue;
        w = clipWinding(w, planes[j]);
      }
      if (!w) { dropped++; continue; }
      faceGeo.set(f.id, { winding: w, area: windingArea(w), plane });
    }
  }
  return { faceGeo, dropped };
}

// Faces the game never draws — mirror the BSP viewer's utility logic.
const UTILITY_TEX = /(^|\/)(clip|hint|skip|trigger|origin|null|nodraw)$/i;
export const isUtilityTex = name => UTILITY_TEX.test(name);
const SURF_SKY = 4, SURF_NODRAW = 128;

export function faceIsUtility(f) {
  if (UTILITY_TEX.test(f.tex)) return true;
  if (f.extra && (f.extra.flags & SURF_NODRAW)) return true;
  return false;
}
export const faceIsSky = f => /(^|\/)sky/i.test(f.tex) || Boolean(f.extra && (f.extra.flags & SURF_SKY));

// ---------- render payload ----------
// Groups triangles by texture like the BSP path; UVs come back in texel
// space and are normalized by the caller (which knows the engine dims).
export function renderGroups(parsed, faceGeo) {
  const groups = new Map();
  for (const f of parsed.faces) {
    const geo = faceGeo.get(f.id);
    if (!geo) continue;
    let g = groups.get(f.tex);
    if (!g) groups.set(f.tex, g = { name: f.tex, positions: [], uvs: [], faceRanges: [] });
    const w = geo.winding;
    const triStart = g.positions.length / 9;
    for (let i = 2; i < w.length; i++) {
      // BSP windings arrive clockwise-from-front and the viewer renders
      // BackSide; our windings are counter-clockwise-from-front, so emit
      // reversed to match the viewer's convention
      for (const p of [w[0], w[i], w[i - 1]]) {
        // 2-decimal rounding keeps the JSON payload sane on 17k-face maps
        g.positions.push(Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100);
        const uv = faceUV(f, p);
        g.uvs.push(uv[0], uv[1]);
      }
    }
    g.faceRanges.push({
      face: f.id, ent: f.ent, brush: f.brush, triStart,
      triCount: w.length - 2, utility: faceIsUtility(f), sky: faceIsSky(f),
    });
  }
  return [...groups.values()];
}

// ---------- entities / lights / lints ----------
const parseVec = s => (s || '').trim().split(/\s+/).map(parseFloat);

export function entitySummary(parsed, faceGeo) {
  const ents = [];
  const targetnames = new Map();
  for (const e of parsed.entities) {
    const cls = e.props.classname || '?';
    const origin = e.props.origin ? parseVec(e.props.origin) : null;
    ents.push({
      idx: e.idx, classname: cls, origin,
      brushes: e.brushes, line: e.line + 1,
      targetname: e.props.targetname || null,
      target: e.props.target || null,
      killtarget: e.props.killtarget || null,
      props: e.props,
    });
    if (e.props.targetname) {
      if (!targetnames.has(e.props.targetname)) targetnames.set(e.props.targetname, []);
      targetnames.get(e.props.targetname).push(e.idx);
    }
  }
  // brush entities without origin: use the centroid of their face windings
  const acc = new Map();
  for (const f of parsed.faces) {
    const geo = faceGeo && faceGeo.get(f.id);
    if (!geo || f.ent === 0) continue;
    let a = acc.get(f.ent);
    if (!a) acc.set(f.ent, a = { sum: [0, 0, 0], n: 0 });
    for (const p of geo.winding) { a.sum = add3(a.sum, p); a.n++; }
  }
  for (const e of ents) {
    if (!e.origin || e.origin.length !== 3 || e.origin.some(v => !Number.isFinite(v))) {
      const a = acc.get(e.idx);
      e.origin = a ? scale3(a.sum, 1 / a.n).map(v => Math.round(v)) : null;
    }
  }
  const lights = ents.filter(e => e.classname === 'light' && e.origin).map(e => ({
    origin: e.origin,
    value: parseFloat(e.props.light || e.props._light || '300') || 300,
    color: parseVec(e.props._color || '').length === 3 ? parseVec(e.props._color) : null,
  }));
  const links = [];
  for (const e of ents) {
    for (const kind of ['target', 'killtarget']) {
      if (!e[kind]) continue;
      for (const to of targetnames.get(e[kind]) || []) links.push({ from: e.idx, to, kind });
    }
  }
  return { ents, lights, links, targetnames };
}

export function lintMap(parsed, faceGeo, entInfo, texInfo, dropped) {
  const issues = [];
  const addIssue = (level, kind, msg, extra = {}) => issues.push({ level, kind, msg, ...extra });

  const missing = texInfo.filter(t => t.missing && !t.utility);
  if (missing.length) {
    addIssue('warn', 'missing-tex',
      `${missing.length} texture${missing.length > 1 ? 's' : ''} not found in the install`,
      { textures: missing.map(t => t.name) });
  }
  if (dropped) addIssue('warn', 'degenerate', `${dropped} degenerate face${dropped > 1 ? 's' : ''} produced no geometry (malformed brush planes)`);
  for (const w of parsed.warnings) addIssue('warn', 'parse', w);

  // broken target chains
  for (const e of entInfo.ents) {
    for (const kind of ['target', 'killtarget']) {
      if (e[kind] && !entInfo.targetnames.has(e[kind])) {
        addIssue('warn', 'broken-target',
          `${e.classname} (entity ${e.idx}, line ${e.line}) ${kind}s "${e[kind]}" but nothing has that targetname`,
          { ent: e.idx });
      }
    }
  }
  // orphan targetnames nothing points at (info only)
  const targeted = new Set(entInfo.links.map(l => l.to));
  const orphans = entInfo.ents.filter(e => e.targetname && !targeted.has(e.idx)
    && !['func_areaportal'].includes(e.classname));
  if (orphans.length) {
    addIssue('info', 'orphan-targetname',
      `${orphans.length} targetname${orphans.length > 1 ? 's' : ''} nothing targets (fine if triggered by code)`,
      { ents: orphans.map(e => e.idx) });
  }
  // sound budget: the engine's sound table holds 256 entries total; a big
  // sndlist.ini setup plus many unique speaker sounds overflows it (crash
  // at map start — seen live on Kingslanding 2026-09-04)
  const noises = new Map();
  for (const e of entInfo.ents) {
    if (e.classname === 'target_speaker' && e.props.noise) {
      noises.set(e.props.noise, (noises.get(e.props.noise) || 0) + 1);
    }
  }
  if (noises.size) {
    addIssue(noises.size > 12 ? 'warn' : 'info', 'sound-budget',
      `${noises.size} unique target_speaker sound${noises.size > 1 ? 's' : ''} — the engine's sound table caps at 256 for EVERYTHING (base + sndlist.ini + map); heavy servers overflow and crash on map start`,
      { sounds: [...noises.keys()] });
  }
  // spawns
  const spawnCls = ['info_player_start', 'info_player_deathmatch'];
  const spawns = entInfo.ents.filter(e => spawnCls.includes(e.classname));
  const dmSpawns = entInfo.ents.filter(e => e.classname === 'info_player_deathmatch');
  if (!spawns.length) addIssue('error', 'no-spawn', 'no player spawns (info_player_start / info_player_deathmatch)');
  else if (dmSpawns.length < 8) addIssue('info', 'few-spawns', `${dmSpawns.length} deathmatch spawn${dmSpawns.length === 1 ? '' : 's'} — AQ2 teamplay maps usually want plenty`);

  // duplicate point entities on the exact same origin (double-placed items)
  const seen = new Map();
  for (const e of entInfo.ents) {
    if (!e.origin || e.brushes) continue;
    const k = e.classname + '@' + e.origin.join(',');
    if (seen.has(k)) addIssue('warn', 'duplicate-ent', `two ${e.classname} on the same spot ${e.origin.join(' ')} (lines ${seen.get(k)} and ${e.line})`);
    else seen.set(k, e.line);
  }
  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return issues;
}

// ---------- open (the full payload) ----------
const cache = new Map(); // path -> { key, payload }

export function openMapSource(install, mapPath) {
  const abs = path.resolve(mapPath);
  const st = fs.statSync(abs);
  const key = `${abs}|${st.mtimeMs}|${st.size}|${install ? install.root : ''}`;
  const hit = cache.get(abs);
  if (hit && hit.key === key) return hit.payload;

  const text = fs.readFileSync(abs, 'latin1');
  const parsed = parseMapSource(text);
  if (!parsed.faces.length && !parsed.entities.length) throw new Error('not a .map file (no entities found)');
  const { faceGeo, dropped } = buildWindings(parsed);
  const groups = renderGroups(parsed, faceGeo);

  // per-texture stats + engine dims for UV normalization
  const texStats = new Map();
  for (const f of parsed.faces) {
    let t = texStats.get(f.tex);
    if (!t) texStats.set(f.tex, t = { name: f.tex, faces: 0, area: 0, brushes: new Set(), utility: faceIsUtility(f), sky: faceIsSky(f) });
    t.faces++;
    const geo = faceGeo.get(f.id);
    if (geo) t.area += geo.area;
    t.brushes.add(f.ent + ':' + f.brush);
  }
  let totalArea = 0;
  for (const t of texStats.values()) if (!t.utility && !t.sky) totalArea += t.area;
  const textures = [...texStats.values()].map(t => {
    const dims = install ? install.mappingDims(t.name) : null;
    const hasFile = install ? Boolean(install.fs.findFirst('textures/' + t.name, ['.wal', '.png', '.tga', '.jpg', '.pcx'])) : true;
    return {
      name: t.name, faces: t.faces, brushes: t.brushes.size,
      area: Math.round(t.area),
      areaPct: totalArea > 0 && !t.utility && !t.sky ? +(t.area / totalArea * 100).toFixed(2) : 0,
      w: dims ? dims.w : null, h: dims ? dims.h : null,
      missing: !hasFile, utility: t.utility, sky: t.sky,
    };
  }).sort((a, b) => b.area - a.area || b.faces - a.faces);

  // normalize UVs into repeat space by the ENGINE's mapping dims (wal grid)
  const dimOf = new Map(textures.map(t => [t.name, { w: t.w || 64, h: t.h || 64 }]));
  for (const g of groups) {
    const d = dimOf.get(g.name) || { w: 64, h: 64 };
    for (let i = 0; i < g.uvs.length; i += 2) {
      g.uvs[i] = Math.round(g.uvs[i] / d.w * 10000) / 10000;
      g.uvs[i + 1] = Math.round(g.uvs[i + 1] / d.h * 10000) / 10000;
    }
    g.texW = d.w; g.texH = d.h;
  }

  const entInfo = entitySummary(parsed, faceGeo);
  const issues = lintMap(parsed, faceGeo, entInfo, textures, dropped);

  // bounds + spawns for the camera
  const bounds = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
  for (const g of groups) {
    for (let i = 0; i < g.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (g.positions[i + a] < bounds.min[a]) bounds.min[a] = g.positions[i + a];
        if (g.positions[i + a] > bounds.max[a]) bounds.max[a] = g.positions[i + a];
      }
    }
  }
  const spawns = entInfo.ents
    .filter(e => ['info_player_start', 'info_player_deathmatch'].includes(e.classname) && e.origin)
    .map(e => [...e.origin, parseFloat(e.props.angle || '0') || 0]);

  // faces payload for selection: per face — texture, brush, line, area,
  // and the EFFECTIVE surface/content flags (explicit numbers when present,
  // else the texture's .wal defaults, which the compiler inherits)
  const walDef = new Map();
  const defFor = n => {
    if (!walDef.has(n)) walDef.set(n, walDefaults(install, n));
    return walDef.get(n);
  };
  const facesOut = parsed.faces.map(f => {
    const base = f.extra || defFor(f.tex);
    return {
      id: f.id, ent: f.ent, brush: f.brush, line: f.line + 1, tex: f.tex,
      area: faceGeo.has(f.id) ? Math.round(faceGeo.get(f.id).area) : 0,
      fl: base.flags >>> 0, ct: base.contents >>> 0, va: base.value | 0, ex: Boolean(f.extra),
    };
  });

  const worldspawn = parsed.entities[0] ? parsed.entities[0].props : {};
  const payload = {
    path: abs,
    name: path.basename(abs),
    format: parsed.format,
    mapversion: worldspawn.mapversion || null,
    message: worldspawn.message || null,
    sky: worldspawn.sky || null,
    ericw: Object.keys(worldspawn).some(k => /^_(sunlight|bounce|dirt|minlight)/.test(k)),
    stats: {
      entities: parsed.entities.length,
      brushes: parsed.entities.reduce((n, e) => n + e.brushes, 0),
      faces: parsed.faces.length,
      textures: textures.length,
      lines: parsed.lines.length,
    },
    textures, groups, faces: facesOut,
    ents: entInfo.ents.map(e => ({ ...e, props: e.props })),
    lights: entInfo.lights,
    links: entInfo.links,
    issues,
    bounds, spawns,
    history: historyDepth(abs),
  };
  cache.set(abs, { key, payload, parsed });
  return payload;
}

export function cachedParse(mapPath) {
  const hit = cache.get(path.resolve(mapPath));
  return hit ? hit.parsed : null;
}

// ---------- face edits (surgical writes) + undo/redo ----------
// A Quake 2 .wal ends in flags/contents/value (the texture's baked
// defaults); a face WITHOUT explicit trailing numbers inherits them at
// compile time, so flag edits must start from these.
export function walDefaults(install, name) {
  if (!install) return { flags: 0, contents: 0, value: 0 };
  const buf = install.fs.read('textures/' + name + '.wal');
  if (!buf || buf.length < 100) return { flags: 0, contents: 0, value: 0 };
  return { flags: buf.readUInt32LE(88), contents: buf.readUInt32LE(92), value: buf.readUInt32LE(96) };
}

// per-file undo/redo: each entry stores only the touched lines' old and new
// text, applied by direct splice — exact, tiny, and format-preserving
const history = new Map(); // abs path -> { undo: [entry], redo: [entry] }
const bakDone = new Set(); // one .bak per file per app run — undo covers the rest
const histFor = abs => {
  let h = history.get(abs);
  if (!h) history.set(abs, h = { undo: [], redo: [] });
  return h;
};
export const historyDepth = mapPath => {
  const h = history.get(path.resolve(mapPath));
  return { undo: h ? h.undo.length : 0, redo: h ? h.redo.length : 0 };
};

function writeLines(abs, lines) {
  fs.writeFileSync(abs, lines.join('\n'), 'latin1');
  cache.delete(abs);
}

function backupOnce(abs) {
  if (bakDone.has(abs)) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const backup = abs + '.texswap-' + stamp + '.bak';
  fs.copyFileSync(abs, backup);
  bakDone.add(abs);
  return backup;
}

// changes: [{ face, to?, setSurf?, clearSurf?, setCont?, clearCont?,
//             value?, clearExtra? }], opts: { keepSize }
// - to: retexture (keepSize rewrites scale+offsets so the world size holds)
// - set/clear masks edit surface & content flags starting from the face's
//   explicit numbers or, when absent, the texture's .wal defaults
// - clearExtra: strip the trailing numbers -> back to pure .wal defaults
export function applyFaceEdits(install, mapPath, changes, opts = {}) {
  const abs = path.resolve(mapPath);
  openMapSource(install, abs); // ensures cache holds parsed
  const parsed = cachedParse(abs);
  if (!parsed) throw new Error('map not parsed');
  const byId = new Map(parsed.faces.map(f => [f.id, f]));
  const lines = parsed.lines.slice();
  const perLine = new Map();
  const fmt = v => String(Math.round(v * 10000) / 10000);
  let changed = 0;

  for (const ch of changes) {
    const f = byId.get(ch.face);
    if (!f) continue;
    const splices = [];
    if (ch.to && ch.to !== f.tex) {
      splices.push({ start: f.texStart, end: f.texEnd, text: ch.to });
      if (opts.keepSize && install) {
        const od = install.mappingDims(f.tex);
        const nd = install.mappingDims(ch.to);
        if (od && nd && (od.w !== nd.w || od.h !== nd.h)) {
          const rw = od.w / nd.w, rh = od.h / nd.h;
          if (f.fieldOffs.sx) splices.push({ ...f.fieldOffs.sx, text: fmt((f.sx || 1) * rw) });
          if (f.fieldOffs.sy) splices.push({ ...f.fieldOffs.sy, text: fmt((f.sy || 1) * rh) });
          if (f.axes) {
            if (f.fieldOffs.uo) splices.push({ ...f.fieldOffs.uo, text: fmt(f.axes.uo / rw) });
            if (f.fieldOffs.vo) splices.push({ ...f.fieldOffs.vo, text: fmt(f.axes.vo / rh) });
          } else {
            if (f.fieldOffs.ox) splices.push({ ...f.fieldOffs.ox, text: fmt(f.ox / rw) });
            if (f.fieldOffs.oy) splices.push({ ...f.fieldOffs.oy, text: fmt(f.oy / rh) });
          }
        }
      }
    }
    if (ch.clearExtra && f.extra && f.fieldOffs.sy) {
      splices.push({ start: f.fieldOffs.sy.end, end: f.fieldOffs.ev.end, text: '' });
    } else if (ch.setSurf || ch.clearSurf || ch.setCont || ch.clearCont || ch.value !== undefined) {
      const base = f.extra || walDefaults(install, f.tex);
      const nf = ((base.flags & ~(ch.clearSurf || 0)) | (ch.setSurf || 0)) >>> 0;
      const nc = ((base.contents & ~(ch.clearCont || 0)) | (ch.setCont || 0)) >>> 0;
      const nv = ch.value !== undefined ? Math.round(Number(ch.value) || 0) : base.value;
      if (f.extra) {
        splices.push({ ...f.fieldOffs.ec, text: String(nc) });
        splices.push({ ...f.fieldOffs.ef, text: String(nf) });
        splices.push({ ...f.fieldOffs.ev, text: String(nv) });
      } else {
        splices.push({ start: f.lineEnd, end: f.lineEnd, text: ` ${nc} ${nf} ${nv}` });
      }
    }
    if (!splices.length) continue;
    if (!perLine.has(f.line)) perLine.set(f.line, []);
    perLine.get(f.line).push(...splices);
    changed++;
  }
  if (!changed) return { changed: 0, backup: null, history: historyDepth(abs) };

  const entry = { before: {}, after: {} };
  for (const [li, splices] of perLine) {
    entry.before[li] = lines[li];
    let line = lines[li];
    splices.sort((a, b) => b.start - a.start);
    for (const s of splices) line = line.slice(0, s.start) + s.text + line.slice(s.end);
    lines[li] = line;
    entry.after[li] = line;
  }
  const backup = backupOnce(abs);
  writeLines(abs, lines);
  const h = histFor(abs);
  h.undo.push(entry);
  if (h.undo.length > 60) h.undo.shift();
  h.redo = [];
  return { changed, backup, history: historyDepth(abs) };
}

export function undoRedo(install, mapPath, redo = false) {
  const abs = path.resolve(mapPath);
  const h = histFor(abs);
  const from = redo ? h.redo : h.undo;
  if (!from.length) return { changed: 0, history: historyDepth(abs) };
  const entry = from.pop();
  const apply = redo ? entry.after : entry.before;
  const text = fs.readFileSync(abs, 'latin1');
  const lines = text.split('\n');
  let changed = 0;
  for (const [li, t] of Object.entries(apply)) {
    if (lines[li] !== undefined) { lines[li] = t; changed++; }
  }
  writeLines(abs, lines);
  (redo ? h.undo : h.redo).push(entry);
  return { changed, history: historyDepth(abs) };
}

// ---------- browse + recents ----------
const mapperFile = () => path.join(appDataRoot(), 'mapper.json');

export function mapperState() {
  try { return JSON.parse(fs.readFileSync(mapperFile(), 'utf8')) || {}; } catch { return {}; }
}

export function rememberMap(mapPath) {
  const st = mapperState();
  const abs = path.resolve(mapPath);
  st.recents = [abs, ...(st.recents || []).filter(p => p.toLowerCase() !== abs.toLowerCase())].slice(0, 12);
  st.lastBrowse = path.dirname(abs);
  try {
    fs.mkdirSync(appDataRoot(), { recursive: true });
    fs.writeFileSync(mapperFile(), JSON.stringify(st, null, 2));
  } catch { /* cosmetic */ }
  return st;
}

export function browseMaps(dirPath) {
  if (!dirPath) {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      if (fs.existsSync(d)) drives.push({ name: d, path: d, dir: true });
    }
    return { path: null, parent: null, entries: drives };
  }
  const abs = path.resolve(dirPath);
  const items = fs.readdirSync(abs, { withFileTypes: true });
  const entries = [];
  for (const it of items) {
    if (it.isDirectory()) entries.push({ name: it.name, path: path.join(abs, it.name), dir: true });
    else if (/\.map$/i.test(it.name)) {
      let size = 0, mtime = 0;
      try { const s = fs.statSync(path.join(abs, it.name)); size = s.size; mtime = s.mtimeMs; } catch { /* listed anyway */ }
      entries.push({ name: it.name, path: path.join(abs, it.name), dir: false, size, mtime });
    }
  }
  entries.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || a.name.localeCompare(b.name, 'en'));
  return { path: abs, parent: path.dirname(abs) === abs ? null : path.dirname(abs), entries };
}
