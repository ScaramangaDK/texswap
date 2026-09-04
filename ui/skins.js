// Skin studio: weapon model skins and replacement models, previewed live on
// the real md2 in three.js. Talks to main.js through window.AQTS.
import * as THREE from '/vendor/three.module.js';
import { MATERIALS, PATTERNS, DEFAULT_PARAMS, restyle, isIdentity } from './restyle.js';

const $ = id => document.getElementById(id);
const AQTS = () => window.AQTS;

// Quake (x forward, y left, z up) -> three (x, y up, z toward viewer)
const q2three = (x, y, z) => [x, z, -y];

let S = null; // open session

function api(pathname, params = {}) {
  const url = new URL(pathname, location.origin);
  url.searchParams.set('dir', AQTS().state.dir);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url).then(async r => {
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  });
}

function imageUrl(name, { which = 'current', uv = false, size = 2048 } = {}) {
  const url = new URL('/api/skins/image', location.origin);
  url.searchParams.set('dir', AQTS().state.dir);
  url.searchParams.set('name', name);
  url.searchParams.set('which', which);
  if (uv) url.searchParams.set('uv', '1');
  url.searchParams.set('size', size);
  url.searchParams.set('v', S ? S.version : 0);
  return url.toString();
}

function libThumbUrl(id) {
  const url = new URL('/api/library/thumb', location.origin);
  url.searchParams.set('dir', AQTS().state.dir);
  url.searchParams.set('id', id);
  url.searchParams.set('size', 256);
  return url.toString();
}

async function fileToB64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64ToFloat32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- open / close ----------

async function open() {
  if (S) { await refresh(); return; }
  const overlay = $('skinOverlay');
  overlay.classList.remove('hidden');
  S = {
    weapons: [], tool: null, enabled: true, sel: null, version: Date.now(),
    model: null, frames: null, frame: 0, mode: localStorage.getItem('aq2ts.skmode') || 'game',
    orbit: { yaw: 0.6, pitch: 0.25, dist: 1 }, rs: null, busy: false, srcImage: null, collection: [],
  };
  setupThree();
  bindUi();
  await refresh();
  // remember the last weapon, else the first view model
  const last = localStorage.getItem('aq2ts.skweapon');
  const first = S.weapons.find(w => w.name === last) || S.weapons.find(w => w.kind === 'view') || S.weapons[0];
  if (first) await selectWeapon(first.name);
}

function close() {
  if (!S) return;
  cancelAnimationFrame(S.raf);
  if (S.ro) S.ro.disconnect();
  if (S.imgRo) S.imgRo.disconnect();
  if (S.renderer) S.renderer.dispose();
  disposeModel();
  document.removeEventListener('keydown', S.onKey);
  $('skinOverlay').classList.add('hidden');
  S = null;
}

async function refresh() {
  if (!S) return;
  try {
    const r = await api('/api/skins');
    S.weapons = r.weapons;
    S.tool = r.tool;
    S.enabled = r.enabled;
    S.version = Date.now(); // image URLs carry this: never show a cached skin after a change
    AQTS().skinsChanged({ enabled: r.enabled, active: r.active });
  } catch (e) {
    AQTS().toast('Skin studio: ' + e.message, true);
    return;
  }
  renderList();
  renderEnabled();
  if (S.sel) { renderSide(); renderCollection(); }
}

function renderEnabled() {
  const b = $('skEnabled');
  b.textContent = S.enabled ? 'Skins: ON' : 'Skins: OFF';
  b.className = S.enabled ? '' : 'off';
  const active = S.weapons.filter(w => w.skin || w.model).length;
  $('skStatus').textContent = active
    ? `${active} custom weapon${active === 1 ? '' : 's'} · applied in game at startup and on every map`
    : 'pick a weapon, then pick a skin from the collection, restyle it, or upload your own';
}

// ---------- weapon list ----------

