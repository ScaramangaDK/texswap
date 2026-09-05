// Mapper's Edition — a dedicated tab for UNCOMPILED .map sources:
// fly through the map with the install's real textures, select faces /
// brushes / whole textures, and retexture in bulk with surgical writes.
// The editor edits; this tab SEES what the game sees.
import * as THREE from '/vendor/three.module.js';

const $ = id => document.getElementById(id);
const AQTS = () => window.AQTS;

const M = {
  open: false,
  payload: null,
  recents: [],
  catalog: null,
  catalogDir: null,
  sel: new Set(),        // face ids
  faceIndex: null,       // id -> { group, range, tri positions offset }
  facesById: null,       // id -> payload.faces entry
  entsByIdx: null,
  three: null,           // { renderer, scene, camera, meshes, ... }
  camSave: null,
  entTimer: 0,
};

function api(pathname, params = {}) {
  const url = new URL(pathname, location.origin);
  url.searchParams.set('dir', AQTS().state.dir);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url).then(async r => {
    const b = await r.json();
    if (!r.ok) throw new Error(b.error || r.statusText);
    return b;
  });
}
function apiPost(pathname, body) {
  return fetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: AQTS().state.dir, ...body }),
  }).then(async r => {
    const b = await r.json();
    if (!r.ok) throw new Error(b.error || r.statusText);
    return b;
  });
}
const toast = (m, e) => AQTS().toast(m, e);
const fmtBytes = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';

