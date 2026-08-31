// UI logic for milestone 2: browse maps/textures, swap textures & skyboxes,
// applied to the game via generated link-cfgs.
const $ = id => document.getElementById(id);

const state = {
  dir: localStorage.getItem('aq2ts.dir') || '',
  res: localStorage.getItem('aq2ts.res') || 'hi',
  scan: null,
  detail: null,
  activeMap: null,
  catalog: null,
  skies: null,
};

function apiGet(pathname, params = {}) {
  const url = new URL(pathname, location.origin);
  url.searchParams.set('dir', state.dir);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url).then(async r => {
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  });
}

function apiPost(pathname, body) {
  return fetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: state.dir, res: state.res, ...body }),
  }).then(async r => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  });
}

// picker texture dimensions, fetched lazily one rendered batch at a time
// (probing all ~20k install textures up front takes ~25s); keyed by the
// hi/low-res preview mode since that changes which file the thumb shows
const texDimsCache = new Map();
const dimKey = name => state.res + '|' + name;
async function fillDims(batch, cells) {
  const need = batch.filter(c => !texDimsCache.has(dimKey(c.name))).map(c => c.name);
  if (need.length) {
    try {
      const r = await apiPost('/api/texdims', { names: need });
      for (const n of need) {
        const d = r.dims[n];
        texDimsCache.set(dimKey(n), d ? `${d.w}×${d.h} ${d.ext.slice(1)}` : '');
      }
    } catch { return; }
  }
  cells.forEach((cell, i) => {
    const el = cell.querySelector('.pdim');
    const t = texDimsCache.get(dimKey(batch[i].name));
    if (el && t) el.textContent = t;
  });
}

// bump THUMB_V whenever thumbnail rendering changes (placeholder art,
// defringe tweaks...) - thumbs are browser-cached for 10 min per URL, so a
// new version busts every stale copy at once. bustThumbs() does the same
// at runtime (e.g. after the missing-texture style changes).
let THUMB_V = '2';
function bustThumbs() {
  THUMB_V = '2-' + Date.now();
}
function thumbUrl(params) {
  const url = new URL('/api/thumb', location.origin);
  url.searchParams.set('v', THUMB_V);
  url.searchParams.set('dir', state.dir);
  url.searchParams.set('res', state.res);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function swapThumbUrl(spec, size) {
  if (spec.type === 'flat') {
    const p = { flat: spec.color, style: spec.style || 'solid', size };
    if (spec.color2) p.color2 = spec.color2;
    return thumbUrl(p);
  }
  if (spec.type === 'custom') return thumbUrl({ custom: spec.file, size });
  if (spec.type === 'invisible') return null;
  return thumbUrl({ tex: spec.to, size });
}

function swapLabel(spec) {
  switch (spec.type) {
    case 'flat': return `→ flat ${spec.color}${spec.style && spec.style !== 'solid' ? ` · ${spec.style}${spec.color2 ? ' ' + spec.color2 : ''}` : ''}`;
    case 'custom': return `→ your image${spec.w ? ` (${spec.w}×${spec.h})` : ''}`;
    case 'invisible': return '→ invisible';
    default: return `→ ${spec.to}`;
  }
}

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function reportWritten(result) {
  const w = result.written || [];
  const parts = [];
  if (w.length) parts.push(w.length === 1 ? `wrote ${w[0]}` : `wrote ${w.length} cfg/gen files`);
  for (const warn of result.warnings || []) toast(warn, true);
  if (parts.length) toast(parts.join(' · '));
}

function showBanner(msg) {
  const b = $('banner');
  if (!msg) { b.classList.add('hidden'); return; }
  b.textContent = msg;
  b.classList.remove('hidden');
}

// ---------- scan & map list ----------

async function boot() {
  if (!state.dir) {
    try { state.dir = (await fetch('/api/defaults').then(r => r.json())).dir; }
    catch { state.dir = ''; }
  }
  $('dirInput').value = state.dir;
  if (!state.dir) {
    $('empty').firstElementChild.textContent = 'Welcome! Point me at your AQ2 / AQtion folder to get started.';
    showBanner('First step: click Browse… (top right) and pick your AQ2 folder — the one with q2pro.exe / aqtion.exe in it.');
    return;
  }
  await rescan(false);
}

async function rescan(refresh) {
  state.dir = $('dirInput').value.trim();
  localStorage.setItem('aq2ts.dir', state.dir);
  state.catalog = null;
  state.skies = null;
  mapTexCache.clear();
  const oldDl = document.getElementById('mapNamesData');
  if (oldDl) oldDl.remove();
  showBanner(null);
  $('empty').classList.remove('hidden');
  $('mapView').classList.add('hidden');
  $('empty').firstElementChild.textContent = 'Scanning ' + state.dir + ' …';
  try {
    state.scan = await apiGet('/api/scan', refresh ? { refresh: 1 } : {});
  } catch (e) {
    state.scan = null;
    renderMapList();
    renderHook();
    $('empty').firstElementChild.textContent = 'Scan failed.';
    showBanner('Scan failed: ' + e.message);
    return;
  }
  const warn = [];
  if (!state.scan.hasPalette) warn.push('colormap.pcx not found — .wal textures cannot be decoded.');
  warn.push(...state.scan.warnings);
  showBanner(warn.length ? warn.join('\n') : null);
  renderMapList();
  renderHook();
  $('mapSearch').placeholder = `Search ${state.scan.maps.length} maps…`;
  $('empty').firstElementChild.textContent =
    `${state.scan.maps.length} maps in ${state.scan.gameDirs.join(' + ')} — pick one on the left.`;
  if (state.activeMap && state.scan.maps.some(m => m.name === state.activeMap)) {
    selectMap(state.activeMap);
  }
}

function renderHook() {
  const area = $('hookArea');
  area.textContent = '';
  area.style.display = 'flex';
  area.style.gap = '8px';
  area.style.alignItems = 'center';
  if (!state.scan) return;

  $('setupBanner').classList.toggle('hidden', state.scan.hook.installed);

  const toggle = document.createElement('button');
  const on = state.scan.swapsEnabled !== false;
  toggle.textContent = on ? 'Swaps: ON' : 'Swaps: OFF';
  toggle.className = on ? '' : 'off';
  toggle.title = on
    ? 'Click to disable all swaps (presets are kept; maps load stock)'
    : 'All swaps are disabled - click to re-enable your presets';
  toggle.addEventListener('click', toggleEnabled);
  area.appendChild(toggle);

  const lib = document.createElement('button');
  lib.textContent = '📂 Collections';
  lib.title = 'Browse all textures, star favorites, organize named collections';
  lib.addEventListener('click', openTextureLibrary);
  area.appendChild(lib);

  const light = document.createElement('button');
  const managed = state.scan.lighting && state.scan.lighting.manage;
  light.innerHTML = managed ? '🌍 Lighting<span class="dot"></span>' : '🌍 Lighting';
  light.title = managed
    ? 'Lighting management is ON - edit the global (all maps) defaults'
    : 'Set up managed lighting defaults for all maps (gl_modulate & co.)';
  light.addEventListener('click', () => openLighting('global'));
  area.appendChild(light);

  const miss = document.createElement('button');
  const mfOn = state.scan.missingFix && state.scan.missingFix.enabled;
  miss.innerHTML = mfOn ? '🧱 Missing tex<span class="dot"></span>' : '🧱 Missing tex';
  miss.title = mfOn
    ? 'Missing-texture fix is ON - every texture your install lacks gets your chosen style in game'
    : 'Choose a style for textures your install lacks, and apply it in game across all maps';
  miss.addEventListener('click', openMissingFix);
  area.appendChild(miss);

  const imp = document.createElement('button');
  imp.textContent = 'Import preset…';
  imp.title = 'Load a .aq2swap.json file from a friend';
  imp.addEventListener('click', () => $('importFile').click());
  area.appendChild(imp);
}

async function toggleEnabled() {
  const target = !(state.scan.swapsEnabled !== false);
  try {
    const r = await apiPost('/api/enabled', { enabled: target });
    state.scan.swapsEnabled = r.enabled;
    renderHook();
    reportWritten(r);
    toast(r.enabled
      ? 'Swaps re-enabled - active again on next map load / F9'
      : 'All swaps disabled - maps load stock (presets kept)');
  } catch (e) {
    toast('Toggle failed: ' + e.message, true);
  }
}

async function importPresetFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Not a valid preset file (bad JSON)', true);
    return;
  }
  try {
    const r = await apiPost('/api/import', { data });
    for (const w of r.warnings || []) toast(w, true);
    toast(`Imported preset for "${r.map}"`);
    if (state.scan && state.scan.maps.some(m => m.name === r.map)) {
      await selectMap(r.map);
    }
  } catch (e) {
    toast('Import failed: ' + e.message, true);
  }
}