function renderList() {
  const list = $('skList');
  list.textContent = '';
  let lastKind = null;
  const heads = { view: 'In your hands', world: 'On the ground', other: 'Other' };
  for (const w of S.weapons) {
    if (w.kind !== lastKind) {
      const h = document.createElement('div');
      h.className = 'rphead sk-kind';
      h.textContent = heads[w.kind] || w.kind;
      list.appendChild(h);
      lastKind = w.kind;
    }
    const card = document.createElement('button');
    card.className = 'sk-card' + (S.sel === w.name ? ' sel' : '') + (w.skin || w.model ? ' custom' : '');
    card.title = `${w.dir} · ${w.source || ''}`;
    const img = document.createElement('img');
    img.src = imageUrl(w.name, { size: 256 });
    img.alt = '';
    const txt = document.createElement('span');
    txt.className = 'sk-cardtxt';
    const tags = [];
    if (w.model) tags.push('model');
    if (w.skin) tags.push('skin');
    txt.innerHTML = `<b>${esc(w.label)}</b><small>${esc(w.name)}${tags.length ? ' · <em>' + tags.join(' + ') + '</em>' : ''}</small>`;
    card.append(img, txt);
    card.addEventListener('click', () => selectWeapon(w.name));
    list.appendChild(card);
  }
}

// ---------- selection ----------

async function selectWeapon(name) {
  if (!S) return;
  if (S.rs) exitRestyle(false);
  S.sel = name;
  localStorage.setItem('aq2ts.skweapon', name);
  renderList();
  renderSide();
  renderCollection();
  await loadModel();
  updateImage();
}

function current() {
  return S.weapons.find(w => w.name === S.sel) || null;
}

function renderSide() {
  const w = current();
  const info = $('skInfo');
  if (!w) { info.textContent = ''; return; }
  const m = w.model || w.stock || {};
  const skinTxt = w.skin
    ? `${w.skin.w}×${w.skin.h} custom${w.skin.label ? ' · ' + esc(w.skin.label) : ''}`
    : w.stockSkin ? `${w.stockSkin.w}×${w.stockSkin.h} ${w.stockSkin.ext.slice(1)} (stock)` : 'no skin image found';
  info.innerHTML = `
    <div class="sk-infoname">${esc(w.label)}</div>
    <div class="sk-inforow"><span>model</span><span class="mono">${w.model ? 'custom' + (w.model.label ? ' · ' + esc(w.model.label) : '') : 'stock'}</span></div>
    <div class="sk-inforow"><span>frames</span><span class="mono">${m.frames || '?'}${w.model && w.stock ? ' <small>(stock ' + w.stock.frames + ')</small>' : ''}</span></div>
    <div class="sk-inforow"><span>layout</span><span class="mono">${m.skinW || '?'}×${m.skinH || '?'}</span></div>
    <div class="sk-inforow"><span>skin</span><span class="mono">${skinTxt}</span></div>
    ${w.error ? `<div class="sk-err">${esc(w.error)}</div>` : ''}
  `;
  $('skUndo').classList.toggle('hidden', !w.canUndo);
  $('skResetSkin').classList.toggle('hidden', !w.skin);
  $('skResetSkin').textContent = w.model ? 'Back to install skin (wrong for this model)' : 'Back to stock skin';
  $('skResetModel').classList.toggle('hidden', !w.model);
  $('skExport').disabled = !(w.skin || w.model);
  $('skColSave').disabled = !(w.skin || w.model);
  $('skUpscale').disabled = !(w.skin || w.stockSkin);
  $('skRestyle').disabled = !(w.skin || w.stockSkin);
}

function updateImage() {
  const w = current();
  if (!w) return;
  const stock = $('skStock').checked;
  const uv = $('skUv').checked;
  const img = $('skImg');
  if (S.rs && !stock) {
    // restyle mode: the 2D view shows the live preview (UV overlay pauses)
    if (S.rsPreview) img.src = S.rsPreview.toDataURL();
  } else {
    img.src = imageUrl(w.name, { which: stock ? 'stock' : 'current', uv });
  }
  const d = stock ? w.stockSkin : (w.skin || w.stockSkin);
  $('skImgInfo').textContent = d ? `${d.w}×${d.h}${stock ? ' · stock' : ''}` : '';
}

// ---------- collection ----------