// ---------- modal (reuses the app's #modal DOM) ----------
function openModal(html) {
  $('modal').innerHTML = html;
  $('modalOverlay').classList.remove('hidden');
  $('modal').querySelectorAll('.mclose').forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() {
  $('modalOverlay').classList.add('hidden');
  $('modal').innerHTML = '';
}
const modalOpen = () => !$('modalOverlay').classList.contains('hidden');

// ---------- open / close the tab ----------
async function openTab() {
  M.open = true;
  $('mapperOverlay').classList.remove('hidden');
  $('sideTabMapper').classList.add('active');
  $('sideTabMaps').classList.remove('active');
  if (!M.payload) {
    $('mpEmpty').classList.remove('hidden');
    try {
      const st = await api('/api/mapsrc/state');
      M.recents = st.recents || [];
    } catch { M.recents = []; }
    renderRecents();
  }
}

function closeTab() {
  M.open = false;
  $('mapperOverlay').classList.add('hidden');
  $('sideTabMapper').classList.remove('active');
  $('sideTabMaps').classList.add('active');
}

function renderRecents() {
  const box = $('mpRecents');
  box.textContent = '';
  if (!M.recents.length) return;
  const h = document.createElement('div');
  h.className = 'mp-grouphead';
  h.textContent = 'Recent';
  box.appendChild(h);
  for (const p of M.recents.slice(0, 6)) {
    const b = document.createElement('button');
    b.textContent = p;
    b.title = p;
    b.addEventListener('click', () => loadMap(p));
    box.appendChild(b);
  }
}

// ---------- browse dialog ----------
async function openBrowse(startPath = null) {
  openModal(`
    <div class="mhead"><h3>Open a .map source</h3><button class="mclose">✕</button></div>
    <div class="mbody">
      <div id="mpBrowsePath" class="count mono" style="margin-bottom:8px"></div>
      <div id="mpBrowseList" class="mp-browse"></div>
    </div>
    <div class="mfoot"><span class="count">Uncompiled TrenchBroom / Radiant sources (Quake 2 or Valve220 format)</span></div>
  `);
  const render = async p => {
    let data;
    try { data = await api('/api/mapsrc/browse', p ? { path: p } : {}); }
    catch (e) { toast(e.message, true); return; }
    $('mpBrowsePath').textContent = data.path || 'Drives';
    const list = $('mpBrowseList');
    list.textContent = '';
    if (data.parent || data.path) {
      const up = document.createElement('button');
      up.innerHTML = '⬆️ <b>..</b>';
      up.addEventListener('click', () => render(data.parent));
      list.appendChild(up);
    }
    for (const e of data.entries) {
      const b = document.createElement('button');
      if (e.dir) {
        b.innerHTML = `📁 ${e.name}`;
        b.addEventListener('click', () => render(e.path));
      } else {
        b.innerHTML = `🗺️ <b>${e.name}</b><span class="meta">${fmtBytes(e.size)} · ${new Date(e.mtime).toLocaleDateString()}</span>`;
        b.addEventListener('click', () => { closeModal(); loadMap(e.path); });
      }
      list.appendChild(b);
    }
    if (!data.entries.length) {
      const d = document.createElement('div');
      d.className = 'count';
      d.textContent = 'nothing here';
      list.appendChild(d);
    }
  };
  let start = startPath;
  if (!start) {
    try { start = (await api('/api/mapsrc/state')).lastBrowse || null; } catch { start = null; }
  }
  render(start);
}

// ---------- load + scene ----------
async function loadMap(mapPath) {
  $('mpStatus').textContent = 'reading ' + mapPath.split(/[\\/]/).pop() + '…';
  let r;
  try {
    r = await apiPost('/api/mapsrc/open', { path: mapPath });
  } catch (e) {
    toast(e.message, true);
    $('mpStatus').textContent = '';
    return;
  }
  M.recents = r.recents || M.recents;
  setPayload(r.payload);
  toast(`${r.payload.name}: ${r.payload.stats.faces} faces, ${r.payload.stats.brushes} brushes, ${r.payload.stats.textures} textures`);
}

function setPayload(payload, keepCamera = false, keepSel = false) {
  if (keepCamera && M.three) {
    M.camSave = {
      pos: M.three.camera.position.clone(),
      yaw: M.three.yaw, pitch: M.three.pitch,
    };
  } else {
    M.camSave = null;
  }
  M.payload = payload;
  // face ids are parse-order and edits never add or remove lines, so a
  // selection stays valid across saves — essential for paint-and-compare
  M.sel = keepSel ? new Set([...M.sel].filter(id => id < payload.faces.length)) : new Set();
  M.facesById = new Map(payload.faces.map(f => [f.id, f]));
  M.entsByIdx = new Map(payload.ents.map(e => [e.idx, e]));
  $('mpEmpty').classList.add('hidden');
  $('mpFile').textContent = payload.name;
  $('mpFile').title = payload.path;
  const badges = [`<span class="badge">${payload.format === 'valve' ? 'Valve220' : 'classic Q2'}</span>`];
  if (payload.ericw) badges.push('<span class="badge ericw" title="worldspawn carries ericw-tools light keys (_sunlight2, _bounce, _dirt...)">ericw-tools</span>');
  $('mpBadges').innerHTML = badges.join('');
  const s = payload.stats;
  $('mpStatus').textContent = `${s.brushes} brushes · ${s.faces} faces · ${s.entities} entities · ${s.textures} textures`;
  $('mpNotes').classList.toggle('hidden', !payload.issues.length);
  $('mpNotesCount').textContent = payload.issues.length;
  updateHistoryButtons();
  buildScene();
  if (M.sel.size) rebuildSelMesh();
  renderPanel();
  updateSelUI();
  renderFlagsBox();
}

function updateHistoryButtons() {
  const h = (M.payload && M.payload.history) || { undo: 0, redo: 0 };
  $('mpUndo').disabled = !h.undo;
  $('mpRedo').disabled = !h.redo;
}

// one shared write path: texture paints, the retexture modal and the flag
// editor all go through /api/mapsrc/edit and land in the same undo history
async function applyEdit(changes, doneMsg) {
  if (!M.payload || !changes.length) return;
  $('mpStatus').textContent = `writing ${changes.length} face${changes.length === 1 ? '' : 's'}…`;
  try {
    const r = await apiPost('/api/mapsrc/edit', {
      path: M.payload.path,
      changes,
      keepSize: $('mpKeepSize').checked,
    });
    for (const t of r.missingTargets || []) toast(`${t} is not in this install — it will show as missing until the pack is in place`, true);
    if (doneMsg) toast(doneMsg + (r.backup ? ` · backup: ${String(r.backup).split(/[\\/]/).pop()}` : ''));
    setPayload(r.payload, true, true);
  } catch (e) {
    toast(e.message, true);
    $('mpStatus').textContent = '';
  }
}

function paintSelection(to) {
  const n = M.sel.size;
  applyEdit([...M.sel].map(id => ({ face: id, to })), `${n} face${n === 1 ? '' : 's'} → ${to}`);
}

async function doUndoRedo(redo) {
  if (!M.payload) return;
  try {
    const r = await apiPost(redo ? '/api/mapsrc/redo' : '/api/mapsrc/undo', { path: M.payload.path });
    if (!r.changed) { toast(redo ? 'nothing to redo' : 'nothing to undo'); return; }
    toast(redo ? '↷ redone' : '↶ undone');
    setPayload(r.payload, true, true);
  } catch (e) {
    toast(e.message, true);
  }
}

function disposeScene() {
  const t = M.three;
  if (!t) return;
  cancelAnimationFrame(t.raf);
  window.removeEventListener('resize', t.onResize);
  window.removeEventListener('mousemove', t.onMove);
  window.removeEventListener('mouseup', t.onUp);
  window.removeEventListener('keydown', t.onKey);
  window.removeEventListener('keyup', t.onKey);
  t.scene.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
  });
  for (const tex of t.texCache.values()) tex.dispose();
  t.renderer.dispose();
  M.three = null;
}

const q2three = (x, y, z) => [x, z, -y];

