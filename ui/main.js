// UI logic for milestone 1: scan install, browse maps, browse ranked textures.
const $ = id => document.getElementById(id);

const state = {
  dir: localStorage.getItem('aq2ts.dir') || '',
  scan: null,
  detail: null,
  activeMap: null,
};

function api(path, params = {}) {
  const url = new URL(path, location.origin);
  url.searchParams.set('dir', state.dir);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url).then(async r => {
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  });
}

function thumbUrl(params) {
  const url = new URL('/api/thumb', location.origin);
  url.searchParams.set('dir', state.dir);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function showBanner(msg) {
  const b = $('banner');
  if (!msg) { b.classList.add('hidden'); return; }
  b.textContent = msg;
  b.classList.remove('hidden');
}

async function boot() {
  if (!state.dir) {
    try {
      const d = await fetch('/api/defaults').then(r => r.json());
      state.dir = d.dir;
    } catch { state.dir = ''; }
  }
  $('dirInput').value = state.dir;
  await rescan(false);
}

async function rescan(refresh) {
  state.dir = $('dirInput').value.trim();
  localStorage.setItem('aq2ts.dir', state.dir);
  showBanner(null);
  $('empty').classList.remove('hidden');
  $('mapView').classList.add('hidden');
  $('empty').firstElementChild.textContent = 'Scanning ' + state.dir + ' …';
  try {
    state.scan = await api('/api/scan', refresh ? { refresh: 1 } : {});
  } catch (e) {
    state.scan = null;
    renderMapList();
    $('empty').firstElementChild.textContent = 'Scan failed.';
    showBanner('Scan failed: ' + e.message);
    return;
  }
  const warn = [];
  if (!state.scan.hasPalette) warn.push('colormap.pcx not found — .wal textures cannot be decoded.');
  warn.push(...state.scan.warnings);
  showBanner(warn.length ? warn.join('\n') : null);
  renderMapList();
  $('empty').firstElementChild.textContent =
    `Found ${state.scan.maps.length} maps in ${state.scan.sources.length} archives — pick one on the left.`;
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
    const src = m.source === 'loose' ? 'loose file' : m.source;
    li.innerHTML = `
      <div class="mname"></div>
      <div class="mtitle"></div>
      <div class="msrc"></div>`;
    li.children[0].textContent = m.name;
    li.children[1].textContent = m.error ? m.error : (m.title || '—');
    li.children[2].textContent = m.error ? '' : `${m.textureCount} textures · ${src}`;
    li.addEventListener('click', () => selectMap(m.name));
    ul.appendChild(li);
  }
  $('mapCount').textContent = q ? `${shown}/${maps.length}` : `${maps.length}`;
}

async function selectMap(name) {
  state.activeMap = name;
  for (const li of $('mapList').children) {
    li.classList.toggle('active', li.dataset.map === name);
  }
  try {
    state.detail = await api('/api/map', { name });
  } catch (e) {
    showBanner(`Could not read map ${name}: ${e.message}`);
    return;
  }
  showBanner(null);
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

  if (d.sky) {
    $('skyCard').classList.remove('hidden');
    $('skyName').textContent = d.sky;
    $('skyThumb').src = thumbUrl({ sky: d.sky });
  } else {
    $('skyCard').classList.remove('hidden');
    $('skyName').textContent = '(engine default)';
    $('skyThumb').removeAttribute('src');
  }
  renderGrid();
}

function renderGrid() {
  const d = state.detail;
  const grid = $('grid');
  grid.textContent = '';
  if (!d) return;

  const q = $('texSearch').value.trim().toLowerCase();
  const showUtility = $('showUtility').checked;
  const sort = $('sortSel').value;

  let list = d.textures.filter(t => (showUtility || !t.utility) && (!q || t.name.includes(q)));
  if (sort === 'faces') list = [...list].sort((a, b) => b.faces - a.faces);
  else if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  const maxPct = Math.max(0.01, ...list.map(t => t.areaPct));

  for (const t of list) {
    const card = document.createElement('div');
    card.className = 'card';

    const wrap = document.createElement('div');
    wrap.className = 'imgwrap';
    if (t.missing) {
      wrap.innerHTML = '<span class="missing">no image file</span>';
    } else {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = thumbUrl({ tex: t.name });
      img.alt = t.name;
      img.addEventListener('error', () => {
        wrap.innerHTML = '<span class="missing">decode failed</span>';
      });
      wrap.appendChild(img);
    }
    card.appendChild(wrap);

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
    meta.textContent = `${dims} · ${t.faces} faces · ${t.areaPct}%`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('span');
    fill.style.width = Math.round(t.areaPct / maxPct * 100) + '%';
    bar.appendChild(fill);
    info.append(nameEl, meta, bar);
    card.appendChild(info);
    grid.appendChild(card);
  }

  $('texCount').textContent = `${list.length} textures`;
}

$('rescanBtn').addEventListener('click', () => rescan(true));
$('dirInput').addEventListener('keydown', e => { if (e.key === 'Enter') rescan(true); });
$('mapSearch').addEventListener('input', renderMapList);
$('texSearch').addEventListener('input', renderGrid);
$('sortSel').addEventListener('change', renderGrid);
$('showUtility').addEventListener('change', renderGrid);

boot();