async function renderCollection() {
  const w = current();
  const box = $('skCollection');
  if (!w) { box.textContent = ''; return; }
  let entries = [];
  try { entries = (await api('/api/library', { weapon: w.name })).entries; } catch (e) { AQTS().toast(e.message, true); }
  if (!S || S.sel !== w.name) return;
  S.collection = entries;
  $('skColCount').textContent = entries.length ? String(entries.length) : '';
  box.textContent = '';
  if (!entries.length) {
    const e = document.createElement('div');
    e.className = 'sk-col empty';
    e.textContent = 'no saved skins for this weapon yet';
    box.appendChild(e);
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'sk-col';
    row.title = `${e.source === 'bundled' ? 'ships with TexSwap' : 'your collection'}${e.author ? ' · by ' + e.author : ''}${e.model ? ' · includes a model' : ''} - click to use`;
    const img = document.createElement('img');
    img.src = libThumbUrl(e.id);
    img.alt = '';
    const txt = document.createElement('span');
    txt.className = 'sk-coltxt';
    txt.innerHTML = `<b>${esc(e.name)}</b><small>${e.source === 'bundled' ? 'built-in' : 'mine'}${e.skin ? ` · ${e.skin.w}×${e.skin.h}` : ''}${e.model ? ' · model' : ''}</small>`;
    row.append(img, txt);
    if (e.source === 'mine') {
      const del = document.createElement('button');
      del.className = 'sk-coldel';
      del.textContent = '✕';
      del.title = 'Remove from your collection (does not change the active skin)';
      del.addEventListener('click', async ev => {
        ev.stopPropagation();
        try { await AQTS().apiPost('/api/library/delete', { id: e.id }); renderCollection(); }
        catch (err) { AQTS().toast(err.message, true); }
      });
      row.appendChild(del);
    }
    row.addEventListener('click', () => simplePost('/api/library/apply', { id: e.id }, `"${e.name}" is now on ${w.label}${e.model ? ' - restart the map in game' : ' - press F9 in game'}`, Boolean(e.model)));
    box.appendChild(row);
  }
}