function buildScene() {
  disposeScene();
  const payload = M.payload;
  const canvas = $('mpCanvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141a);
  const camera = new THREE.PerspectiveCamera(80, 1, 1, 30000);
  camera.rotation.order = 'YXZ';

  const t = M.three = {
    renderer, scene, camera, maxAniso,
    loader: new THREE.TextureLoader(),
    texCache: new Map(),
    meshes: [],
    keys: new Set(),
    raycaster: new THREE.Raycaster(),
    raf: 0,
    yaw: 0, pitch: 0,
    last: performance.now(),
    selMesh: null,
    lightsGroup: null,
    linksGroup: null,
    marker: null,
  };
  M.faceIndex = new Map();

  // editor-style shading: faces lit by their orientation, so geometry reads
  // without lightmaps (an uncompiled map has none)
  const L = new THREE.Vector3(0.4, 0.85, 0.3).normalize();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3();

  const SURF_TRANS = 16 | 32;
  for (const g of payload.groups) {
    const n = g.positions.length / 3;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = q2three(g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]);
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 3) {
      va.fromArray(pos, i * 3); vb.fromArray(pos, i * 3 + 3); vc.fromArray(pos, i * 3 + 6);
      ab.subVectors(vb, va); ac.subVectors(vc, va);
      nrm.crossVectors(ac, ab).normalize(); // BackSide winding: front normal
      const b = 0.62 + 0.38 * Math.max(0, nrm.dot(L));
      for (let k = 0; k < 9; k += 3) { colors[i * 3 + k] = b; colors[i * 3 + k + 1] = b; colors[i * 3 + k + 2] = b; }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.uvs), 2));
    bg.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const texInfo = payload.textures.find(x => x.name === g.name);
    const url = AQTS().thumbUrl({ tex: g.name, size: 1024 });
    let tex = t.texCache.get(url);
    if (!tex) {
      tex = t.loader.load(url);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      t.texCache.set(url, tex);
    }
    const utility = texInfo && texInfo.utility;
    // .map sources rarely carry surface flags, so translucency goes by
    // name: glass, windows and see-through helper textures render thin
    const transHint = /(^|\/|_)(transparent|invisible|glass|window|wndw|water|slime)/i.test(g.name);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      vertexColors: true,
      side: THREE.BackSide,
      transparent: Boolean(utility || transHint),
      opacity: utility ? 0.35 : transHint ? 0.45 : 1,
      depthWrite: !transHint,
    });
    const mesh = new THREE.Mesh(bg, mat);
    mesh.userData.texName = g.name;
    mesh.userData.utility = Boolean(utility);
    mesh.userData.faceRanges = g.faceRanges;
    mesh.userData.srcPositions = g.positions;
    mesh.visible = !utility || $('mpUtility').checked;
    scene.add(mesh);
    t.meshes.push(mesh);
    for (const r of g.faceRanges) M.faceIndex.set(r.face, { mesh, range: r });
  }

  buildLights();
  buildLinks();

  // camera: restore, else spawn, else above bounds
  if (M.camSave) {
    camera.position.copy(M.camSave.pos);
    t.yaw = M.camSave.yaw; t.pitch = M.camSave.pitch;
  } else if (payload.spawns.length) {
    const [x, y, z, angle] = payload.spawns[0];
    camera.position.set(x, z + 40, -y);
    t.yaw = THREE.MathUtils.degToRad(angle - 90);
  } else {
    const c = payload.bounds;
    camera.position.set((c.min[0] + c.max[0]) / 2, c.max[2] + 300, -(c.min[1] + c.max[1]) / 2);
    t.pitch = -0.9;
  }

  const overlayEl = $('mapperOverlay');
  const resize = () => {
    const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  t.onResize = resize;
  window.addEventListener('resize', resize);

  let dragging = false, moved = 0, lastX = 0, lastY = 0;
  canvas.addEventListener('mousedown', e => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; });
  t.onMove = e => {
    if (!M.open) return;
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX; lastY = e.clientY;
      t.yaw -= dx * 0.004;
      t.pitch = Math.max(-1.5, Math.min(1.5, t.pitch - dy * 0.004));
    } else hover(e);
  };
  t.onUp = e => {
    if (dragging && moved < 5 && e.target === canvas) select(e);
    dragging = false;
  };
  t.onKey = e => {
    if (!M.open) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
    if (e.type === 'keydown') {
      if (e.code === 'Escape') {
        if (modalOpen()) closeModal();
        else if (M.sel.size) clearSel();
        else closeTab();
        return;
      }
      if (typing || modalOpen()) return;
      if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); doUndoRedo(e.shiftKey); return; }
      if (e.ctrlKey && e.code === 'KeyY') { e.preventDefault(); doUndoRedo(true); return; }
      if (e.code === 'KeyB') { growBrush(); return; }
      if (e.code === 'KeyT') { growTexture(); return; }
      t.keys.add(e.code);
    } else t.keys.delete(e.code);
  };
  window.addEventListener('mousemove', t.onMove);
  window.addEventListener('mouseup', t.onUp);
  window.addEventListener('keydown', t.onKey);
  window.addEventListener('keyup', t.onKey);

  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - t.last) / 1000);
    t.last = now;
    camera.rotation.set(t.pitch, t.yaw, 0);
    if (!modalOpen()) {
      const speed = (t.keys.has('ShiftLeft') || t.keys.has('ShiftRight')) ? 1400 : 450;
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
      const move = new THREE.Vector3();
      if (t.keys.has('KeyW')) move.add(fwd);
      if (t.keys.has('KeyS')) move.sub(fwd);
      if (t.keys.has('KeyD')) move.add(right);
      if (t.keys.has('KeyA')) move.sub(right);
      if (t.keys.has('KeyE')) move.y += 1;
      if (t.keys.has('KeyQ')) move.y -= 1;
      if (move.lengthSq()) camera.position.addScaledVector(move.normalize(), speed * dt);
    }
    if (t.marker) t.marker.rotation.y += dt * 1.5;
    renderer.render(scene, camera);
    t.raf = requestAnimationFrame(step);
  };
  step();
}

