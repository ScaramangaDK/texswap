// UI logic for milestone 2: browse maps/textures, swap textures & skyboxes,
// applied to the game via generated link-cfgs.
const $ = id => document.getElementById(id);

const SWATCHES = ['#c8ccd2', '#9aa0a8', '#6b7178', '#3f434a', '#ffffff', '#101010',
  '#ff8c1a', '#3fa7ff', '#ff5d5d', '#41d97e'];

const state = {
  dir: localStorage.getItem('aq2ts.dir') || '',
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
    body: JSON.stringify({ dir: state.dir, ...body }),
  }).then(async r => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  });
}

function thumbUrl(params) {
  const url = new URL('/api/thumb', location.origin);
  url.searchParams.set('dir', state.dir);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function swapThumbUrl(spec, size) {
  if (spec.type === 'flat') return thumbUrl({ flat: spec.color, style: spec.style || 'solid', size });
  return thumbUrl({ tex: spec.to, size });
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
  await rescan(false);
}

async function rescan(refresh) {
  state.dir = $('dirInput').value.trim();
  localStorage.setItem('aq2ts.dir', state.dir);
  state.catalog = null;
  state.skies = null;
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

  if (state.scan.hook.installed) {
    const chip = document.createElement('span');
    chip.className = 'hookchip ok';
    chip.textContent = '✓ game hook installed';
    chip.title = state.scan.hook.autoexec;
    area.appendChild(chip);
  } else {
    const btn = document.createElement('button');
    btn.textContent = 'Install game hook';
    btn.title = 'Adds one line to autoexec.cfg so the game applies your presets on every map load (and binds F9 to re-apply).';
    btn.addEventListener('click', installHook);
    area.appendChild(btn);
  }

  const toggle = document.createElement('button');
  const on = state.scan.swapsEnabled !== false;
  toggle.textContent = on ? 'Swaps: ON' : 'Swaps: OFF';
  toggle.className = on ? '' : 'off';
  toggle.title = on
    ? 'Click to disable all swaps (presets are kept; maps load stock)'
    : 'All swaps are disabled - click to re-enable your presets';
  toggle.addEventListener('click', toggleEnabled);
  area.appendChild(toggle);

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
  $('mapCount').textContent = q ? `${shown}/${maps.length}` : `${maps.length}`;
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
    state.detail = await apiGet('/api/map', { name });
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
  resetBtn.classList.toggle('hidden', !d.swapCount);
  resetBtn.textContent = `Reset map (${d.swapCount})`;

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
    const mainSrc = t.swap ? swapThumbUrl(t.swap, 128) : (t.missing ? null : thumbUrl({ tex: t.name }));
    if (!mainSrc) {
      wrap.innerHTML = '<span class="missing">no image file</span>';
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
      if (!t.missing) {
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
    const meta = document.createElement('div');
    meta.className = 'tmeta';
    const dims = t.missing ? 'missing' : `${t.w}×${t.h} ${t.ext.slice(1)}`;
    meta.textContent = t.swap
      ? (t.swap.type === 'flat' ? `→ flat ${t.swap.color}` : `→ ${t.swap.to}`)
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
  switchTab(t, t.swap && t.swap.type === 'flat' ? 'flat' : 'stock');
}

function switchTab(t, tab) {
  $('tabStock').classList.toggle('active', tab === 'stock');
  $('tabFlat').classList.toggle('active', tab === 'flat');
  if (tab === 'stock') renderStockTab(t);
  else renderFlatTab(t);
}

async function renderStockTab(t) {
  const body = $('mbody');
  body.innerHTML = `
    <div class="mtools">
      <input id="pickSearch" type="search" placeholder="Search textures…">
      <span class="count" id="pickCount"></span>
    </div>
    <div class="pickgrid" id="pickGrid"></div>
  `;
  const catalog = await ensureCatalog();
  const search = $('pickSearch');
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const grid = $('pickGrid');
    grid.textContent = '';
    const matches = catalog.filter(c => c.name !== t.name && (!q || c.name.includes(q)));
    for (const c of matches.slice(0, 240)) {
      const cell = document.createElement('div');
      cell.className = 'pickcell' + (t.swap && t.swap.type === 'stock' && t.swap.to === c.name ? ' current' : '');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = thumbUrl({ tex: c.name, size: 96 });
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      const label = document.createElement('div');
      label.className = 'pname';
      label.textContent = c.name;
      cell.append(img, label);
      cell.addEventListener('click', () => {
        closeModal();
        setSwap(t.name, { type: 'stock', to: c.name });
      });
      grid.appendChild(cell);
    }
    $('pickCount').textContent = matches.length > 240
      ? `showing 240 of ${matches.length} — refine search`
      : `${matches.length} textures`;
  };
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

async function renderFlatTab(t) {
  const cur = t.swap && t.swap.type === 'flat' ? t.swap : null;
  let color = cur ? cur.color : '#9aa0a8';
  let style = cur && cur.style ? cur.style : 'solid';
  const body = $('mbody');
  body.innerHTML = `
    <p style="color:var(--dim);margin-bottom:12px">Replace with a generated flat texture — great for visibility. Patterns add subtle lines so you can still judge distance and speed.</p>
    <div class="stylerow" id="styleRow"></div>
    <div class="swatches" id="swatches"></div>
    <div class="flatrow">
      <label>Custom: <input type="color" id="flatColor" value="${color}"></label>
      <img id="flatPreview" class="flatpreview" alt="preview">
      <button class="primary" id="flatApply">Use this</button>
    </div>
    <div id="ralleSection"></div>
  `;
  const colorInput = $('flatColor');
  const preview = $('flatPreview');
  const styleRow = $('styleRow');

  const renderStyles = () => {
    styleRow.textContent = '';
    for (const s of FLAT_STYLES) {
      const b = document.createElement('button');
      b.className = 'stylebtn' + (s.id === style ? ' sel' : '');
      const img = document.createElement('img');
      img.src = thumbUrl({ flat: colorInput.value, style: s.id, size: 52 });
      const label = document.createElement('span');
      label.textContent = s.label;
      b.append(img, label);
      b.addEventListener('click', () => { style = s.id; renderStyles(); updatePreview(); });
      styleRow.appendChild(b);
    }
  };
  const updatePreview = () => {
    preview.src = thumbUrl({ flat: colorInput.value, style, size: 96 });
  };

  const sw = $('swatches');
  for (const c of SWATCHES) {
    const b = document.createElement('button');
    b.className = 'swatch' + (cur && cur.color.toLowerCase() === c ? ' sel' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      colorInput.value = c;
      sw.querySelectorAll('.swatch').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      renderStyles();
      updatePreview();
    });
    sw.appendChild(b);
  }
  colorInput.addEventListener('input', () => { renderStyles(); updatePreview(); });
  $('flatApply').addEventListener('click', () => {
    closeModal();
    setSwap(t.name, { type: 'flat', color: colorInput.value, style });
  });
  renderStyles();
  updatePreview();

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
      cell.addEventListener('click', () => {
        closeModal();
        setSwap(t.name, { type: 'stock', to: c.name });
      });
      grid.appendChild(cell);
    }
    section.append(head, grid);
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

function openHelp() {
  openModal(`
    <div class="mhead">
      <h3>Which folder should the path point to?</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody helpbody">
      <p>Point it at your <b>AQ2 / AQtion install folder</b> — the one that contains
      <code>q2pro.exe</code> or <code>aqtion.exe</code>, with subfolders like
      <code>action</code> and <code>baseaq</code> inside.</p>
      <p>Example: <code>C:\\AQ2mapping\\AQ2</code></p>
      <p>Pointing directly at a game folder (<code>…\\action</code> or <code>…\\baseaq</code>)
      also works — the app finds the install root by itself.</p>
      <p>After changing the path, click <b>Rescan</b>. The app reads your maps and textures
      from there, and writes its swap files into that install's <code>texswap</code> folder.</p>
    </div>
  `);
}

$('browseBtn').addEventListener('click', () => openBrowser());
$('helpBtn').addEventListener('click', openHelp);
$('rescanBtn').addEventListener('click', () => rescan(true));
$('dirInput').addEventListener('keydown', e => { if (e.key === 'Enter') rescan(true); });
$('mapSearch').addEventListener('input', renderMapList);
$('texSearch').addEventListener('input', renderGrid);
$('sortSel').addEventListener('change', renderGrid);
$('showUtility').addEventListener('change', renderGrid);
$('skyCard').addEventListener('click', openSkyPicker);
$('resetMapBtn').addEventListener('click', resetMap);
$('importFile').addEventListener('change', e => {
  if (e.target.files.length) importPresetFile(e.target.files[0]);
  e.target.value = '';
});

boot();