async function installHook() {
  try {
    const r = await apiPost('/api/hook', {});
    state.scan.hook = r.hook;
    renderHook();
    toast('Hook installed into ' + r.hook.autoexec);
  } catch (e) {
    toast('Hook install failed: ' + e.message, true);
  }
}

function renderMapList() {
  const ul = $('mapList');
  ul.textContent = '';
  const q = $('mapSearch').value.trim().toLowerCase();
  const maps = state.scan ? state.scan.maps : [];
  let shown = 0;
  for (const m of maps) {
    if (q && !m.name.includes(q) && !(m.title || '').toLowerCase().includes(q)) continue;
    shown++;
    const li = document.createElement('li');
    li.dataset.map = m.name;
    if (m.error) li.classList.add('err');
    if (m.name === state.activeMap) li.classList.add('active');
    const src = m.source && m.source.includes('loose') ? m.source : (m.source || '');
    const name = document.createElement('div');
    name.className = 'mname';
    name.textContent = m.name;
    if (m.swapCount) {
      const b = document.createElement('span');
      b.className = 'badge swapbadge';
      b.textContent = m.swapCount + ' swap' + (m.swapCount > 1 ? 's' : '');
      name.appendChild(b);
    }
    const title = document.createElement('div');
    title.className = 'mtitle';
    title.textContent = m.error ? m.error : (m.title || '—');
    const meta = document.createElement('div');
    meta.className = 'msrc';
    meta.textContent = m.error ? '' : `${m.textureCount} textures · ${src}`;
    li.append(name, title, meta);
    li.addEventListener('click', () => selectMap(m.name));
    ul.appendChild(li);
  }
}

function syncMapListEntry() {
  if (!state.scan || !state.detail) return;
  const m = state.scan.maps.find(x => x.name === state.detail.name);
  if (m) m.swapCount = state.detail.swapCount;
  renderMapList();
}

// ---------- map detail ----------

async function selectMap(name) {
  state.activeMap = name;
  for (const li of $('mapList').children) {
    li.classList.toggle('active', li.dataset.map === name);
  }
  try {
    state.detail = await apiGet('/api/map', { name, res: state.res });
  } catch (e) {
    showBanner(`Could not read map ${name}: ${e.message}`);
    return;
  }
  renderDetail();
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  $('empty').classList.add('hidden');
  $('mapView').classList.remove('hidden');
  $('mapName').textContent = d.name;
  $('mapTitle').textContent = d.title || '';
  const fmt = d.extended ? ' · extended BSP' : '';
  $('mapMeta').textContent = `${d.file} · from ${d.source}${fmt}`;

  $('skyName').textContent = d.sky || '(engine default)';
  $('skySwapInfo').textContent = d.skySwap ? '→ ' + d.skySwap : '';
  if (d.skySwap) $('skyThumb').src = thumbUrl({ sky: d.skySwap });
  else if (d.sky) $('skyThumb').src = thumbUrl({ sky: d.sky });
  else $('skyThumb').removeAttribute('src');

  const resetBtn = $('resetMapBtn');
  const hasWork = d.swapCount > 0 || d.lighting;
  resetBtn.classList.toggle('hidden', !hasWork);
  resetBtn.textContent = `Reset map (${d.swapCount})`;

  const lightBtn = $('mapLightBtn');
  lightBtn.innerHTML = d.lighting ? '📍 Map lighting<span class="dot"></span>' : '📍 Map lighting';
  lightBtn.title = d.lighting
    ? `${d.name} has its own lighting override - click to edit`
    : `Override the global lighting on ${d.name} only`;

  renderPresetRow();
  renderGrid();
  syncMapListEntry();
}

function renderPresetRow() {
  const d = state.detail;
  const row = $('presetRow');
  row.textContent = '';
  if (!d) return;

  const label = document.createElement('span');
  label.className = 'plabel';
  label.textContent = 'presets';
  row.appendChild(label);

  for (const name of d.savedPresets || []) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (d.activePreset === name ? ' current' : '');
    chip.title = d.activePreset === name ? `Preset "${name}" is active` : `Load preset "${name}"`;
    const txt = document.createElement('span');
    txt.textContent = name;
    const del = document.createElement('button');
    del.className = 'chipdel';
    del.textContent = '✕';
    del.title = `Delete preset "${name}"`;
    del.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!confirm(`Delete preset "${name}"?`)) return;
      try {
        const r = await apiPost('/api/preset/delete', { map: d.name, name });
        state.detail = r.detail;
        renderPresetRow();
        toast(`Deleted preset "${name}"`);
      } catch (e) { toast('Delete failed: ' + e.message, true); }
    });
    chip.append(txt, del);
    chip.addEventListener('click', async () => {
      try {
        applyMutation(await apiPost('/api/preset/load', { map: d.name, name }));
        toast(`Loaded preset "${name}" - F9 in game to see it`);
      } catch (e) { toast('Load failed: ' + e.message, true); }
    });
    row.appendChild(chip);
  }

  const save = document.createElement('button');
  save.className = 'small';
  save.textContent = 'Save as preset…';
  save.disabled = !d.swapCount;
  save.title = d.swapCount ? 'Save the current swaps under a name' : 'Add some swaps first';
  save.addEventListener('click', openSavePreset);
  row.appendChild(save);

  const exp = document.createElement('button');
  exp.className = 'small';
  exp.textContent = 'Export…';
  exp.disabled = !d.swapCount;
  exp.title = d.swapCount ? 'Write a shareable .aq2swap.json file for this map' : 'Add some swaps first';
  exp.addEventListener('click', exportCurrent);
  row.appendChild(exp);
}

function openSavePreset() {
  const d = state.detail;
  openModal(`
    <div class="mhead">
      <h3>Save preset for <span class="mono">${d.name}</span></h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody">
      <p style="color:var(--dim);margin-bottom:10px">Saves the current ${d.swapCount} swap(s) under a name you can reload anytime.</p>
      <input id="presetName" class="namefield" maxlength="24" placeholder="e.g. comp, bright, chill…">
    </div>
    <div class="mfoot">
      <button class="primary" id="presetSaveBtn">Save</button>
    </div>
  `);
  const doSave = async () => {
    const name = $('presetName').value.trim();
    if (!name) return;
    closeModal();
    try {
      const r = await apiPost('/api/preset/save', { map: d.name, name });
      state.detail = r.detail;
      renderPresetRow();
      toast(`Saved preset "${r.name}"`);
    } catch (e) { toast('Save failed: ' + e.message, true); }
  };
  $('presetSaveBtn').addEventListener('click', doSave);
  $('presetName').addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
  $('presetName').focus();
}

async function exportCurrent() {
  const d = state.detail;
  try {
    const r = await apiPost('/api/export', { map: d.name });
    toast(`Exported! Send this file to your friends: ${r.file}`);
  } catch (e) {
    toast('Export failed: ' + e.message, true);
  }
}