function buildLights() {
  const t = M.three;
  if (t.lightsGroup) { t.scene.remove(t.lightsGroup); }
  const lights = M.payload.lights || [];
  if (!lights.length || !$('mpLights').checked) { t.lightsGroup = null; return; }
  const geo = new THREE.SphereGeometry(1, 10, 8);
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 });
  const inst = new THREE.InstancedMesh(geo, mat, lights.length);
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  lights.forEach((l, i) => {
    const [x, y, z] = q2three(...l.origin);
    const r = Math.min(16, 3 + l.value / 60);
    m4.makeScale(r, r, r).setPosition(x, y, z);
    inst.setMatrixAt(i, m4);
    if (l.color) {
      const mx = Math.max(...l.color) > 1.001 ? 255 : 1;
      col.setRGB(l.color[0] / mx, l.color[1] / mx, l.color[2] / mx);
    } else col.setRGB(1, 0.9, 0.7);
    inst.setColorAt(i, col);
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  t.scene.add(inst);
  t.lightsGroup = inst;
}

function buildLinks() {
  const t = M.three;
  if (t.linksGroup) t.scene.remove(t.linksGroup);
  t.linksGroup = null;
  if (!$('mpLinks').checked) return;
  const group = new THREE.Group();
  const mk = (links, color) => {
    const pts = [];
    for (const l of links) {
      const a = M.entsByIdx.get(l.from), b = M.entsByIdx.get(l.to);
      if (!a || !b || !a.origin || !b.origin) continue;
      pts.push(...q2three(...a.origin), ...q2three(...b.origin));
    }
    if (!pts.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 })));
  };
  mk((M.payload.links || []).filter(l => l.kind === 'target'), 0x5aa7ff);
  mk((M.payload.links || []).filter(l => l.kind === 'killtarget'), 0xff6b6b);
  t.scene.add(group);
  t.linksGroup = group;
}

// ---------- picking ----------
function pickFace(e) {
  const t = M.three;
  const canvas = $('mpCanvas');
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  t.raycaster.setFromCamera(ndc, t.camera);
  const hits = t.raycaster.intersectObjects(t.meshes.filter(m => m.visible), false);
  if (!hits.length) return null;
  const mesh = hits[0].object;
  const tri = hits[0].faceIndex;
  for (const r of mesh.userData.faceRanges) {
    if (tri >= r.triStart && tri < r.triStart + r.triCount) return r;
  }
  return null;
}

let hoverThrottle = 0;
function hover(e) {
  const now = performance.now();
  if (now - hoverThrottle < 80 || e.target !== $('mpCanvas')) return;
  hoverThrottle = now;
  const r = pickFace(e);
  if (!r) { $('mpHover').textContent = ''; return; }
  const f = M.facesById.get(r.face);
  const ent = M.entsByIdx.get(f.ent);
  $('mpHover').textContent = `${f.tex} · brush ${f.brush}${ent && ent.idx ? ' · ' + ent.classname : ''} · line ${f.line}`;
}

function select(e) {
  const r = pickFace(e);
  if (!r) { if (!e.ctrlKey) clearSel(); return; }
  if (e.ctrlKey) {
    if (M.sel.has(r.face)) M.sel.delete(r.face); else M.sel.add(r.face);
  } else {
    M.sel = new Set([r.face]);
  }
  selChanged();
}

function clearSel() {
  M.sel = new Set();
  selChanged();
}

function growBrush() {
  if (!M.sel.size) return;
  const keys = new Set();
  for (const id of M.sel) {
    const f = M.facesById.get(id);
    keys.add(f.ent + ':' + f.brush);
  }
  for (const f of M.payload.faces) if (keys.has(f.ent + ':' + f.brush)) M.sel.add(f.id);
  selChanged();
}

function growTexture() {
  if (!M.sel.size) return;
  const texes = new Set([...M.sel].map(id => M.facesById.get(id).tex));
  for (const f of M.payload.faces) if (texes.has(f.tex)) M.sel.add(f.id);
  selChanged();
}

function selectTexture(name, add = false) {
  if (!add) M.sel = new Set();
  for (const f of M.payload.faces) if (f.tex === name) M.sel.add(f.id);
  selChanged();
}

function selChanged() {
  rebuildSelMesh();
  updateSelUI();
  renderFlagsBox();
  renderPanel(); // sync tile highlights + paint hints
}

