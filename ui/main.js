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

  renderGrid();
  syncMapListEntry();
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

function renderFlatTab(t) {
  const cur = t.swap && t.swap.type === 'flat' ? t.swap : null;
  const body = $('mbody');
  body.innerHTML = `
    <p style="color:var(--dim);margin-bottom:12px">Replace with a generated flat texture — great for visibility. “Grid” adds subtle lines so you can still judge distance and speed.</p>
    <div class="swatches" id="swatches"></div>
    <div class="flatrow">
      <label>Custom: <input type="color" id="flatColor" value="${cur ? cur.color : '#9aa0a8'}"></label>
      <label><input type="radio" name="flatstyle" value="solid" ${!cur || cur.style !== 'grid' ? 'checked' : ''}> solid</label>
      <label><input type="radio" name="flatstyle" value="grid" ${cur && cur.style === 'grid' ? 'checked' : ''}> grid</label>
      <img id="flatPreview" class="flatpreview" alt="preview">
      <button class="primary" id="flatApply">Use this</button>
    </div>
  `;
  const colorInput = $('flatColor');
  const preview = $('flatPreview');
  const styleOf = () => body.querySelector('input[name=flatstyle]:checked').value;
  const updatePreview = () => {
    preview.src = thumbUrl({ flat: colorInput.value, style: styleOf(), size: 96 });
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
      updatePreview();
    });
    sw.appendChild(b);
  }
  colorInput.addEventListener('input', updatePreview);
  body.querySelectorAll('input[name=flatstyle]').forEach(r => r.addEventListener('change', updatePreview));
  $('flatApply').addEventListener('click', () => {
    closeModal();
    setSwap(t.name, { type: 'flat', color: colorInput.value, style: styleOf() });
  });
  updatePreview();
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

$('rescanBtn').addEventListener('click', () => rescan(true));
$('dirInput').addEventListener('keydown', e => { if (e.key === 'Enter') rescan(true); });
$('mapSearch').addEventListener('input', renderMapList);
$('texSearch').addEventListener('input', renderGrid);
$('sortSel').addEventListener('change', renderGrid);
$('showUtility').addEventListener('change', renderGrid);
$('skyCard').addEventListener('click', openSkyPicker);
$('resetMapBtn').addEventListener('click', resetMap);

boot();