function renderGrid() {
  const d = state.detail;
  const grid = $('grid');
  grid.textContent = '';
  if (!d) return;

  const q = $('texSearch').value.trim().toLowerCase();
  const showUtility = $('showUtility').checked;
  const sort = $('sortSel').value;

  let list = d.textures.filter(t => (showUtility || !t.utility || t.swap) && (!q || t.name.includes(q)));
  if (sort === 'faces') list = [...list].sort((a, b) => b.faces - a.faces);
  else if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  const maxPct = Math.max(0.01, ...list.map(t => t.areaPct));

  for (const t of list) {
    const card = document.createElement('div');
    card.className = 'card' + (t.swap ? ' swapped' : '');
    card.title = t.swap ? 'Click to change this swap' : 'Click to replace this texture';

    const wrap = document.createElement('div');
    wrap.className = 'imgwrap';
    const mainSrc = t.swap ? swapThumbUrl(t.swap, 128) : thumbUrl({ tex: t.name });
    if (t.swap && t.swap.type === 'invisible') {
      wrap.innerHTML = '<span class="missing">👻 invisible</span>';
    } else {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = mainSrc;
      img.alt = t.name;
      img.addEventListener('error', () => { wrap.innerHTML = '<span class="missing">decode failed</span>'; });
      wrap.appendChild(img);
    }
    card.appendChild(wrap);

    if (t.swap) {
      const tag = document.createElement('span');
      tag.className = 'swaptag';
      tag.textContent = t.swap.type === 'flat' ? 'FLAT' : 'SWAP';
      card.appendChild(tag);
      {
        const orig = document.createElement('img');
        orig.className = 'origthumb';
        orig.loading = 'lazy';
        orig.title = 'original';
        orig.src = thumbUrl({ tex: t.name, size: 64 });
        card.appendChild(orig);
      }
      const rm = document.createElement('button');
      rm.className = 'removebtn';
      rm.textContent = '✕';
      rm.title = 'Remove this swap';
      rm.addEventListener('click', ev => { ev.stopPropagation(); setSwap(t.name, null); });
      card.appendChild(rm);
    }

    const info = document.createElement('div');
    info.className = 'info';
    const nameEl = document.createElement('div');
    nameEl.className = 'tname';
    nameEl.textContent = t.name;
    for (const f of t.flags) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = f;
      nameEl.appendChild(b);
    }
    if (t.missing) {
      const b = document.createElement('span');
      b.className = 'badge missingbadge';
      b.textContent = 'missing';
      b.title = 'No image file in this install — showing the blue placeholder';
      nameEl.appendChild(b);
    }
    const meta = document.createElement('div');
    meta.className = 'tmeta';
    const mfOn = state.scan && state.scan.missingFix && state.scan.missingFix.enabled;
    const dims = t.missing ? (mfOn ? 'missing · styled by your 🧱 fix' : 'missing') : `${t.w}×${t.h} ${t.ext.slice(1)}`;
    meta.textContent = t.swap
      ? swapLabel(t.swap)
      : `${dims} · ${t.faces} faces · ${t.areaPct}%`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('span');
    fill.style.width = Math.round(t.areaPct / maxPct * 100) + '%';
    bar.appendChild(fill);
    info.append(nameEl, meta, bar);
    card.appendChild(info);

    card.addEventListener('click', () => openPicker(t));
    grid.appendChild(card);
  }

  $('texCount').textContent = `${list.length} textures`;
}

// ---------- mutations ----------

function applyMutation(r) {
  state.detail = r.detail;
  renderDetail();
  reportWritten(r);
  if (window.AQViewer) window.AQViewer.onSwapsChanged(state.detail);
}

async function setSwap(from, spec) {
  try {
    applyMutation(await apiPost('/api/swap', { map: state.detail.name, from, spec }));
  } catch (e) {
    toast('Swap failed: ' + e.message, true);
  }
}

async function setSky(to) {
  try {
    applyMutation(await apiPost('/api/sky', { map: state.detail.name, to }));
  } catch (e) {
    toast('Sky swap failed: ' + e.message, true);
  }
}

async function resetMap() {
  try {
    applyMutation(await apiPost('/api/reset', { map: state.detail.name }));
    toast(`All swaps removed for ${state.detail.name}`);
  } catch (e) {
    toast('Reset failed: ' + e.message, true);
  }
}

// ---------- modal & pickers ----------

function openModal(html) {
  $('modal').innerHTML = html;
  $('modalOverlay').classList.remove('hidden');
  $('modal').querySelector('.mclose').addEventListener('click', closeModal);
}

function closeModal() {
  $('modalOverlay').classList.add('hidden');
  $('modal').innerHTML = '';
}

$('modalOverlay').addEventListener('click', e => {
  if (e.target === $('modalOverlay')) closeModal();
});

async function ensureCatalog() {
  if (!state.catalog) state.catalog = (await apiGet('/api/textures')).textures;
  return state.catalog;
}

async function ensureSkies() {
  if (!state.skies) state.skies = (await apiGet('/api/skies')).skies;
  return state.skies;
}

async function openPicker(t) {
  openModal(`
    <div class="mhead">
      <h3>Replace <span class="mono">${t.name}</span></h3>
      <button class="mclose">✕</button>
    </div>
    <div class="tabs">
      <button id="tabStock" class="active">Stock textures</button>
      <button id="tabFlat">Flat / clean</button>
      <button id="tabCustom">Your image</button>
    </div>
    <div class="mbody" id="mbody"></div>
    <div class="mfoot" id="mfoot"></div>
  `);
  const foot = $('mfoot');
  if (t.swap) {
    const rm = document.createElement('button');
    rm.className = 'danger';
    rm.textContent = 'Remove swap (back to original)';
    rm.addEventListener('click', () => { closeModal(); setSwap(t.name, null); });
    foot.appendChild(rm);
  }
  $('tabStock').addEventListener('click', () => switchTab(t, 'stock'));
  $('tabFlat').addEventListener('click', () => switchTab(t, 'flat'));
  $('tabCustom').addEventListener('click', () => switchTab(t, 'custom'));
  const startTab = t.swap && t.swap.type === 'flat' ? 'flat'
    : t.swap && t.swap.type === 'custom' ? 'custom' : 'stock';
  switchTab(t, startTab);
}

function switchTab(t, tab) {
  $('tabStock').classList.toggle('active', tab === 'stock');
  $('tabFlat').classList.toggle('active', tab === 'flat');
  $('tabCustom').classList.toggle('active', tab === 'custom');
  if (tab === 'stock') renderStockTab(t);
  else if (tab === 'custom') renderCustomTab(t);
  else renderFlatTab(t);
}