function openSaveToCollection() {
  const w = current();
  if (!w) return;
  const T = AQTS();
  T.openModal(`
    <div class="mhead"><h3>★ Save to collection <span class="mono">${esc(w.label)}</span></h3><button class="mclose">✕</button></div>
    <div class="mbody">
      <p class="mnote">Keeps the current skin${w.model ? ' and model' : ''} in your collection so you can switch back to it any time. The same file is what friends import.</p>
      <div class="flatrow"><input id="colName" type="text" maxlength="40" placeholder="Name, e.g. Gold AK" value="${esc(w.skin && w.skin.label ? w.skin.label : '')}" style="flex:1"></div>
      <div class="flatrow"><input id="colAuthor" type="text" maxlength="40" placeholder="Your name (optional)" value="${esc(localStorage.getItem('aq2ts.skauthor') || '')}" style="flex:1"></div>
    </div>
    <div class="mfoot"><button class="primary" id="colGo">Save</button></div>`);
  $('colName').focus();
  const go = async () => {
    const title = $('colName').value.trim();
    if (!title) { $('colName').focus(); return; }
    const author = $('colAuthor').value.trim();
    localStorage.setItem('aq2ts.skauthor', author);
    try {
      const r = await T.apiPost('/api/library/save', { name: w.name, title, author });
      T.closeModal();
      T.toast(`Saved "${r.name}" to your collection`);
      renderCollection();
    } catch (e) { T.toast('Save failed: ' + e.message, true); }
  };
  $('colGo').addEventListener('click', go);
  $('colName').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

// ---------- three.js ----------

function setupThree() {
  const canvas = $('skCanvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141a);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(-40, 60, 50);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(90, 1, 0.5, 5000);
  camera.up.set(0, 1, 0);
  S.renderer = renderer; S.scene = scene; S.camera = camera;
  S.maxAniso = renderer.capabilities.getMaxAnisotropy();

  const box = canvas.parentElement;
  const resize = () => {
    const w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  S.ro = new ResizeObserver(resize);
  S.ro.observe(box);
  resize();

  // orbit: drag = turn, wheel = zoom (only in orbit mode)
  let drag = null;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag || S.mode !== 'orbit') return;
    S.orbit.yaw -= (e.clientX - drag.x) * 0.008;
    S.orbit.pitch = Math.max(-1.4, Math.min(1.4, S.orbit.pitch + (e.clientY - drag.y) * 0.008));
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', e => {
    if (S.mode !== 'orbit') return;
    e.preventDefault();
    S.orbit.dist = Math.max(0.3, Math.min(4, S.orbit.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
  }, { passive: false });

  let last = 0;
  const step = t => {
    if (!S) return;
    S.raf = requestAnimationFrame(step);
    if (S.model && $('skAnim').checked && t - last > 100) { // Q2 animates at 10 Hz
      last = t;
      setFrame((S.frame + 1) % S.model.nFrames);
    }
    placeCamera();
    renderer.render(scene, camera);
  };
  S.raf = requestAnimationFrame(step);
}

function placeCamera() {
  const cam = S.camera;
  if (!S.model) return;
  if (S.mode === 'game') {
    // the player's eye is the model's origin, looking down +x
    cam.position.set(0, 0, 0);
    cam.lookAt(1, 0, 0);
    cam.fov = 90;
  } else {
    const c = S.center, r = S.radius * 2.2 * S.orbit.dist;
    const { yaw, pitch } = S.orbit;
    cam.position.set(
      c.x + r * Math.cos(pitch) * Math.cos(yaw),
      c.y + r * Math.sin(pitch),
      c.z + r * Math.cos(pitch) * Math.sin(yaw));
    cam.lookAt(c);
    cam.fov = 50;
  }
  cam.updateProjectionMatrix();
}

function disposeModel() {
  if (S && S.mesh) {
    S.scene.remove(S.mesh);
    S.mesh.geometry.dispose();
    if (S.mesh.material.map) S.mesh.material.map.dispose();
    S.mesh.material.dispose();
    S.mesh = null;
  }
}

async function loadModel() {
  const name = S.sel;
  $('skHint').textContent = 'loading model…';
  let m;
  try {
    m = await api('/api/skins/model', { name });
  } catch (e) {
    $('skHint').textContent = 'model failed: ' + e.message;
    disposeModel();
    S.model = null;
    return;
  }
  if (!S || S.sel !== name) return;
  disposeModel();
  S.model = m;
  S.frames = b64ToFloat32(m.framesB64);
  const n = m.nTris * 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const uv = new Float32Array(n * 2);
  for (let t = 0; t < m.nTris; t++) {
    for (let k = 0; k < 3; k++) {
      const st = m.tris[t * 6 + 3 + k];
      uv[(t * 3 + k) * 2] = m.uvs[st * 2];
      uv[(t * 3 + k) * 2 + 1] = m.uvs[st * 2 + 1];
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  S.mesh = new THREE.Mesh(geo, mat);
  S.scene.add(S.mesh);
  // framing for orbit mode: first frame's bounds
  const b = m.bounds;
  const lo = q2three(b.min[0], b.min[1], b.min[2]), hi = q2three(b.max[0], b.max[1], b.max[2]);
  S.center = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
  S.radius = Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
  $('skFrame').max = m.nFrames - 1;
  setFrame(0);
  $('skHint').textContent = `${m.nTris} triangles · ${m.nFrames} frames${m.totalFrames > m.nFrames ? ' (of ' + m.totalFrames + ')' : ''} · skin layout ${m.skinW}×${m.skinH}`;
  await loadTexture();
}

function setFrame(f) {
  const m = S.model;
  if (!m || !S.mesh) return;
  S.frame = f;
  const pos = S.mesh.geometry.attributes.position.array;
  const base = f * m.nVerts * 3;
  const fr = S.frames;
  for (let t = 0; t < m.nTris; t++) {
    for (let k = 0; k < 3; k++) {
      const v = m.tris[t * 6 + k] * 3 + base;
      const o = (t * 3 + k) * 3;
      pos[o] = fr[v];
      pos[o + 1] = fr[v + 2];
      pos[o + 2] = -fr[v + 1];
    }
  }
  S.mesh.geometry.attributes.position.needsUpdate = true;
  S.mesh.geometry.computeVertexNormals();
  $('skFrame').value = f;
  $('skFrameLbl').textContent = `${f}${m.frameNames[f] ? ' ' + m.frameNames[f] : ''}`;
}

// The 3D texture always comes through a canvas so restyles can be previewed
// live (and baked exactly as previewed).
function loadTexture() {
  return new Promise(resolve => {
    const w = current();
    if (!w) return resolve();
    const img = new Image();
    img.onload = () => {
      if (!S || S.sel !== w.name || !S.mesh) return resolve();
      S.srcImage = img;
      applyTexture();
      resolve();
    };
    img.onerror = () => { $('skHint').textContent += ' · no skin image'; resolve(); };
    // full resolution: restyles are baked from this very image
    img.src = imageUrl(w.name, { size: 4096 });
  });
}

function textureCanvas(maxWidth) {
  if (S.rs && !isIdentity(S.rs) || (S.rs && S.rs.protect.length)) return restyle(S.srcImage, S.rs, maxWidth);
  const c = document.createElement('canvas');
  c.width = S.srcImage.naturalWidth;
  c.height = S.srcImage.naturalHeight;
  c.getContext('2d').drawImage(S.srcImage, 0, 0);
  return c;
}

function applyTexture() {
  if (!S.srcImage || !S.mesh) return;
  const canvas = textureCanvas(S.rs ? 1024 : 0);
  if (S.rs) S.rsPreview = canvas;
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false; // md2 v runs top-down like the image
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = S.maxAniso;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const old = S.mesh.material.map;
  S.mesh.material.map = tex;
  S.mesh.material.needsUpdate = true;
  if (old) old.dispose();
}

// ---------- restyle mode ----------

function enterRestyle() {
  const w = current();
  if (!w || !S.srcImage) return;
  S.rs = { ...DEFAULT_PARAMS, protect: [] };
  $('skSide').classList.add('hidden');
  $('skRestylePanel').classList.remove('hidden');
  $('skUv').checked = false;
  $('skUv').disabled = true;
  $('skStock').checked = false;
  $('skProtect').classList.remove('hidden');
  buildRestyleControls();
  syncProtectCanvas();
  scheduleRestyle(true);
}

function exitRestyle(restore = true) {
  S.rs = null;
  S.rsPreview = null;
  $('skSide').classList.remove('hidden');
  $('skRestylePanel').classList.add('hidden');
  $('skUv').disabled = false;
  $('skProtect').classList.add('hidden');
  if (restore && S.srcImage && S.mesh) { applyTexture(); updateImage(); }
}

function buildRestyleControls() {
  const sw = $('rsMaterials');
  sw.textContent = '';
  for (const m of MATERIALS) {
    const b = document.createElement('div');
    b.className = 'sk-swatch' + (S.rs.material === m.id ? ' sel' : '');
    b.title = m.label;
    b.style.background = m.stops
      ? `linear-gradient(135deg, ${m.stops.map(([t, c]) => `${c} ${Math.round(t * 100)}%`).join(', ')})`
      : 'var(--checker)';
    b.innerHTML = `<span>${esc(m.label)}</span>`;
    b.addEventListener('click', () => {
      S.rs.material = m.id;
      sw.querySelectorAll('.sk-swatch').forEach(x => x.classList.toggle('sel', x === b));
      scheduleRestyle();
    });
    sw.appendChild(b);
  }
  const sel = $('rsPattern');
  sel.innerHTML = PATTERNS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  sel.value = S.rs.pattern;
  sel.onchange = () => { S.rs.pattern = sel.value; scheduleRestyle(); };
  const sliders = {
    strength: [v => v / 100, v => v + '%'],
    patternScale: [v => v / 100, v => (v / 100).toFixed(1) + 'x'],
    patternOpacity: [v => v / 100, v => v + '%'],
    hue: [v => v, v => v + '°'],
    sat: [v => v, v => v + '%'],
    bright: [v => v, v => v + '%'],
    contrast: [v => v, v => v + '%'],
  };
  const fromParam = { strength: v => v * 100, patternScale: v => v * 100, patternOpacity: v => v * 100 };
  for (const [k, [toParam, fmt]] of Object.entries(sliders)) {
    const el = $('rs_' + k);
    el.value = (fromParam[k] || (v => v))(S.rs[k]);
    $('rsv_' + k).textContent = fmt(Number(el.value));
    el.oninput = () => {
      S.rs[k] = toParam(Number(el.value));
      $('rsv_' + k).textContent = fmt(Number(el.value));
      scheduleRestyle();
    };
  }
  renderProtectInfo();
}

let rsTimer = 0;
function scheduleRestyle(now = false) {
  clearTimeout(rsTimer);
  rsTimer = setTimeout(() => {
    if (!S || !S.rs) return;
    applyTexture();
    updateImage();
    drawProtect();
  }, now ? 0 : 60);
}

function renderProtectInfo() {
  const n = S.rs ? S.rs.protect.length : 0;
  $('rsProtectInfo').textContent = n ? `${n} protected box${n === 1 ? '' : 'es'}` : 'no protected areas';
}

// protect boxes live on a canvas exactly over the skin <img>
function syncProtectCanvas() {
  const img = $('skImg'), cv = $('skProtect');
  const r = img.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width));
  cv.height = Math.max(1, Math.round(r.height));
  cv.style.width = r.width + 'px';
  cv.style.height = r.height + 'px';
  drawProtect();
}

function drawProtect() {
  const cv = $('skProtect');
  if (!S || !S.rs || cv.classList.contains('hidden')) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const boxes = [...S.rs.protect, ...(S.dragBox ? [S.dragBox] : [])];
  for (const b of boxes) {
    const x = b.x * cv.width, y = b.y * cv.height, w = b.w * cv.width, h = b.h * cv.height;
    ctx.fillStyle = 'rgba(85, 217, 138, 0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(85, 217, 138, 0.95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
  if (!boxes.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '12px sans-serif';
    ctx.fillText('drag a box here to protect an area (e.g. the hands)', 8, cv.height - 8);
  }
}

function bindProtect() {
  const cv = $('skProtect');
  let start = null;
  const norm = e => {
    const r = cv.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  cv.addEventListener('pointerdown', e => {
    if (!S || !S.rs) return;
    start = norm(e);
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!start || !S || !S.rs) return;
    const p = norm(e);
    S.dragBox = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    drawProtect();
  });
  cv.addEventListener('pointerup', e => {
    if (!start || !S || !S.rs) return;
    const p = norm(e);
    const box = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    start = null;
    S.dragBox = null;
    if (box.w < 0.01 || box.h < 0.01) {
      // a click: remove the box under the pointer
      const i = S.rs.protect.findIndex(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
      if (i >= 0) S.rs.protect.splice(i, 1);
    } else {
      S.rs.protect.push(box);
    }
    renderProtectInfo();
    scheduleRestyle(true);
  });
  S.imgRo = new ResizeObserver(() => { if (S && S.rs) syncProtectCanvas(); });
  S.imgRo.observe($('skImg'));
  $('skImg').addEventListener('load', () => { if (S && S.rs) syncProtectCanvas(); });
}

async function applyRestyle() {
  const w = current();
  if (!w || !S.rs || !S.srcImage) return;
  if (isIdentity(S.rs)) { AQTS().toast('Nothing changed yet - pick a material, pattern or color first'); return; }
  busy(true, 'Baking the new skin…');
  try {
    const params = S.rs;
    const full = restyle(S.srcImage, params, 0);
    const blob = await new Promise(r => full.toBlob(r, 'image/png'));
    const mat = MATERIALS.find(m => m.id === params.material);
    const pat = PATTERNS.find(p => p.id === params.pattern);
    const parts = [];
    if (mat && mat.stops) parts.push(mat.label);
    if (pat && pat.id !== 'none') parts.push(pat.label);
    const label = parts.join(' + ') || 'recolored';
    exitRestyle(false);
    await upload(new File([blob], `${w.name}-${label.replace(/\W+/g, '_').toLowerCase()}.png`, { type: 'image/png' }), 'skin', label);
  } finally {
    busy(false);
  }
}

// ---------- actions ----------

function busy(on, msg = '') {
  S.busy = on;
  $('skinOverlay').classList.toggle('busy', on);
  if (msg) AQTS().toast(msg);
}

async function afterChange(r, msg) {
  for (const w of (r.warnings || []).slice(0, 5)) AQTS().toast(w, true);
  S.version = Date.now();
  if (r.weapons) S.weapons = r.weapons;
  AQTS().skinsChanged({ enabled: S.enabled, active: S.weapons.filter(w => w.skin || w.model).length });
  renderList();
  renderSide();
  renderEnabled();
  renderCollection();
  if (msg) AQTS().toast(msg);
}

async function upload(file, kind, label = '') {
  const w = current();
  if (!w || !file) return;
  busy(true, kind === 'model' ? 'Checking model…' : 'Uploading skin…');
  try {
    const r = await AQTS().apiPost('/api/skins/upload', {
      name: w.name, filename: file.name, dataB64: await fileToB64(file),
      label: label || file.name.replace(/\.[^.]+$/, '').slice(0, 40),
    });
    await afterChange(r, kind === 'model'
      ? `Model swapped on ${w.label} - restart the map in game to see it`
      : `Skin applied to ${w.label} - press F9 in game (or restart the map)`);
    if (kind === 'model') await loadModel();
    else await loadTexture();
    updateImage();
  } catch (e) {
    AQTS().toast((kind === 'model' ? 'Model rejected: ' : 'Skin rejected: ') + e.message, true);
  } finally {
    busy(false);
  }
}

async function simplePost(pathname, body, msg, reloadModel = false) {
  const w = current();
  if (!w) return;
  if (S.rs) exitRestyle(false);
  busy(true);
  try {
    const r = await AQTS().apiPost(pathname, { name: w.name, ...body });
    await afterChange(r, msg);
    if (reloadModel) await loadModel();
    else await loadTexture();
    updateImage();
  } catch (e) {
    AQTS().toast('Failed: ' + e.message, true);
  } finally {
    busy(false);
  }
}

function openUpscale() {
  const w = current();
  if (!w) return;
  const T = AQTS();
  const render = async () => {
    let tool = S.tool;
    try { tool = (await api('/api/tools/status')).tool; S.tool = tool; } catch { /* keep last */ }
    const d = w.skin || w.stockSkin || { w: 0, h: 0 };
    // the game refuses textures over 4096px a side: offer the biggest scale that fits
    const best = [4, 3, 2].find(s => Math.max(d.w, d.h) * s <= 4096) || 0;
    const body = tool.installed ? `
      <p class="mnote">Real-ESRGAN redraws the skin at a higher resolution with real detail instead of blur.
        Runs on your GPU; a weapon skin takes 5-60 seconds.</p>
      <div class="flatrow"><span class="count">Scale:</span>
        ${[2, 3, 4].map(s => {
          const ok = Math.max(d.w, d.h) * s <= 4096;
          const dis = ok ? '' : 'disabled title="over the game limit of 4096px per side"';
          return `<button class="scbtn${ok && s === best ? ' sel' : ''}" data-sc="${s}" ${dis}>${s}x → ${d.w * s}×${d.h * s}</button>`;
        }).join('')}
        ${best ? '' : '<span class="count">already at the game limit (4096px per side)</span>'}</div>
      <div class="flatrow"><span class="count">Look:</span>
        <button class="scbtn sel" data-md="detail" title="realesrgan-x4plus - best for realistic metal, wood, cloth">detailed</button>
        <button class="scbtn" data-md="smooth" title="realesr-animevideov3 - flatter, cleaner edges; good for cartoon-style art">smooth</button></div>
      <p class="mnote" id="upNote"></p>`
      : tool.installing ? `
      <p class="mnote">Downloading the upscaler… ${esc(tool.phase)}</p>
      <div class="sk-bar"><div id="upBar" style="width:${tool.progress.total ? Math.round(tool.progress.done / tool.progress.total * 100) : 0}%"></div></div>`
      : `
      <p class="mnote">The AI upscaler (<b>Real-ESRGAN</b>, open source) is not on this PC yet. TexSwap can fetch it from the project's
        official GitHub release: a ${tool.downloadMB} MB download, stored in your AppData folder, no installer.</p>
      ${tool.error ? `<p class="sk-err">Last attempt failed: ${esc(tool.error)}</p>` : ''}
      <p class="mnote mono" style="font-size:11px;word-break:break-all">${esc(tool.source)}</p>`;
    T.openModal(`
      <div class="mhead"><h3>✨ AI upscale <span class="mono">${esc(w.label)}</span></h3><button class="mclose">✕</button></div>
      <div class="mbody">${body}</div>
      <div class="mfoot">
        ${tool.installed ? '<button class="primary" id="upGo">Upscale now</button>'
          : tool.installing ? '' : '<button class="primary" id="upInstall">Download upscaler</button>'}
      </div>`);
    if (tool.installed) {
      let scale = best || 2, model = 'detail';
      if (!best) $('upGo').disabled = true;
      const mb = $('modal');
      mb.querySelectorAll('.scbtn[data-sc]').forEach(b => b.addEventListener('click', () => {
        scale = Number(b.dataset.sc);
        mb.querySelectorAll('.scbtn[data-sc]').forEach(x => x.classList.toggle('sel', x === b));
      }));
      mb.querySelectorAll('.scbtn[data-md]').forEach(b => b.addEventListener('click', () => {
        model = b.dataset.md;
        mb.querySelectorAll('.scbtn[data-md]').forEach(x => x.classList.toggle('sel', x === b));
      }));
      $('upGo').addEventListener('click', async () => {
        $('upGo').disabled = true;
        $('upGo').textContent = 'Working…';
        $('upNote').textContent = 'The GPU is rendering the new skin. You can keep browsing the app.';
        try {
          const r = await T.apiPost('/api/skins/upscale', { name: w.name, scale, model });
          T.closeModal();
          await afterChange(r, `Upscaled ${scale}x - press F9 in game (or restart the map)`);
          await loadTexture();
          updateImage();
        } catch (e) {
          T.closeModal();
          T.toast('Upscale failed: ' + e.message, true);
        }
      });
    } else if (tool.installing) {
      setTimeout(() => { if ($('upBar')) render(); }, 700);
    } else {
      $('upInstall').addEventListener('click', async () => {
        try { await T.apiPost('/api/tools/install', {}); } catch (e) { T.toast(e.message, true); return; }
        render();
      });
    }
  };
  render();
}

function bindUi() {
  $('skClose').addEventListener('click', close);
  S.onKey = e => {
    if (e.key === 'Escape' && !$('modalOverlay').classList.contains('hidden')) return; // modal closes itself
    if (e.key === 'Escape') { if (S.rs) exitRestyle(true); else close(); }
  };
  document.addEventListener('keydown', S.onKey);
  $('skEnabled').addEventListener('click', async () => {
    try {
      const r = await AQTS().apiPost('/api/skins/enabled', { enabled: !S.enabled });
      S.enabled = r.skins.enabled;
      AQTS().skinsChanged(r.skins);
      renderEnabled();
      AQTS().toast(S.enabled ? 'Custom weapon skins are ON - restart the map in game' : 'Custom weapon skins are OFF - restart the map in game');
    } catch (e) { AQTS().toast(e.message, true); }
  });
  const setMode = m => {
    S.mode = m;
    localStorage.setItem('aq2ts.skmode', m);
    $('skViewGame').classList.toggle('sel', m === 'game');
    $('skViewOrbit').classList.toggle('sel', m === 'orbit');
    $('skCanvas').style.cursor = m === 'orbit' ? 'grab' : 'default';
  };
  $('skViewGame').addEventListener('click', () => setMode('game'));
  $('skViewOrbit').addEventListener('click', () => setMode('orbit'));
  setMode(S.mode);
  $('skFrame').addEventListener('input', () => { $('skAnim').checked = false; setFrame(Number($('skFrame').value)); });
  $('skUv').addEventListener('change', updateImage);
  $('skStock').addEventListener('change', updateImage);

  const fileInput = $('skFile');
  let fileKind = 'skin';
  const pick = (kind, accept) => {
    if (S.busy) return;
    fileKind = kind;
    fileInput.accept = accept;
    fileInput.value = '';
    fileInput.click();
  };
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (f) upload(f, fileKind);
  });
  $('skUpload').addEventListener('click', () => pick('skin', '.png,.jpg,.jpeg,.tga,.pcx'));
  $('skModel').addEventListener('click', () => pick('model', '.md2'));
  $('skUpscale').addEventListener('click', openUpscale);
  $('skRestyle').addEventListener('click', enterRestyle);
  $('rsApply').addEventListener('click', applyRestyle);
  $('rsCancel').addEventListener('click', () => exitRestyle(true));
  $('rsReset').addEventListener('click', () => { S.rs = { ...DEFAULT_PARAMS, protect: [] }; buildRestyleControls(); scheduleRestyle(true); });
  bindProtect();
  $('skUndo').addEventListener('click', () => simplePost('/api/skins/undo', {}, 'Previous skin restored'));
  $('skResetSkin').addEventListener('click', () => {
    const w = current();
    // with a replacement model the install's "stock" skin belongs to the
    // ORIGINAL model - it will look wrong on this one (and an AI upscale of
    // it would only sharpen the wrong picture)
    if (w && w.model && !confirm(`${w.label} uses a replacement model (${w.model.label || 'custom'}). The install's stock skin was drawn for the original model and will look wrong on it.

Remove the custom skin anyway?`)) return;
    simplePost('/api/skins/reset', { what: 'skin' }, 'Back to the stock skin');
  });
  $('skResetModel').addEventListener('click', () => simplePost('/api/skins/reset', { what: 'model' }, 'Back to the stock model - restart the map in game', true));
  $('skColSave').addEventListener('click', openSaveToCollection);
  $('skTemplate').addEventListener('click', async () => {
    const w = current();
    if (!w) return;
    try {
      const r = await AQTS().apiPost('/api/skins/template', { name: w.name, which: $('skStock').checked ? 'stock' : 'current' });
      AQTS().exportDone(`UV template for ${w.label} saved (the skin with the model's triangles drawn on top). Paint over it in any image editor, then upload the result as a skin.`, r.file);
    } catch (e) { AQTS().toast('Template failed: ' + e.message, true); }
  });
  $('skExport').addEventListener('click', async () => {
    const w = current();
    if (!w) return;
    try {
      const r = await AQTS().apiPost('/api/skins/export', { name: w.name, title: w.skin && w.skin.label ? w.skin.label : '' });
      AQTS().exportDone(`Skin file for ${w.label} written (${(r.size / 1024 / 1024).toFixed(1)} MB).`, r.file);
    } catch (e) { AQTS().toast('Export failed: ' + e.message, true); }
  });
  $('skImport').addEventListener('click', () => $('importFile').click());
}

window.AQSkins = { open, close, refresh };