// ---------- map notes (the old Issues tab, boiled down to a card) ----------
function showNotes() {
  const card = $('mpEntCard');
  if (!card.classList.contains('hidden') && card.dataset.mode === 'notes') {
    card.classList.add('hidden');
    return;
  }
  const parts = [];
  for (const i of M.payload.issues) {
    const icon = i.level === 'error' ? '⛔' : i.level === 'warn' ? '⚠️' : 'ℹ️';
    let extra = '';
    if (i.textures) extra = `<div style="margin-top:4px"><button class="small" data-seltex="${i.textures.join('|').replace(/"/g, '&quot;')}">select those faces</button></div>`;
    if (i.ent !== undefined && M.entsByIdx.get(i.ent)) extra = `<div style="margin-top:4px"><button class="small" data-flyto="${i.ent}">fly to it</button></div>`;
    const tip = (i.sounds || i.textures || []).join(', ');
    parts.push(`<div class="mp-issue ${i.level}" ${tip ? `title="${tip.replace(/"/g, '&quot;')}"` : ''}><b>${icon} ${i.kind}</b><br>${i.msg}${extra}</div>`);
  }
  card.innerHTML = `<h4>Map notes <span class="count">· ${M.payload.issues.length}</span></h4>
    ${parts.join('') || '<div class="count">✓ nothing to report</div>'}
    <div style="margin-top:8px"><button class="small" id="mpEntCardClose">✕ close</button></div>`;
  card.dataset.mode = 'notes';
  card.classList.remove('hidden');
  $('mpEntCardClose').addEventListener('click', () => card.classList.add('hidden'));
  card.querySelectorAll('[data-seltex]').forEach(b => b.addEventListener('click', () => {
    const texes = b.dataset.seltex.split('|');
    M.sel = new Set();
    for (const f of M.payload.faces) if (texes.includes(f.tex)) M.sel.add(f.id);
    selChanged();
  }));
  card.querySelectorAll('[data-flyto]').forEach(b => b.addEventListener('click', () => {
    const e = M.entsByIdx.get(Number(b.dataset.flyto));
    if (e) flyTo(e);
  }));
}

// ---------- surface / content properties (bottom of the panel) ----------
const SURF_BITS = [
  [0x1, 'light', 'face emits light — set value to the radiance'],
  [0x2, 'slick', 'slippery surface'],
  [0x4, 'sky', 'sky surface'],
  [0x8, 'warp', 'liquid warp distortion'],
  [0x10, 'trans33', '33% opacity'],
  [0x20, 'trans66', '66% opacity'],
  [0x40, 'flowing', 'texture scrolls along its angle'],
  [0x80, 'nodraw', 'never drawn'],
  [0x100, 'hint', 'BSP split hint'],
  [0x200, 'skip', 'compiler ignores this face'],
];
const CONT_BITS = [
  [0x1, 'solid', 'blocks movement'],
  [0x2, 'window', 'solid but translucent'],
  [0x8, 'lava', ''], [0x10, 'slime', ''], [0x20, 'water', ''], [0x40, 'mist', 'non-solid, drawn'],
  [0x10000, 'playerclip', 'blocks players only'],
  [0x20000, 'monsterclip', 'blocks monsters only'],
  [0x1000000, 'origin', 'rotation origin brush'],
  [0x8000000, 'detail', 'detail brush — no vis splits'],
  [0x10000000, 'translucent', 'render sorted behind glass'],
  [0x20000000, 'ladder', 'climbable'],
];

function renderFlagsBox() {
  const box = $('mpFlagsBox');
  if (!M.payload || !M.sel.size) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const faces = [...M.sel].map(id => M.facesById.get(id));
  const explicit = faces.filter(f => f.ex).length;
  $('mpFlagsInfo').textContent = `${faces.length} face${faces.length === 1 ? '' : 's'} · ${explicit} with explicit numbers`;

  const stateOf = (field, bit) => {
    let on = 0;
    for (const f of faces) if (f[field] & bit) on++;
    return on === 0 ? '0' : on === faces.length ? '1' : 'm';
  };
  const buildCol = (el, groupLabel, bits, field, kind) => {
    el.textContent = '';
    const g = document.createElement('div');
    g.className = 'fgroup';
    g.textContent = groupLabel;
    el.appendChild(g);
    for (const [bit, name, hint] of bits) {
      const base = stateOf(field, bit);
      const lab = document.createElement('label');
      if (hint) lab.title = hint;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.kind = kind;
      cb.dataset.bit = bit;
      cb.dataset.base = base;
      cb.checked = base === '1';
      cb.indeterminate = base === 'm';
      lab.append(cb, document.createTextNode(name + (base === 'm' ? ' (mixed)' : '')));
      el.appendChild(lab);
    }
  };
  buildCol($('mpSurfCol'), 'surface', SURF_BITS, 'fl', 's');
  buildCol($('mpContCol'), 'contents', CONT_BITS, 'ct', 'c');
  const vals = new Set(faces.map(f => f.va));
  const vi = $('mpFlagValue');
  vi.value = vals.size === 1 ? String([...vals][0]) : '';
  vi.placeholder = vals.size === 1 ? '0' : 'mixed';
  vi.dataset.base = vals.size === 1 ? String([...vals][0]) : 'm';
  $('mpFlagsClear').disabled = !explicit;
}