function renderCustomTab(t) {
  const body = $('mbody');
  const orig = t.missing ? 'unknown size' : `${t.w}×${t.h} ${t.ext.slice(1)}`;
  body.innerHTML = `
    <p class="mnote">Replace <span class="mono" style="color:var(--accent2)">${t.name}</span>
      (original: ${orig}) with your own image — png, jpg or tga.
      Matching the original's aspect ratio keeps it looking right on the walls.</p>
    <div class="flatrow">
      <input type="file" id="customFile" accept=".png,.jpg,.jpeg,.tga">
      <img id="customPreview" class="flatpreview hidden" alt="preview">
      <button class="primary hidden" id="customApply">Use this image</button>
    </div>
  `;
  let picked = null;
  $('customFile').addEventListener('change', e => {
    picked = e.target.files[0] || null;
    const preview = $('customPreview');
    const apply = $('customApply');
    if (!picked) { preview.classList.add('hidden'); apply.classList.add('hidden'); return; }
    apply.classList.remove('hidden');
    if (/\.(png|jpe?g)$/i.test(picked.name)) {
      preview.src = URL.createObjectURL(picked);
      preview.classList.remove('hidden');
    } else {
      preview.classList.add('hidden'); // no native preview for tga
    }
  });
  $('customApply').addEventListener('click', async () => {
    if (!picked) return;
    const buf = new Uint8Array(await picked.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    closeModal();
    try {
      applyMutation(await apiPost('/api/upload', {
        map: state.detail.name,
        from: t.name,
        filename: picked.name,
        dataB64: btoa(bin),
      }));
      toast('Your image is in - F9 in game to see it');
    } catch (e) {
      toast('Upload failed: ' + e.message, true);
    }
  });
}

async function renderStockTab(t) {
  await buildTextureBrowser($('mbody'), {
    exclude: t.name,
    currentTo: t.swap && t.swap.type === 'stock' ? t.swap.to : null,
    onPick: name => { closeModal(); setSwap(t.name, { type: 'stock', to: name }); },
  });
}

// Map-name autocomplete + per-map texture sets for the browser's map filter
const mapTexCache = new Map();

function ensureMapDatalist() {
  if (document.getElementById('mapNamesData')) return;
  const dl = document.createElement('datalist');
  dl.id = 'mapNamesData';
  for (const m of (state.scan && state.scan.maps) || []) {
    if (m.error) continue;
    const o = document.createElement('option');
    o.value = m.name;
    if (m.title) o.label = m.title;
    dl.appendChild(o);
  }
  document.body.appendChild(dl);
}

async function getMapTextureSet(mapName) {
  if (mapTexCache.has(mapName)) return mapTexCache.get(mapName);
  const d = await apiGet('/api/map', { name: mapName });
  const set = new Set(d.textures.map(x => x.name));
  mapTexCache.set(mapName, set);
  return set;
}

// Shared texture browser: used by the swap picker (onPick swaps) and by the
// standalone Collections library (clicking files a texture into collections).
async function buildTextureBrowser(body, opts = {}) {
  body.innerHTML = `
    ${opts.libraryMode ? '<p style="color:var(--dim);font-size:12.5px;margin-bottom:10px">Browse every texture in the install. ☆ stars a favorite; ＋ (or clicking a texture) files it into named collections. Use the dropdown to view a collection.</p>' : ''}
    <div class="mtools">
      <input id="pickSearch" type="search" placeholder="Search textures…">
      <input id="mapFilter" class="mapfilter" type="search" list="mapNamesData"
        placeholder="on map… (name or title)" title="Show only textures used by one map — type its name or title">
      <select id="viewSel"></select>
      <select id="colsSel" title="Preview size — textures per row">
        <option value="auto">size: auto</option>
        <option value="4">big — 4 per row</option>
        <option value="5">large — 5 per row</option>
        <option value="6">medium — 6 per row</option>
        <option value="8">small — 8 per row</option>
      </select>
      <button id="delSetBtn" class="danger hidden">🗑 delete collection</button>
      <span class="count" id="pickCount"></span>
    </div>
    <div class="pickgrid" id="pickGrid"></div>
  `;
  ensureMapDatalist();
  const catalog = await ensureCatalog();
  const search = $('pickSearch');
  const viewSel = $('viewSel');
  const mapInput = $('mapFilter');
  let mapSet = null;
  let mapFilterName = '';

  const colsSel = $('colsSel');
  colsSel.value = localStorage.getItem('aq2ts.gridcols') || '6';
  if (colsSel.selectedIndex < 0) colsSel.value = '6';
  const applyCols = () => {
    $('pickGrid').style.gridTemplateColumns =
      colsSel.value === 'auto' ? '' : `repeat(${colsSel.value}, 1fr)`;
  };
  const thumbSizeForCols = () => ({ 4: 192, 5: 160, 6: 128, 8: 96 }[colsSel.value] || 96);
  const src = state.scan || state.detail || {};
  const favs = new Set(src.favTextures || []);
  let sets = { ...(src.favSets || {}) };
  let view = localStorage.getItem('aq2ts.stockview') || 'all';

  const rebuildViewSel = () => {
    if (view.startsWith('set:') && !sets[view.slice(4)]) view = 'all';
    viewSel.innerHTML = '';
    const opts = [
      ['all', 'All textures'],
      ['favs', `★ All favorites (${favs.size})`],
      ...Object.keys(sets).sort().map(s => [`set:${s}`, `📂 ${s} (${sets[s].length})`]),
    ];
    for (const [v, label] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      if (v === view) o.selected = true;
      viewSel.appendChild(o);
    }
  };

  const render = () => {
    closeSetPopup();
    rebuildViewSel();
    $('delSetBtn').classList.toggle('hidden', !view.startsWith('set:'));
    const q = search.value.trim().toLowerCase();
    const grid = $('pickGrid');
    grid.textContent = '';
    let matches = catalog.filter(c => c.name !== opts.exclude && (!q || c.name.includes(q)));
    if (view === 'favs') matches = matches.filter(c => favs.has(c.name));
    else if (view.startsWith('set:')) {
      const members = new Set(sets[view.slice(4)] || []);
      matches = matches.filter(c => members.has(c.name));
    }
    if (mapSet) matches = matches.filter(c => mapSet.has(c.name));
    matches = [...matches].sort((a, b) =>
      (favs.has(b.name) - favs.has(a.name)) || a.name.localeCompare(b.name));
    matchesCache = matches;
    rendered = 0;
    appendBatch();
  };

  let matchesCache = [];
  let rendered = 0;
  const BATCH = 240;

  const makeCell = c => {
      const cell = document.createElement('div');
      cell.className = 'pickcell' + (opts.currentTo === c.name ? ' current' : '');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = thumbUrl({ tex: c.name, size: thumbSizeForCols() });
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      const label = document.createElement('div');
      label.className = 'pname';
      label.textContent = c.name;
      const dim = document.createElement('div');
      dim.className = 'pdim';
      dim.textContent = texDimsCache.get(dimKey(c.name)) || '';
      const star = document.createElement('button');
      star.className = 'favbtn' + (favs.has(c.name) ? ' fav' : '');
      star.textContent = favs.has(c.name) ? '★' : '☆';
      star.title = favs.has(c.name) ? 'Remove from favorites' : 'Mark as favorite';
      star.addEventListener('click', async ev => {
        ev.stopPropagation();
        const nowFav = !favs.has(c.name);
        try {
          const r = await apiPost('/api/favtex', { name: c.name, fav: nowFav });
          favs.clear();
          for (const f of r.favTextures) favs.add(f);
          for (const holder of [state.scan, state.detail]) {
            if (holder) holder.favTextures = r.favTextures;
          }
          star.textContent = nowFav ? '★' : '☆';
          star.classList.toggle('fav', nowFav);
        } catch (e) { toast('Favorite failed: ' + e.message, true); }
      });
      const plus = document.createElement('button');
      plus.className = 'favbtn plusbtn';
      plus.textContent = '＋';
      plus.title = 'Add to / remove from collections';
      plus.addEventListener('click', ev => {
        ev.stopPropagation();
        openSetPopup(plus, c.name);
      });
      cell.append(img, star, plus, label, dim);
      cell.title = opts.libraryMode ? 'Click to file into collections' : 'Click to use as replacement';
      cell.addEventListener('click', () => {
        if (opts.libraryMode) openSetPopup(plus, c.name);
        else if (opts.onPick) opts.onPick(c.name);
      });
      return cell;
  };

  const sentinel = document.createElement('div');
  sentinel.style.height = '10px';

  const updateCount = () => {
    const onMap = mapFilterName ? ` on ${mapFilterName}` : '';
    $('pickCount').textContent = rendered < matchesCache.length
      ? `showing ${rendered} of ${matchesCache.length}${onMap} — scroll for more`
      : `${matchesCache.length} textures${onMap}`;
  };

  const appendBatch = () => {
    const grid = $('pickGrid');
    sentinel.remove();
    const batch = matchesCache.slice(rendered, rendered + BATCH);
    const cells = batch.map(c => grid.appendChild(makeCell(c)));
    rendered = Math.min(rendered + BATCH, matchesCache.length);
    if (rendered < matchesCache.length) grid.after(sentinel);
    updateCount();
    fillDims(batch, cells);
  };

  new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting) && rendered < matchesCache.length) appendBatch();
  }).observe(sentinel);

  const applyMapFilter = async () => {
    const v = mapInput.value.trim().toLowerCase();
    if (!v) {
      mapSet = null; mapFilterName = '';
      render();
      return;
    }
    const maps = (state.scan && state.scan.maps) || [];
    const m = maps.find(x => x.name === v) ||
      maps.find(x => (x.title || '').toLowerCase() === v);
    if (!m) { mapSet = null; mapFilterName = ''; render(); return; }
    try {
      mapSet = await getMapTextureSet(m.name);
      mapFilterName = m.name;
    } catch (e) {
      toast('Could not read map ' + m.name + ': ' + e.message, true);
      mapSet = null; mapFilterName = '';
    }
    render();
  };
  mapInput.addEventListener('input', applyMapFilter);
  mapInput.addEventListener('change', applyMapFilter);
  colsSel.addEventListener('change', () => {
    localStorage.setItem('aq2ts.gridcols', colsSel.value);
    applyCols();
    render();
  });
  applyCols();

  // small anchored popup for collection membership
  const closeSetPopup = () => {
    const p = document.getElementById('setPop');
    if (p) p.remove();
    document.removeEventListener('mousedown', onOutside);
  };
  const onOutside = e => {
    const p = document.getElementById('setPop');
    if (p && !p.contains(e.target)) { closeSetPopup(); render(); }
  };
  const setCall = async (action, setName, texName) => {
    const r = await apiPost('/api/favset', { action, set: setName, name: texName });
    sets = r.favSets;
    favs.clear();
    for (const f of r.favTextures) favs.add(f);
    for (const holder of [state.scan, state.detail]) {
      if (holder) { holder.favSets = r.favSets; holder.favTextures = r.favTextures; }
    }
    return r;
  };
  const openSetPopup = (anchor, texName) => {
    closeSetPopup();
    const pop = document.createElement('div');
    pop.id = 'setPop';
    pop.className = 'setpop';
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
    pop.style.top = (rect.bottom + 4) + 'px';
    const title = document.createElement('div');
    title.className = 'sptitle';
    title.textContent = texName;
    pop.appendChild(title);
    for (const s of Object.keys(sets).sort()) {
      const row = document.createElement('label');
      row.className = 'sprow';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = (sets[s] || []).includes(texName);
      cb.addEventListener('change', async () => {
        try { await setCall(cb.checked ? 'add' : 'remove', s, texName); }
        catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
      });
      row.append(cb, document.createTextNode(' ' + s));
      pop.appendChild(row);
    }
    if (!Object.keys(sets).length) {
      const none = document.createElement('div');
      none.className = 'sphint';
      none.textContent = 'No collections yet — create one:';
      pop.appendChild(none);
    }
    const newRow = document.createElement('div');
    newRow.className = 'spnew';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 30;
    inp.placeholder = 'new collection…';
    const btn = document.createElement('button');
    btn.textContent = 'Add';
    const createAndAdd = async () => {
      const name = inp.value.trim();
      if (!name) return;
      try {
        await setCall('add', name, texName);
        toast(`Added to new collection "${name}"`);
        closeSetPopup();
        render();
      } catch (e) { toast(e.message, true); }
    };
    btn.addEventListener('click', createAndAdd);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') createAndAdd(); });
    newRow.append(inp, btn);
    pop.appendChild(newRow);
    document.body.appendChild(pop);
    setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  };

  $('delSetBtn').addEventListener('click', async () => {
    const name = view.slice(4);
    if (!confirm(`Delete collection "${name}"? (textures stay in All favorites)`)) return;
    try {
      await setCall('deleteSet', name, null);
      view = 'all';
      localStorage.setItem('aq2ts.stockview', view);
      render();
      toast(`Collection "${name}" deleted`);
    } catch (e) { toast(e.message, true); }
  });
  viewSel.addEventListener('change', () => {
    view = viewSel.value;
    localStorage.setItem('aq2ts.stockview', view);
    render();
  });
  search.addEventListener('input', render);
  search.focus();
  render();
}

const FLAT_STYLES = [
  { id: 'solid', label: 'solid' },
  { id: 'grid', label: 'grid' },
  { id: 'checker', label: 'checker' },
  { id: 'stripes', label: 'stripes' },
  { id: 'diag', label: 'diagonal' },
];

// Read the (flat) color of a loaded same-origin thumbnail image.
function sampleImgColor(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
}

async function renderFlatTab(t) {
  const cur = t.swap && t.swap.type === 'flat' ? t.swap : null;
  let color = cur ? cur.color : '#9aa0a8';
  let style = cur && cur.style ? cur.style : 'solid';
  let color2 = cur && cur.color2 ? cur.color2 : null; // null = auto darker shade
  let updateRalleHint = () => {};
  const body = $('mbody');
  body.innerHTML = `
    <p class="mnote">Replace with a generated flat texture — great for visibility. Patterns add subtle lines so you can still judge distance and speed.</p>
    <div class="stylerow" id="styleRow"></div>
    <div class="swatches" id="swatches"></div>
    <div class="flatrow">
      <label>Custom: <input type="color" id="flatColor" value="${color}"></label>
      <img id="flatPreview" class="flatpreview" alt="preview">
      <button class="primary" id="flatApply">Use this</button>
    </div>
    <div id="patternSection" class="hidden">
      <div class="sectionhead">Pattern color</div>
      <div class="flatrow">
        <label><input type="checkbox" id="patAuto"> auto (darker shade of the base)</label>
        <label>Custom: <input type="color" id="flatColor2"></label>
      </div>
      <p class="mnote" style="margin:6px 0 4px">…or pick from the Quake 2 palette:</p>
      <div class="palgrid" id="palGrid"></div>
    </div>
    <div id="ralleSection"></div>
  `;
  const colorInput = $('flatColor');
  const preview = $('flatPreview');
  const styleRow = $('styleRow');
  const patSection = $('patternSection');
  const patAuto = $('patAuto');
  const color2Input = $('flatColor2');

  const autoShade = () => {
    const v = colorInput.value;
    const [r, g, b] = [1, 3, 5].map(i => Math.max(0, parseInt(v.slice(i, i + 2), 16) - 28));
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  };
  const syncPattern = () => {
    patSection.classList.toggle('hidden', style === 'solid');
    patAuto.checked = !color2;
    color2Input.value = color2 || autoShade();
    $('palGrid').querySelectorAll('.palswatch').forEach(x =>
      x.classList.toggle('sel', !!color2 && x.dataset.c === color2));
  };
  const thumbParams = (base, s, size) => {
    const p = { flat: base, style: s, size };
    if (color2 && s !== 'solid') p.color2 = color2;
    return p;
  };
  const renderStyles = () => {
    styleRow.textContent = '';
    for (const s of FLAT_STYLES) {
      const b = document.createElement('button');
      b.className = 'stylebtn' + (s.id === style ? ' sel' : '');
      const img = document.createElement('img');
      img.src = thumbUrl(thumbParams(colorInput.value, s.id, 52));
      const label = document.createElement('span');
      label.textContent = s.label;
      b.append(img, label);
      b.addEventListener('click', () => { style = s.id; renderStyles(); updatePreview(); updateRalleHint(); syncPattern(); });
      styleRow.appendChild(b);
    }
  };
  const updatePreview = () => {
    preview.src = thumbUrl(thumbParams(colorInput.value, style, 96));
  };

  // Quake 2 palette swatches for the pattern color
  try {
    const pal = await fetch(`/api/palette?dir=${encodeURIComponent(state.dir)}`).then(r => r.json());
    const grid = $('palGrid');
    for (const c of pal.colors || []) {
      const b = document.createElement('button');
      b.className = 'palswatch';
      b.style.background = c;
      b.title = c;
      b.dataset.c = c;
      b.addEventListener('click', () => {
        color2 = c;
        renderStyles(); updatePreview(); syncPattern();
      });
      grid.appendChild(b);
    }
  } catch { /* no palette - the color input still works */ }
  patAuto.addEventListener('change', () => {
    color2 = patAuto.checked ? null : color2Input.value;
    renderStyles(); updatePreview(); syncPattern();
  });
  color2Input.addEventListener('input', () => {
    color2 = color2Input.value;
    renderStyles(); updatePreview(); syncPattern();
  });

  const sw = $('swatches');
  const recents = (state.detail && state.detail.recentFlats) || [];
  if (recents.length) {
    const lbl = document.createElement('span');
    lbl.className = 'count';
    lbl.textContent = 'recent:';
    sw.appendChild(lbl);
    for (const c of recents) {
      const b = document.createElement('button');
      b.className = 'swatch' + (cur && cur.color.toLowerCase() === c.toLowerCase() ? ' sel' : '');
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        colorInput.value = c;
        sw.querySelectorAll('.swatch').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
        renderStyles();
        updatePreview();
        syncPattern();
      });
      sw.appendChild(b);
    }
  } else {
    const hint = document.createElement('span');
    hint.className = 'count';
    hint.textContent = 'Flat colors you use will show up here for quick re-picking.';
    sw.appendChild(hint);
  }
  colorInput.addEventListener('input', () => { color = colorInput.value; renderStyles(); updatePreview(); syncPattern(); });
  $('flatApply').addEventListener('click', () => {
    closeModal();
    const spec = { type: 'flat', color: colorInput.value, style };
    if (style !== 'solid' && color2) spec.color2 = color2;
    setSwap(t.name, spec);
  });
  renderStyles();
  updatePreview();
  syncPattern();

  // Quake-palette flats (ralle_colors) if this install has them
  const catalog = await ensureCatalog();
  const ralle = catalog.filter(c => c.name.startsWith('ralle_colors/'));
  if (ralle.length) {
    const fam = /^ralle_colors\/([a-z]+)(\d+)$/i;
    ralle.sort((a, b) => {
      const ma = fam.exec(a.name), mb = fam.exec(b.name);
      if (ma && mb) {
        return ma[1].localeCompare(mb[1]) || (Number(ma[2]) - Number(mb[2]));
      }
      return a.name.localeCompare(b.name);
    });
    const section = $('ralleSection');
    const head = document.createElement('div');
    head.className = 'sectionhead';
    head.textContent = `Quake palette — ralle_colors (${ralle.length})`;
    const ralleHint = document.createElement('p');
    ralleHint.className = 'mnote';
    updateRalleHint = () => {
      ralleHint.textContent = style === 'solid'
        ? 'Click a color to use it as-is (the original .wal file).'
        : `Click a color to use it with the "${style}" pattern (generated on the fly, same palette color).`;
    };
    updateRalleHint();
    const grid = document.createElement('div');
    grid.className = 'pickgrid';
    for (const c of ralle) {
      const cell = document.createElement('div');
      cell.className = 'pickcell' + (t.swap && t.swap.type === 'stock' && t.swap.to === c.name ? ' current' : '');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = thumbUrl({ tex: c.name, size: 64 });
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      const label = document.createElement('div');
      label.className = 'pname';
      label.textContent = c.name.slice('ralle_colors/'.length);
      cell.append(img, label);
      cell.addEventListener('click', async () => {
        if (style === 'solid') {
          closeModal();
          setSwap(t.name, { type: 'stock', to: c.name });
          return;
        }
        try {
          if (!img.complete || !img.naturalWidth) await img.decode();
          const picked = sampleImgColor(img);
          closeModal();
          const spec = { type: 'flat', color: picked, style };
          if (style !== 'solid' && color2) spec.color2 = color2;
          setSwap(t.name, spec);
        } catch {
          toast('Could not read that color yet - click again once its thumbnail has loaded', true);
        }
      });
      grid.appendChild(cell);
    }
    section.append(head, ralleHint, grid);
  }
}