function applyFlags() {
  const masks = { setSurf: 0, clearSurf: 0, setCont: 0, clearCont: 0 };
  let touched = false;
  for (const cb of $('mpFlagsBox').querySelectorAll('input[type=checkbox]')) {
    const base = cb.dataset.base;
    if (cb.indeterminate) continue;                       // mixed, untouched
    if (base !== 'm' && (base === '1') === cb.checked) continue; // unchanged
    touched = true;
    const bit = Number(cb.dataset.bit);
    const s = cb.dataset.kind === 's';
    if (cb.checked) masks[s ? 'setSurf' : 'setCont'] |= bit;
    else masks[s ? 'clearSurf' : 'clearCont'] |= bit;
  }
  const vi = $('mpFlagValue');
  const change = { ...masks };
  if (vi.value !== '' && vi.value !== vi.dataset.base) { change.value = Number(vi.value); touched = true; }
  if (!touched) { toast('no property changes to apply'); return; }
  const n = M.sel.size;
  applyEdit([...M.sel].map(id => ({ face: id, ...change })), `surface properties updated on ${n} face${n === 1 ? '' : 's'}`);
}

function clearFlags() {
  const withEx = [...M.sel].filter(id => M.facesById.get(id).ex);
  if (!withEx.length) return;
  applyEdit(withEx.map(id => ({ face: id, clearExtra: true })), `${withEx.length} face${withEx.length === 1 ? '' : 's'} back to texture defaults`);
}

function rebuildSelMesh() {
  const t = M.three;
  if (!t) return;
  if (t.selMesh) { t.scene.remove(t.selMesh); t.selMesh.geometry.dispose(); t.selMesh.material.dispose(); t.selMesh = null; }
  if (!M.sel.size) return;
  const pts = [];
  for (const id of M.sel) {
    const fi = M.faceIndex.get(id);
    if (!fi) continue;
    const src = fi.mesh.userData.srcPositions;
    const start = fi.range.triStart * 9, end = start + fi.range.triCount * 9;
    for (let i = start; i < end; i += 3) {
      const [x, y, z] = q2three(src[i], src[i + 1], src[i + 2]);
      pts.push(x, y, z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff8c1a,
    transparent: true,
    opacity: 0.4,
    side: THREE.BackSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
  });
  t.selMesh = new THREE.Mesh(g, mat);
  t.scene.add(t.selMesh);
}

function updateSelUI() {
  const bar = $('mpSel');
  if (!M.sel.size) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const texes = new Set(), brushes = new Set();
  for (const id of M.sel) {
    const f = M.facesById.get(id);
    texes.add(f.tex);
    brushes.add(f.ent + ':' + f.brush);
  }
  const texList = [...texes];
  $('mpSelInfo').textContent = `${M.sel.size} face${M.sel.size === 1 ? '' : 's'} · ${brushes.size} brush${brushes.size === 1 ? '' : 'es'} · ${texList.length === 1 ? texList[0] : texList.length + ' textures'}`;
}

// ---------- fly to entity ----------
function flyTo(ent) {
  const t = M.three;
  if (!t || !ent.origin) return;
  const [x, y, z] = q2three(...ent.origin);
  const target = new THREE.Vector3(x, y, z);
  const dir = new THREE.Vector3();
  t.camera.getWorldDirection(dir);
  t.camera.position.copy(target).addScaledVector(dir, -140).add(new THREE.Vector3(0, 60, 0));
  const look = target.clone().sub(t.camera.position);
  t.yaw = Math.atan2(-look.x, -look.z);
  t.pitch = Math.atan2(look.y, Math.hypot(look.x, look.z));
  if (t.marker) { t.scene.remove(t.marker); }
  const size = ent.brushes ? 48 : 24;
  const marker = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshBasicMaterial({ color: 0xff8c1a, wireframe: true }),
  );
  marker.position.copy(target);
  t.scene.add(marker);
  t.marker = marker;
  clearTimeout(M.entTimer);
  M.entTimer = setTimeout(() => {
    if (M.three && M.three.marker === marker) { M.three.scene.remove(marker); M.three.marker = null; }
  }, 4000);
  showEntCard(ent);
}

function showEntCard(ent) {
  const card = $('mpEntCard');
  const rows = Object.entries(ent.props)
    .map(([k, v]) => `<tr><td>${k}</td><td>${String(v).replace(/</g, '&lt;')}</td></tr>`).join('');
  card.innerHTML = `
    <h4>${ent.classname} <span class="count">· entity ${ent.idx} · line ${ent.line}</span></h4>
    <table>${rows}</table>
    <div style="margin-top:8px"><button class="small" id="mpEntCardClose">✕ close</button></div>`;
  card.dataset.mode = 'ent';
  card.classList.remove('hidden');
  $('mpEntCardClose').addEventListener('click', () => card.classList.add('hidden'));
}