async function openSkyPicker() {
  const d = state.detail;
  if (!d) return;
  openModal(`
    <div class="mhead">
      <h3>Skybox for <span class="mono">${d.name}</span> — original: <span class="mono">${d.sky || 'none'}</span></h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody">
      <div class="mtools">
        <input id="skySearch" type="search" placeholder="Search skyboxes…">
        <span class="count" id="skyCount"></span>
      </div>
      <div class="pickgrid" id="skyGrid"></div>
    </div>
    <div class="mfoot" id="skyFoot"></div>
  `);
  if (d.skySwap) {
    const rm = document.createElement('button');
    rm.className = 'danger';
    rm.textContent = 'Back to original skybox';
    rm.addEventListener('click', () => { closeModal(); setSky(null); });
    $('skyFoot').appendChild(rm);
  }
  const skies = await ensureSkies();
  const search = $('skySearch');
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const grid = $('skyGrid');
    grid.textContent = '';
    const matches = skies.filter(s => s.faces >= 5 && (!q || s.name.includes(q)));
    for (const s of matches.slice(0, 160)) {
      const cell = document.createElement('div');
      cell.className = 'pickcell' + (d.skySwap === s.name ? ' current' : '');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = thumbUrl({ sky: s.name, size: 96 });
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      const label = document.createElement('div');
      label.className = 'pname';
      label.textContent = s.name;
      cell.append(img, label);
      cell.addEventListener('click', () => { closeModal(); setSky(s.name); });
      grid.appendChild(cell);
    }
    $('skyCount').textContent = `${matches.length} skyboxes`;
  };
  search.addEventListener('input', render);
  render();
}

// ---------- wiring ----------

// ---------- texture library (standalone collections manager) ----------

function openTextureLibrary() {
  openModal(`
    <div class="mhead">
      <h3>📂 Texture collections</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody" id="libBody"><p style="color:var(--dim)">Loading textures…</p></div>
  `);
  buildTextureBrowser($('libBody'), { libraryMode: true })
    .catch(e => toast('Could not load textures: ' + e.message, true));
}

// ---------- lighting ----------

const LIGHT_CVARS = [
  { key: 'gl_modulate', label: 'Light boost (overall)', hint: '1 = stock, 2–3 = common comp values' },
  { key: 'gl_modulate_world', label: 'Light boost: world', hint: 'world geometry only' },
  { key: 'gl_modulate_entities', label: 'Light boost: models', hint: 'players, items, weapons' },
  { key: 'gl_brightness', label: 'Brightness (additive)', hint: 'default ~0.1; higher lifts dark areas' },
  { key: 'intensity', label: 'Texture intensity', hint: 'texture brightness multiplier' },
  { key: 'gl_saturation', label: 'Texture saturation', hint: '1 = full color, 0 = grayscale' },
  { key: 'gl_coloredlightmaps', label: 'Colored lightmaps', hint: '1 = colored lights, 0 = white' },
  { key: 'gl_dynamic', label: 'Dynamic lights', hint: '1 = on, 0 = off (muzzle flashes etc.)' },
  { key: 'gl_picmip', label: 'Texture detail reduction', hint: '0 = full detail; higher = blurrier' },
  { key: 'r_override_textures', label: 'Hi-res overrides', hint: '1 = allow png/tga/jpg replacements' },
  // r_texture_overrides (the category bitmask, e.g. 15/31) is parked until we
  // have solid documentation to explain it - use "extra cfg lines" meanwhile.
];

function buildLightForm(container, values, placeholders) {
  container.textContent = '';
  const inputs = {};
  for (const c of LIGHT_CVARS) {
    const row = document.createElement('div');
    row.className = 'lrow';
    const label = document.createElement('label');
    label.textContent = c.label;
    label.title = c.key;
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = values && values[c.key] !== undefined ? values[c.key] : '';
    input.placeholder = placeholders && placeholders[c.key] !== undefined ? 'global: ' + placeholders[c.key] : '';
    if (input.value !== '') input.classList.add('set');
    input.addEventListener('input', () => input.classList.toggle('set', input.value.trim() !== ''));
    const hint = document.createElement('span');
    hint.className = 'lhint';
    hint.textContent = `${c.key} — ${c.hint}`;
    row.append(label, input, hint);
    container.appendChild(row);
    inputs[c.key] = input;
  }
  return () => {
    const out = {};
    for (const [k, input] of Object.entries(inputs)) {
      const v = input.value.trim();
      if (v !== '') out[k] = v;
    }
    return out;
  };
}

// One dialog, two clearly-scoped tabs: global defaults vs this-map override.
async function openMissingFix() {
  const mf = { ...(state.scan.missingFix || { enabled: false, color: '#001f2b', style: 'grid', color2: '#774f17' }) };
  openModal(`
    <div class="mhead">
      <h3>🧱 Missing textures</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody">
      <p class="mnote">Maps often use textures your install doesn't have. Pick a stand-in style —
      the app shows it on every missing texture, and with the fix enabled it is applied
      <b>in game across all maps</b> too, so broken maps get a clean uniform look.
      Textures you swap yourself always win over this.</p>
      <p><label><input type="checkbox" id="mfEnabled"> <b>Apply in game across all maps</b></label></p>
      <div class="stylerow" id="mfStyles"></div>
      <div class="flatrow">
        <label>Base: <input type="color" id="mfColor" value="${mf.color}"></label>
        <img id="mfPreview" class="flatpreview" alt="preview">
        <button class="primary" id="mfSave">Save</button>
      </div>
      <div class="sectionhead">Pattern color</div>
      <div class="flatrow">
        <label><input type="checkbox" id="mfAuto"> auto (darker shade of the base)</label>
        <label>Custom: <input type="color" id="mfColor2"></label>
      </div>
      <p class="mnote" style="margin:6px 0 4px">…or pick from the Quake 2 palette:</p>
      <div class="palgrid" id="mfPal"></div>
    </div>
  `);
  $('mfEnabled').checked = mf.enabled;
  const colorInput = $('mfColor');
  const color2Input = $('mfColor2');
  const autoBox = $('mfAuto');

  const autoShade = () => {
    const v = colorInput.value;
    const [r, g, b] = [1, 3, 5].map(i => Math.max(0, parseInt(v.slice(i, i + 2), 16) - 28));
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  };
  const thumbParams = (s, size) => {
    const p = { flat: colorInput.value, style: s, size };
    if (mf.color2 && s !== 'solid') p.color2 = mf.color2;
    return p;
  };
  const sync = () => {
    autoBox.checked = !mf.color2;
    color2Input.value = mf.color2 || autoShade();
    $('mfPreview').src = thumbUrl(thumbParams(mf.style, 96));
    $('mfPal').querySelectorAll('.palswatch').forEach(x =>
      x.classList.toggle('sel', !!mf.color2 && x.dataset.c === mf.color2));
    const row = $('mfStyles');
    row.textContent = '';
    for (const s of FLAT_STYLES) {
      const b = document.createElement('button');
      b.className = 'stylebtn' + (s.id === mf.style ? ' sel' : '');
      const img = document.createElement('img');
      img.src = thumbUrl(thumbParams(s.id, 52));
      const label = document.createElement('span');
      label.textContent = s.label;
      b.append(img, label);
      b.addEventListener('click', () => { mf.style = s.id; sync(); });
      row.appendChild(b);
    }
  };
  try {
    const pal = await fetch(`/api/palette?dir=${encodeURIComponent(state.dir)}`).then(r => r.json());
    for (const c of pal.colors || []) {
      const b = document.createElement('button');
      b.className = 'palswatch';
      b.style.background = c;
      b.title = c;
      b.dataset.c = c;
      b.addEventListener('click', () => { mf.color2 = c; sync(); });
      $('mfPal').appendChild(b);
    }
  } catch { /* color input still works */ }
  colorInput.addEventListener('input', sync);
  autoBox.addEventListener('change', () => { mf.color2 = autoBox.checked ? null : color2Input.value; sync(); });
  color2Input.addEventListener('input', () => { mf.color2 = color2Input.value; sync(); });
  $('mfSave').addEventListener('click', async () => {
    try {
      const r = await apiPost('/api/missingfix', {
        enabled: $('mfEnabled').checked,
        color: colorInput.value,
        style: mf.style,
        color2: mf.color2,
      });
      state.scan.missingFix = r.missingFix;
      closeModal();
      bustThumbs();
      renderHook();
      if (state.detail) await selectMap(state.detail.name);
      toast(r.missingFix.enabled
        ? `Missing-texture fix is on - ${(r.written || []).length} cfg(s) updated, F9 in game to see it`
        : 'Missing-texture style saved (in-game fix is off)');
    } catch (e) {
      toast('Could not save: ' + e.message, true);
    }
  });
  sync();
}

function openLighting(startTab) {
  const L = state.scan.lighting || { manage: false, global: {}, extra: '' };
  const d = state.detail;
  const hasMap = Boolean(d);
  openModal(`
    <div class="mhead">
      <h3>Lighting</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="tabs">
      <button id="lTabGlobal">🌍 Global — all maps</button>
      ${hasMap ? `<button id="lTabMap">📍 Only <span class="mono">${d.name}</span></button>` : ''}
    </div>
    <div class="mbody">
      <div id="lgPane">
        <p class="scopenote global">These are your defaults for <b>every map</b>. A map with its own override uses its values instead.</p>
        <label class="lmanage"><input type="checkbox" id="lManage" ${L.manage ? 'checked' : ''}>
          <b>Apply these lighting settings in the game</b></label>
        <p class="lsubnote">ON: the values you type below are set on every map load (and F9) — globals first, map overrides on top.
        OFF: the app doesn't touch your game's lighting at all; your values stay saved here for later.
        The app never picks numbers by itself — it only applies what you enter.</p>
        <div class="lightform" id="lgForm"></div>
        <div class="sectionhead">Extra cfg lines (advanced)</div>
        <textarea id="lExtra" class="lextra" spellcheck="false"
          placeholder='e.g.  set gl_dlight_falloff "1"'>${L.extra || ''}</textarea>
      </div>
      ${hasMap ? `
      <div id="lmPane" class="hidden">
        <p class="scopenote map">This overrides your globals <b>only on ${d.name}</b>. Empty fields keep the global value (shown in grey).
        ${L.manage ? '' : '<br><b>Applying lighting is currently switched OFF — turn it on on the Global tab for any of this to reach the game.</b>'}</p>
        <div class="lightform" id="lmForm"></div>
      </div>` : ''}
    </div>
    <div class="mfoot">
      <span id="lgFoot">
        <button class="primary" id="lgSave">Save global defaults</button>
      </span>
      ${hasMap ? `
      <span id="lmFoot" class="hidden">
        <button class="danger" id="lmClear">Clear this map's override</button>
        <button class="primary" id="lmSave">Save override for ${d.name}</button>
      </span>` : ''}
    </div>
  `);

  const collectGlobal = buildLightForm($('lgForm'), L.global, null);
  const collectMap = hasMap ? buildLightForm($('lmForm'), d.lighting, L.global) : null;

  const setTab = tab => {
    $('lTabGlobal').classList.toggle('active', tab === 'global');
    $('lgPane').classList.toggle('hidden', tab !== 'global');
    $('lgFoot').classList.toggle('hidden', tab !== 'global');
    if (hasMap) {
      $('lTabMap').classList.toggle('active', tab === 'map');
      $('lmPane').classList.toggle('hidden', tab !== 'map');
      $('lmFoot').classList.toggle('hidden', tab !== 'map');
    }
  };
  $('lTabGlobal').addEventListener('click', () => setTab('global'));
  if (hasMap) $('lTabMap').addEventListener('click', () => setTab('map'));
  setTab(startTab === 'map' && hasMap ? 'map' : 'global');

  $('lgSave').addEventListener('click', async () => {
    const payload = {
      manage: $('lManage').checked,
      global: collectGlobal(),
      extra: $('lExtra').value,
    };
    closeModal();
    try {
      const r = await apiPost('/api/lighting', { lighting: payload });
      state.scan.lighting = r.lighting;
      renderHook();
      reportWritten(r);
      toast(r.lighting.manage
        ? 'Global lighting saved - applies on map load / F9'
        : 'Saved. Applying is OFF - the game\'s lighting is left alone until you switch it on');
      if (state.activeMap) selectMap(state.activeMap);
    } catch (e) {
      toast('Lighting save failed: ' + e.message, true);
    }
  });

  if (hasMap) {
    $('lmClear').addEventListener('click', async () => {
      closeModal();
      try {
        applyMutation(await apiPost('/api/maplighting', { map: d.name, lighting: null }));
        toast(`Lighting override cleared - ${d.name} uses the globals again`);
      } catch (e) { toast('Failed: ' + e.message, true); }
    });
    $('lmSave').addEventListener('click', async () => {
      closeModal();
      try {
        applyMutation(await apiPost('/api/maplighting', { map: d.name, lighting: collectMap() }));
        toast(`Lighting override for ${d.name} saved - F9 in game to apply`);
      } catch (e) { toast('Failed: ' + e.message, true); }
    });
  }
}

// ---------- folder browser & help ----------