// ---------- side panel ----------
function renderPanel() {
  const list = $('mpList');
  list.textContent = '';
  const q = $('mpFilter').value.trim().toLowerCase();
  if (!M.payload) return;

  {
    const selTex = new Set([...M.sel].map(id => M.facesById.get(id).tex));
    const sort = $('mpSort').value;
    const tile = Number($('mpTileSize').value) || 96;
    const terms = q.split(/\s+/).filter(Boolean);
    let items = M.payload.textures.filter(t =>
      (!terms.length || terms.every(w => t.name.toLowerCase().includes(w)))
      && (!$('mpOnlyMissing').checked || t.missing)
      && (!$('mpHideUtil').checked || (!t.utility && !t.sky)));
    if (sort === 'name' || sort === 'folder') items = [...items].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    else if (sort === 'faces') items = [...items].sort((a, b) => b.faces - a.faces || b.area - a.area);
    // 'area' keeps the payload's most-visible-first order

    const grid = document.createElement('div');
    grid.className = 'mp-texgrid';
    grid.style.setProperty('--mp-tile', tile + 'px');
    const thumbSize = tile <= 72 ? 64 : tile <= 128 ? 128 : 256;
    let lastFolder = null;
    for (const t of items) {
      if (sort === 'folder') {
        const folder = t.name.includes('/') ? t.name.slice(0, t.name.lastIndexOf('/')) : '(no folder)';
        if (folder !== lastFolder) {
          lastFolder = folder;
          const head = document.createElement('div');
          head.className = 'mp-texfold';
          const n = items.filter(x => (x.name.includes('/') ? x.name.slice(0, x.name.lastIndexOf('/')) : '(no folder)') === folder).length;
          head.innerHTML = `${folder} <span class="count">· ${n}</span>`;
          grid.appendChild(head);
        }
      }
      const cell = document.createElement('button');
      cell.className = 'mp-tile' + (selTex.has(t.name) ? ' sel' : '');
      const imgbox = document.createElement('div');
      imgbox.className = 'mp-tileimg';
      // square is guaranteed inline: an older cached style.css (Electron
      // keeps its HTTP cache across updates) must never turn tiles into
      // strips again
      imgbox.style.cssText = 'position:relative;width:100%;padding-top:100%;border-radius:4px;overflow:hidden';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
      img.src = AQTS().thumbUrl({ tex: t.name, size: thumbSize });
      imgbox.appendChild(img);
      const name = document.createElement('div');
      name.className = 'mp-tilename';
      name.textContent = t.name.includes('/') && sort === 'folder' ? t.name.slice(t.name.lastIndexOf('/') + 1) : t.name;
      const meta = document.createElement('div');
      meta.className = 'mp-tilemeta';
      const bits = [];
      if (t.areaPct) bits.push(t.areaPct + '%');
      bits.push(t.faces + 'f');
      if (t.w) bits.push(`${t.w}×${t.h}`);
      if (t.utility) bits.push('util');
      if (t.sky) bits.push('sky');
      meta.textContent = bits.join(' · ');
      const painting = M.sel.size > 0;
      cell.title = `${t.name}\n${t.faces} faces · ${t.brushes} brushes${t.areaPct ? ` · ${t.areaPct}% of the visible map` : ''}${t.w ? `\n${t.w}×${t.h}` : ''}${t.missing ? '\nNOT FOUND in the install' : ''}\n${painting ? '🎨 click = PAINT the selection with this texture · Ctrl+click = add its faces to the selection' : 'click = select its faces · Ctrl+click = add'}`;
      cell.append(imgbox, name, meta);
      if (t.missing) {
        const b = document.createElement('span');
        b.className = 'mp-tilemiss';
        b.textContent = 'missing';
        cell.appendChild(b);
      }
      cell.addEventListener('click', e => {
        // TrenchBroom behavior: with faces selected, clicking a texture in
        // the browser paints them; Ctrl+click keeps selecting instead
        if (e.ctrlKey) selectTexture(t.name, true);
        else if (M.sel.size) paintSelection(t.name);
        else selectTexture(t.name, false);
      });
      grid.appendChild(cell);
    }
    list.appendChild(grid);
    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'count';
      d.style.padding = '12px';
      d.textContent = 'no textures match';
      list.appendChild(d);
    }
  }
}

// ---------- retexture ----------
async function ensureCatalog() {
  if (M.catalog && M.catalogDir === AQTS().state.dir) return M.catalog;
  M.catalog = (await api('/api/textures')).textures;
  M.catalogDir = AQTS().state.dir;
  return M.catalog;
}

async function openRetexture() {
  if (!M.sel.size) return;
  let catalog;
  try { catalog = await ensureCatalog(); } catch (e) { toast(e.message, true); return; }
  const texes = new Set([...M.sel].map(id => M.facesById.get(id).tex));
  openModal(`
    <div class="mhead"><h3>Retexture ${M.sel.size} face${M.sel.size === 1 ? '' : 's'} <span class="count">(${[...texes].slice(0, 3).join(', ')}${texes.size > 3 ? '…' : ''})</span></h3><button class="mclose">✕</button></div>
    <div class="tabs" style="padding:8px 16px 0"><input id="mpPickSearch" type="search" placeholder="Search the install's textures…" style="flex:1"></div>
    <div class="mbody"><div id="mpPickGrid" class="mp-pickgrid"></div></div>
    <div class="mfoot">
      <span class="count" id="mpPickInfo"></span>
      <span>
        <button class="primary hidden" id="mpPickApply"></button>
      </span>
    </div>
  `);
  let picked = null;
  const grid = $('mpPickGrid');
  const renderGrid = () => {
    const q = $('mpPickSearch').value.trim().toLowerCase();
    const items = catalog.filter(t => !q || t.name.includes(q)).slice(0, 240);
    grid.textContent = '';
    for (const t of items) {
      const cell = document.createElement('div');
      cell.className = 'mp-pick';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = AQTS().thumbUrl({ tex: t.name, size: 96 });
      const span = document.createElement('span');
      span.textContent = t.name;
      span.title = t.name;
      cell.append(img, span);
      cell.addEventListener('click', () => {
        picked = t.name;
        grid.querySelectorAll('.mp-pick').forEach(c => c.style.borderColor = '');
        cell.style.borderColor = 'var(--accent)';
        const btn = $('mpPickApply');
        btn.classList.remove('hidden');
        btn.textContent = `Apply ${t.name} to ${M.sel.size} face${M.sel.size === 1 ? '' : 's'}`;
      });
      grid.appendChild(cell);
    }
    $('mpPickInfo').textContent = `${items.length} shown${catalog.length > items.length ? ' — type to narrow (' + catalog.length + ' in the install)' : ''} · keep size: ${$('mpKeepSize').checked ? 'on' : 'off'}`;
  };
  $('mpPickSearch').addEventListener('input', renderGrid);
  $('mpPickSearch').focus();
  $('mpPickApply').addEventListener('click', () => {
    if (!picked) return;
    const n = M.sel.size;
    closeModal();
    applyEdit([...M.sel].map(id => ({ face: id, to: picked })), `${n} face${n === 1 ? '' : 's'} → ${picked}`);
  });
  renderGrid();
}

// ---------- wiring ----------
function bind() {
  $('sideTabMapper').addEventListener('click', openTab);
  $('sideTabMaps').addEventListener('click', () => { if (M.open) closeTab(); });
  $('mpClose').addEventListener('click', closeTab);
  $('mpOpenBtn').addEventListener('click', () => openBrowse());
  $('mpOpenBtn2').addEventListener('click', () => openBrowse());
  $('mpNotes').addEventListener('click', showNotes);
  $('mpFilter').addEventListener('input', renderPanel);
  $('mpSelClear').addEventListener('click', clearSel);
  $('mpSelBrush').addEventListener('click', growBrush);
  $('mpSelTex').addEventListener('click', growTexture);
  $('mpRetex').addEventListener('click', openRetexture);
  $('mpUndo').addEventListener('click', () => doUndoRedo(false));
  $('mpRedo').addEventListener('click', () => doUndoRedo(true));
  $('mpFlagsApply').addEventListener('click', applyFlags);
  $('mpFlagsClear').addEventListener('click', clearFlags);
  $('mpLights').addEventListener('change', () => { if (M.three) buildLights(); });
  $('mpLinks').addEventListener('change', () => { if (M.three) buildLinks(); });
  $('mpUtility').addEventListener('change', () => {
    if (!M.three) return;
    for (const m of M.three.meshes) m.visible = !m.userData.utility || $('mpUtility').checked;
  });
  $('mpKeepSize').checked = localStorage.getItem('aq2ts.mpKeepSize') !== '0';
  $('mpKeepSize').addEventListener('change', () => localStorage.setItem('aq2ts.mpKeepSize', $('mpKeepSize').checked ? '1' : '0'));

  // texture-grid controls, persisted
  const persist = (id, key, def) => {
    const el = $(id);
    const saved = localStorage.getItem(key);
    if (el.type === 'checkbox') {
      el.checked = saved === '1';
      el.addEventListener('change', () => { localStorage.setItem(key, el.checked ? '1' : '0'); renderPanel(); });
    } else {
      if (saved !== null && [...el.options].some(o => o.value === saved)) el.value = saved;
      else if (def) el.value = def;
      el.addEventListener('change', () => { localStorage.setItem(key, el.value); renderPanel(); });
    }
  };
  persist('mpSort', 'aq2ts.mpSort', 'area');
  persist('mpTileSize', 'aq2ts.mpTile', '96');
  persist('mpOnlyMissing', 'aq2ts.mpOnlyMiss');
  persist('mpHideUtil', 'aq2ts.mpHideUtil');

  // draggable divider: panel width vs 3D view, persisted
  const side = $('mpSide');
  // a hidden window reports innerWidth 0 (background loads) - never let
  // that collapse the width clamp
  const maxW = () => Math.max(360, window.innerWidth * 0.7 || 9999);
  const savedW = Number(localStorage.getItem('aq2ts.mpPanelW'));
  if (savedW >= 240) side.style.width = Math.min(savedW, maxW()) + 'px';
  const divider = $('mpDivider');
  divider.addEventListener('mousedown', e => {
    e.preventDefault();
    divider.classList.add('dragging');
    const startX = e.clientX;
    const startW = side.getBoundingClientRect().width;
    let raf = 0;
    const onMove = ev => {
      const w = Math.max(240, Math.min(maxW(), startW + (ev.clientX - startX)));
      side.style.width = w + 'px';
      // the canvas resize is the heavy part; batch it per frame
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (M.three) M.three.onResize();
        });
      }
    };
    const onUp = () => {
      divider.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      localStorage.setItem('aq2ts.mpPanelW', String(Math.round(side.getBoundingClientRect().width)));
      if (M.three) M.three.onResize();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

bind();
window.AQMapper = { open: openTab, close: closeTab, loadMap };