async function openBrowser(startPath) {
  openModal(`
    <div class="mhead">
      <h3>Pick your AQ2 folder</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody">
      <div class="bpath" id="bPath"></div>
      <div class="browselist" id="bList"></div>
      <div class="bhint hidden" id="bHint">✓ This looks like an AQ2 install</div>
    </div>
    <div class="mfoot">
      <button id="bUp">⬆ Up one level</button>
      <button class="primary" id="bUse" disabled>Use this folder</button>
    </div>
  `);
  let current = null;
  let parent = null;

  const load = async p => {
    const url = new URL('/api/browse', location.origin);
    if (p) url.searchParams.set('path', p);
    let r;
    try {
      r = await fetch(url).then(async x => {
        const b = await x.json();
        if (!x.ok) throw new Error(b.error);
        return b;
      });
    } catch (e) {
      toast(e.message, true);
      return;
    }
    current = r.path;
    parent = r.parent;
    $('bPath').textContent = current || 'This PC — pick a drive';
    $('bHint').classList.toggle('hidden', !r.looksLikeInstall);
    $('bUse').disabled = !current;
    $('bUp').disabled = !parent && !current;
    const list = $('bList');
    list.textContent = '';
    for (const d of r.dirs) {
      const item = document.createElement('div');
      item.className = 'bitem';
      item.textContent = '📁 ' + d.name;
      item.addEventListener('click', () => load(d.path));
      list.appendChild(item);
    }
    if (!r.dirs.length) {
      const empty = document.createElement('div');
      empty.className = 'bitem';
      empty.style.cursor = 'default';
      empty.textContent = '(no subfolders)';
      list.appendChild(empty);
    }
  };

  $('bUp').addEventListener('click', () => load(parent));
  $('bUse').addEventListener('click', () => {
    if (!current) return;
    closeModal();
    $('dirInput').value = current;
    rescan(true);
  });
  await load(startPath || $('dirInput').value.trim() || null);
}

function openGuide() {
  const hookOk = state.scan && state.scan.hook && state.scan.hook.installed;
  const root = state.scan ? state.scan.root : '(no install scanned yet)';
  openModal(`
    <div class="mhead">
      <h3>📄 Readme — setup &amp; how to use</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody helpbody">
      <div class="sectionhead" style="margin-top:0;border-top:none;padding-top:0">1 · Point it at your AQ2 install</div>
      <p>The path box should hold your <b>AQ2 / AQtion folder</b> — the one containing
      <code>q2pro.exe</code> or <code>aqtion.exe</code> with <code>action</code> / <code>baseaq</code> inside
      (use <b>Browse…</b>). Pointing at a game subfolder also works. Currently scanned:
      <code>${root}</code></p>

      <div class="sectionhead">2 · Install the game hook (one time)</div>
      <p>${hookOk
        ? '✓ <b>Already installed.</b> One line in your autoexec.cfg makes the game apply your presets on every map load, and binds <b>F9</b> to re-apply.'
        : 'Not installed yet — click below. It adds one line to autoexec.cfg so the game applies your presets on every map load, and binds <b>F9</b> to re-apply.'}</p>
      ${hookOk ? '' : '<p><button class="primary" id="guideInstallHook">⚡ Install game hook</button></p>'}

      <div class="sectionhead">3 · Swap textures</div>
      <p>Pick a map, click any texture card. Choose a <b>stock texture</b> (search, filter by
      collection or by map), a <b>flat/pattern color</b> (incl. the ralle_colors palette),
      or <b>your own image</b>. Click the skybox card to change the sky.
      <b>🧱 Missing tex</b> (top bar) picks a stand-in style for textures your install
      lacks and can apply it in game across all maps at once.</p>

      <div class="sectionhead">4 · See your changes</div>
      <p>In the game: changes auto-apply on every map load — mid-map, just press <b>F9</b>.
      <b>🎮 View in game</b> launches the game on the current map.
      <b>🧊 3D view</b> previews in-app: drag to look, <b>WASD</b> + <b>Q/E</b> to fly,
      <b>Shift</b> fast, click a wall to swap its texture. The <b>gl_modulate</b> and
      <b>gl_brightness</b> sliders preview the same lighting cvars the game uses.</p>

      <div class="sectionhead">5 · Presets &amp; sharing</div>
      <p><b>Save as preset…</b> keeps named setups per map (chips to switch).
      <b>Export…</b> writes a <code>.aq2swap.json</code> file to send to friends — they use
      <b>Import preset…</b>. Custom images travel inside the file.</p>

      <div class="sectionhead">6 · Collections &amp; favorites</div>
      <p>In <b>📂 Collections</b> (or any picker): ★ marks favorites, ＋ files textures into
      named collections ("great bricks"…), and the dropdown filters by them. The
      <i>on map…</i> box shows only textures used by one map.</p>

      <div class="sectionhead">7 · Lighting</div>
      <p><b>Lighting</b> manages gl_modulate &amp; co. — global defaults for all maps plus
      per-map overrides. Nothing applies until you tick "Apply these lighting settings in the game".</p>

      <div class="sectionhead">8 · Safety</div>
      <p>Game-side files live in <code>&lt;install&gt;\\texswap\\</code> plus one autoexec line —
      shipped game files are never touched. Your presets, collections and custom images are
      kept safely in your Windows user profile, so they <b>survive game reinstalls</b>:
      after a reinstall, just install the hook again and everything regenerates.
      <b>Reset map</b> reverts a map, <b>Swaps: ON/OFF</b> parks everything at stock.</p>
    </div>
  `);
  const ih = document.getElementById('guideInstallHook');
  if (ih) ih.addEventListener('click', () => { closeModal(); installHook(); });
}

$('aboutBtn').addEventListener('click', () => {
  openModal(`
    <div class="mhead">
      <h3>About</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody" style="text-align:center">
      <img src="logo2-ui.png" alt="Ralle's AQ2 Texture Swapper" style="width:min(420px,80%);border-radius:14px;margin:6px 0 14px">
      <p style="font-size:15px;font-weight:650">Ralle's AQ2 Texture Swapper</p>
      <p class="mnote" style="margin-top:4px">Restyle any AQ2/AQtion map — swap textures &amp; skyboxes, tune lighting,
      save per-map presets and share them with friends. Powered by q2pro's <span class="mono">link</span> command.</p>
    </div>
  `);
});
$('browseBtn').addEventListener('click', () => openBrowser());
$('guideBtn').addEventListener('click', openGuide);
$('setupHookBtn').addEventListener('click', installHook);
$('setupMoreBtn').addEventListener('click', openGuide);
$('rescanBtn').addEventListener('click', () => rescan(true));
$('dirInput').addEventListener('keydown', e => { if (e.key === 'Enter') rescan(true); });
$('mapSearch').addEventListener('input', renderMapList);
$('texSearch').addEventListener('input', renderGrid);
$('sortSel').addEventListener('change', renderGrid);
$('showUtility').addEventListener('change', renderGrid);
$('lowRes').checked = state.res === 'low';
$('lowRes').addEventListener('change', () => {
  state.res = $('lowRes').checked ? 'low' : 'hi';
  localStorage.setItem('aq2ts.res', state.res);
  if (state.activeMap) selectMap(state.activeMap);
});
$('skyCard').addEventListener('click', openSkyPicker);
$('resetMapBtn').addEventListener('click', resetMap);
$('mapLightBtn').addEventListener('click', () => openLighting('map'));
$('importFile').addEventListener('change', e => {
  if (e.target.files.length) importPresetFile(e.target.files[0]);
  e.target.value = '';
});
$('view3dBtn').addEventListener('click', () => {
  if (!state.detail) return;
  if (window.AQViewer) window.AQViewer.open(state.detail);
  else toast('3D viewer failed to load', true);
});
$('gameBtn').addEventListener('click', async () => {
  if (!state.detail) return;
  try {
    const r = await apiPost('/api/launchgame', { map: state.detail.name });
    toast(`Launched ${r.exe.split('\\').pop()} on ${state.detail.name} — presets auto-apply on load, F9 re-applies after changes`);
  } catch (e) {
    toast('Launch failed: ' + e.message, true);
  }
});

// bridge for the viewer module
window.AQTS = {
  state,
  thumbUrl,
  swapThumbUrl,
  toast,
  openPickerByName: name => {
    const t = state.detail && state.detail.textures.find(x => x.name === name);
    if (t) openPicker(t);
    else toast('Texture not found on this map: ' + name, true);
  },
};

boot();
