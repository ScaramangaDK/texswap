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
let THUMB_V = '4';
function bustThumbs() {
  THUMB_V = '4-' + Date.now();
}
function thumbUrl(params) {
  const url = new URL('/api/thumb', location.origin);
  // the missing-fix state is part of the URL: toggling or restyling the fix
  // re-fetches every placeholder instantly instead of trusting a stale cache
  const mf = (state.scan && state.scan.missingFix) || {};
  const mfTok = mf.enabled
    ? 'f' + String(mf.color + (mf.style || '') + (mf.color2 || '') + (mf.scale || 1)).replace(/#/g, '')
    : 'off';
  url.searchParams.set('v', THUMB_V + '-' + mfTok);
  url.searchParams.set('dir', state.dir);
  url.searchParams.set('res', state.res);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function swapThumbUrl(spec, size, name = '') {
  if (spec.type === 'upscale') return thumbUrl({ upscale: name, factor: spec.factor || 4, size, src: spec.src === 'low' ? 'low' : 'auto', model: spec.model === 'smooth' ? 'smooth' : 'detail', grain: spec.grain || 0 });
  if (spec.type === 'flat') {
    const p = { flat: spec.color, style: spec.style || 'solid', size };
    if (spec.color2) p.color2 = spec.color2;
    if (spec.scale) p.scale = spec.scale;
    return thumbUrl(p);
  }
  if (spec.type === 'custom') return thumbUrl({ custom: spec.file, size });
  if (spec.type === 'invisible') return null;
  return thumbUrl({ tex: spec.to, size });
}

function swapLabel(spec) {
  switch (spec.type) {
    case 'flat': return `→ flat ${spec.color}${spec.style && spec.style !== 'solid' ? ` · ${spec.style}${spec.scale && spec.scale !== 1 ? ` ${spec.scale}×` : ''}${spec.color2 ? ' ' + spec.color2 : ''}` : ''}`;
    case 'custom': return `→ your image${spec.w ? ` (${spec.w}×${spec.h})` : ''}`;
    case 'upscale': return `→ AI upscaled ${spec.factor || 4}x${spec.model === 'smooth' ? ' smooth' : ''}${spec.grain ? ' · grain ' + spec.grain + '%' : ''}${spec.src === 'low' ? ' from the original .wal' : ''}${state.res === 'low' ? ' - not in low-res mode, showing the .wal' : ' (hi-res mode)'}`;
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

// warnings the user has dismissed stay hidden until their text changes
// (a broken archive would otherwise greet them on every single start)
function hiddenWarnings() {
  try { return new Set(JSON.parse(localStorage.getItem('aq2ts.hiddenWarnings') || '[]')); } catch { return new Set(); }
}
function renderWarnings(list) {
  const b = $('banner');
  const hidden = hiddenWarnings();
  const show = list.filter(w => !hidden.has(w));
  if (!show.length) { b.classList.add('hidden'); return; }
  b.textContent = '';
  b.classList.remove('hidden');
  for (const w of show) {
    const row = document.createElement('div');
    row.className = 'warnrow';
    const span = document.createElement('span');
    span.textContent = w;
    const x = document.createElement('button');
    x.className = 'warnclose';
    x.textContent = '✕';
    x.title = 'Hide this warning - it stays hidden unless the message changes';
    x.addEventListener('click', () => {
      const h = [...hiddenWarnings().add(w)].slice(-50);
      localStorage.setItem('aq2ts.hiddenWarnings', JSON.stringify(h));
      renderWarnings(list);
    });
    row.append(span, x);
    b.appendChild(row);
  }
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
  // thumbs are browser-cached long-term; a manual rescan means files may
  // have changed on disk, so force fresh thumb URLs
  if (refresh) bustThumbs();
  const oldDl = document.getElementById('mapNamesData');
  if (oldDl) oldDl.remove();
  showBanner(null);
  $('empty').classList.remove('hidden');
  $('mapView').classList.add('hidden');
  $('empty').firstElementChild.textContent = 'Scanning ' + state.dir + ' …';
  try {
    let r = await apiGet('/api/scan', refresh ? { refresh: 1 } : {});
    while (r.scanning) {
      const p = r.progress || {};
      $('empty').firstElementChild.textContent = p.total
        ? `Scanning maps… ${p.done} / ${p.total}`
        : 'Scanning ' + state.dir + ' …';
      $('mapSearch').placeholder = p.total ? `Scanning… ${p.done} / ${p.total}` : 'Scanning…';
      await new Promise(res => setTimeout(res, 400));
      r = await apiGet('/api/scan', {});
    }
    state.scan = r;
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
  renderWarnings(warn);
  renderGameBadge();
  renderMapList();
  renderHook();
  $('mapSearch').placeholder = `Search ${state.scan.maps.length} maps…`;
  if (state.scan.version) $('verInfo').textContent = 'TexSwap v' + state.scan.version;
  $('empty').firstElementChild.textContent =
    `${state.scan.maps.length} maps in ${state.scan.gameDirs.join(' + ')} — pick one on the left.`;
  if (state.activeMap && state.scan.maps.some(m => m.name === state.activeMap)) {
    selectMap(state.activeMap);
  }
}

// Which game this install is, plus the Q2 mod switcher (a Q2 install runs
// ONE mod layered over baseq2; switching re-scans with that layering).
function renderGameBadge() {
  const badge = $('gameBadge');
  const sel = $('modSel');
  const s = state.scan;
  if (!s) { badge.classList.add('hidden'); sel.classList.add('hidden'); return; }
  const label = s.game === 'aq2' ? 'AQ2 / AQtion' : s.game === 'q2' ? 'Quake 2' : null;
  badge.textContent = label || '';
  badge.classList.toggle('hidden', !label);
  const showSel = s.game === 'q2' && (s.mods || []).length > 0;
  sel.classList.toggle('hidden', !showSel);
  if (showSel) {
    sel.textContent = '';
    const base = document.createElement('option');
    base.value = '';
    base.textContent = 'baseq2 (no mod)';
    sel.appendChild(base);
    for (const m of s.mods) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = 'mod: ' + m;
      sel.appendChild(o);
    }
    sel.value = s.activeMod || '';
    sel.onchange = async () => {
      try {
        await apiPost('/api/setmod', { mod: sel.value || null });
        toast(sel.value ? `Switched to mod "${sel.value}" (over baseq2)` : 'Switched to plain baseq2');
        await rescan(false);
      } catch (e) {
        toast('Could not switch mod: ' + e.message, true);
      }
    };
  }
}

function renderHook() {
  const area = $('hookArea');
  const share = $('shareArea');
  area.textContent = '';
  share.textContent = '';
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

  // AI upscale cache: warn once per session past 1 GB (the dialog has Clear unused)
  const uc = state.scan.upscaleCache;
  if (uc && uc.bytes > 1073741824 && !window.__upCacheWarned) {
    window.__upCacheWarned = true;
    toast(`AI upscale cache is ${(uc.bytes / 1073741824).toFixed(1)} GB${uc.unusedBytes ? ` (${(uc.unusedBytes / 1048576).toFixed(0)} MB unused)` : ''} - open ✨ AI upscale… on any map to clear unused files`, true);
  }


  const miss = document.createElement('button');
  const mfOn = state.scan.missingFix && state.scan.missingFix.enabled;
  miss.innerHTML = mfOn ? '🧱 Missing tex<span class="dot"></span>' : '🧱 Missing tex';
  miss.title = mfOn
    ? 'Missing-texture fix is ON - every texture your install lacks gets your chosen style in game'
    : 'Choose a style for textures your install lacks, and apply it in game across all maps';
  miss.addEventListener('click', openMissingFix);
  area.appendChild(miss);

  const imp = document.createElement('button');
  imp.textContent = '📥 Import preset…';
  imp.title = 'Load a .aq2swap.json or .aq2pack.json file from a friend';
  imp.addEventListener('click', () => $('importFile').click());
  share.appendChild(imp);

  const pack = document.createElement('button');
  pack.textContent = '🎁 Export pack…';
  pack.title = 'Bundle the texture swaps of every map you have customized into one shareable file (sky and lighting stay personal)';
  pack.addEventListener('click', openExportPack);
  share.appendChild(pack);
}

async function openExportPack() {
  let maps;
  try {
    maps = (await apiPost('/api/exportpack', { list: true })).maps;
  } catch (e) {
    toast('Could not list maps: ' + e.message, true);
    return;
  }
  if (!maps.length) {
    toast('Nothing to pack yet - swap some textures first', true);
    return;
  }
  openModal(`
    <div class="mhead">
      <h3>🎁 Export team pack</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody">
      <p class="mnote">One file with the <b>texture swaps</b> of the selected maps — friends load it
      with <b>Import preset…</b> Click the maps you want in the pack.</p>
      <div class="mfgrid">
        <span class="mflbl">Maps</span>
        <div>
          <div class="packchips">${maps.map(m =>
    `<span class="badge packbadge${m === (state.detail && state.detail.name) ? ' sel' : ''}" data-map="${m}">${m}</span>`).join('')}</div>
          <label class="packopt"><input type="checkbox" id="packAll"> select all (${maps.length})</label>
        </div>
        <span class="mflbl">Pack name</span>
        <div>
          <input id="packName" class="namefield" maxlength="48" placeholder="empty = auto (map + loaded preset name)">
          <label class="packopt" title="Off: receivers keep their own sky and lighting on these maps">
            <input type="checkbox" id="packStyle"> include my sky &amp; lighting (full style export)</label>
        </div>
      </div>
      <div class="mfoot">
        <button class="primary" id="packGo"></button>
      </div>
    </div>
  `);
  const go = $('packGo');
  const all = $('packAll');
  const chips = [...document.querySelectorAll('.packbadge')];
  const selected = () => chips.filter(b => b.classList.contains('sel')).map(b => b.dataset.map);
  const syncGo = () => {
    const n = selected().length;
    go.textContent = `Create pack (${n} map${n === 1 ? '' : 's'})`;
    go.disabled = n === 0;
    all.checked = n === maps.length;
  };
  chips.forEach(b =>
    b.addEventListener('click', () => { b.classList.toggle('sel'); syncGo(); }));
  all.addEventListener('change', () => {
    chips.forEach(b => b.classList.toggle('sel', all.checked));
    syncGo();
  });
  syncGo();
  go.addEventListener('click', async () => {
    try {
      const r = await apiPost('/api/exportpack', { maps: selected(), name: $('packName').value.trim(), style: $('packStyle').checked });
      closeModal();
      exportDoneModal(`Team pack with <b>${r.count} map${r.count === 1 ? '' : 's'}</b> created.`, r.file);
    } catch (e) {
      toast('Pack failed: ' + e.message, true);
    }
  });
  $('packName').addEventListener('keydown', e => { if (e.key === 'Enter' && !go.disabled) go.click(); });
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
    for (const w of (r.warnings || []).slice(0, 6)) toast(w, true);
    if (r.pack) {
      toast(`Imported team pack: texture swaps for ${r.count} map${r.count === 1 ? '' : 's'}`);
      if (state.detail && r.maps && r.maps.includes(state.detail.name)) {
        await selectMap(state.detail.name);
      }
    } else {
      toast(`Imported preset for "${r.map}"`);
      if (state.scan && state.scan.maps.some(m => m.name === r.map)) {
        await selectMap(r.map);
      }
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
  lightBtn.innerHTML = `<img class="atimg" src="btn-lighting.png" alt="Map lighting">${d.lighting ? '<span class="dot atdot"></span>' : ''}`;
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
      // loading replaces the working state - never silently over changes
      if (d.swapCount > 0 && !confirm(
        `Load preset "${name}"?\n\nThis REPLACES the current swaps on ${d.name}. ` +
        'Changes you have not saved as a preset will be lost.')) return;
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

}

function openSavePreset() {
  const d = state.detail;
  openModal(`
    <div class="mhead">
      <h3>Save preset for <span class="mono">${d.name}</span></h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody">
      <p style="color:var(--dim);margin-bottom:10px">Saves the current ${d.swapCount} swap(s) under a name you can reload anytime.
      Presets are snapshots — later changes are NOT saved into them until you save again (same name = update).</p>
      <input id="presetName" class="namefield" maxlength="24" placeholder="e.g. comp, bright, chill…"
        value="${d.activePreset || ''}">
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

// Centered confirmation with the full path - a corner toast is gone before
// anyone can read where the file went.
function exportDoneModal(what, file) {
  openModal(`
    <div class="mhead">
      <h3>📦 Export complete</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody">
      <p class="mnote">${what} Send the file to your friends — they load it with <b>Import preset…</b></p>
      <p class="mono exportpath" id="expPath">${file}</p>
    </div>
    <div class="mfoot">
      <button id="expCopy">📋 Copy path</button>
      <button id="expReveal">📂 Show in folder</button>
      <button class="primary" id="expClose">Close</button>
    </div>
  `);
  $('expClose').addEventListener('click', closeModal);
  $('expCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(file);
      toast('Path copied to clipboard');
    } catch {
      const rng = document.createRange();
      rng.selectNodeContents($('expPath'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(rng);
      toast('Could not copy automatically — the path is selected, press Ctrl+C', true);
    }
  });
  $('expReveal').addEventListener('click', () =>
    apiPost('/api/reveal', { file }).catch(e => toast('Could not open folder: ' + e.message, true)));
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
    // an AI upscale only exists in hi-res mode: the low-res preview shows
    // the .wal the game really reads there
    const upscaleHidden = t.swap && t.swap.type === 'upscale' && state.res === 'low';
    const mainSrc = t.swap && !upscaleHidden ? swapThumbUrl(t.swap, 128, t.name) : thumbUrl({ tex: t.name });
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
      const selfResize = t.swap.type === 'stock' && t.swap.to === t.name;
      const sc = t.swap.scale && t.swap.scale !== 1 ? t.swap.scale + 'x' : '';
      const tag = document.createElement('span');
      tag.className = 'swaptag';
      tag.textContent = t.swap.type === 'flat' ? 'FLAT'
        : t.swap.type === 'upscale' ? `AI ${t.swap.factor || 4}x`
        : selfResize ? (sc || 'SIZE')
          : sc ? `SWAP · ${sc}` : 'SWAP';
      if (selfResize) tag.title = `Original texture at ${sc} size`;
      card.appendChild(tag);
      if (!selfResize && t.swap.type !== 'upscale') {
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
      rm.title = selfResize ? 'Back to original size' : 'Remove this swap';
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
  $('modal').querySelectorAll('.mclose').forEach(b => b.addEventListener('click', closeModal));
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
    <div class="flatrow sizerow" id="swapSizeBar"></div>
    <div class="mbody" id="mbody"></div>
    <div class="mfoot" id="mfoot"></div>
  `);
  renderSwapSizeBar(t);
  const foot = $('mfoot');
  if (!t.missing && !t.utility && (!t.swap || t.swap.type === 'upscale')) {
    const up = document.createElement('button');
    up.textContent = t.swap ? '✨ AI upscale again…' : '✨ AI upscale this texture';
    up.title = 'Redraw just this texture at a higher resolution (hi-res mode only; tiling untouched)';
    up.addEventListener('click', () => { closeModal(); upscaleOne(t); });
    foot.appendChild(up);
  }
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
        scale: pickerSize !== 1 ? pickerSize : undefined,
      }));
      toast('Your image is in - F9 in game to see it');
    } catch (e) {
      toast('Upload failed: ' + e.message, true);
    }
  });
}

// One size bar for the whole picker: with an existing stock/custom swap a
// click resizes it IMMEDIATELY (no re-picking); it also sets the size used
// when a new texture is picked. 0.5x = pattern twice as dense on the wall.
let pickerSize = 1;
// when the Flat tab is open it registers a mirror here, so the top size bar
// updates the tab's pattern previews live instead of drifting out of sync
let flatScaleSync = null;
function renderSwapSizeBar(t) {
  const bar = $('swapSizeBar');
  // solid flats have no pattern to scale; every other swap resizes in place
  const hasResizableSwap = t.swap && (t.swap.type === 'stock' || t.swap.type === 'custom'
    || (t.swap.type === 'flat' && t.swap.style !== 'solid'));
  const canSelf = !t.swap && !t.missing; // resize the ORIGINAL texture itself
  pickerSize = (hasResizableSwap && t.swap.scale) || 1;
  const hint = hasResizableSwap ? 'resizes the current swap right away'
    : canSelf ? 'resizes THIS texture right away — or pick a replacement below'
      : 'applies to the texture you pick';
  bar.innerHTML = '<span class="count">Size on walls:</span>' +
    [0.25, 0.5, 1, 2, 4].map(s =>
      `<button class="scbtn${s === pickerSize ? ' sel' : ''}" data-sc="${s}">${s}x</button>`).join('') +
    `<span class="count">${hint}</span>`;
  bar.querySelectorAll('.scbtn').forEach(b => b.addEventListener('click', async () => {
    pickerSize = Number(b.dataset.sc);
    bar.querySelectorAll('.scbtn').forEach(x =>
      x.classList.toggle('sel', Number(x.dataset.sc) === pickerSize));
    if (flatScaleSync) flatScaleSync(pickerSize);
    let spec;
    if (hasResizableSwap) {
      spec = { ...t.swap };
      if (pickerSize !== 1) spec.scale = pickerSize;
      else delete spec.scale;
      // a self-resize back at 1x is no swap at all - drop it entirely
      if (spec.type === 'stock' && spec.to === t.name && !spec.scale) spec = null;
    } else if (canSelf) {
      if (pickerSize === 1) return; // already the original
      spec = { type: 'stock', to: t.name, scale: pickerSize };
    } else {
      return; // solid flat or missing texture: chips only set the pick default
    }
    try {
      applyMutation(await apiPost('/api/swap', { map: state.detail.name, from: t.name, spec }));
      t.swap = spec;
      toast(spec
        ? `Size ${pickerSize}x applied - F9 in game to see it`
        : 'Back to the original texture');
      renderSwapSizeBar(t);
    } catch (e) {
      toast('Resize failed: ' + e.message, true);
    }
  }));
}

async function renderStockTab(t) {
  await buildTextureBrowser($('mbody'), {
    exclude: t.name,
    currentTo: t.swap && t.swap.type === 'stock' ? t.swap.to : null,
    onPick: name => {
      closeModal();
      const spec = { type: 'stock', to: name };
      if (pickerSize !== 1) spec.scale = pickerSize;
      setSwap(t.name, spec);
    },
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
  // request thumbs at roughly the on-screen card width - undersized thumbs
  // get upscaled by the browser and details go mushy
  const thumbSizeForCols = () => ({ 4: 320, 5: 256, 6: 224, 8: 160 }[colsSel.value] || 160);
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

  // hover zoom: hold the mouse over a card to inspect the texture at 512px
  let zoomEl = document.getElementById('pickZoom');
  if (!zoomEl) {
    zoomEl = document.createElement('div');
    zoomEl.id = 'pickZoom';
    zoomEl.style.cssText = 'position:fixed;z-index:400;pointer-events:none;display:none;'
      + 'background:#0d0d0f;border:1px solid #444;border-radius:6px;padding:6px;'
      + 'box-shadow:0 8px 30px rgba(0,0,0,.7)';
    zoomEl.innerHTML = '<img style="display:block;width:480px;height:480px;object-fit:contain">'
      + '<div class="mono" style="color:#aaa;font-size:11px;padding-top:4px;text-align:center"></div>';
    document.body.appendChild(zoomEl);
    document.addEventListener('scroll', () => { zoomEl.style.display = 'none'; }, true);
  }
  const zoomImg = zoomEl.querySelector('img');
  const zoomCap = zoomEl.querySelector('div');
  let zoomTimer = 0;
  const zoomHide = () => { clearTimeout(zoomTimer); zoomEl.style.display = 'none'; };
  const zoomPlace = ev => {
    const W = 492, H = 516;
    let x = ev.clientX + 22;
    if (x + W > innerWidth - 8) x = ev.clientX - W - 22;
    const y = Math.max(8, Math.min(innerHeight - H - 8, ev.clientY - H / 2));
    zoomEl.style.left = x + 'px';
    zoomEl.style.top = y + 'px';
  };
  const zoomShow = (c, ev) => {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      zoomImg.src = thumbUrl({ tex: c.name, size: 512 });
      zoomCap.textContent = c.name + '  ·  ' + (texDimsCache.get(dimKey(c.name)) || '');
      zoomEl.style.display = 'block';
      zoomPlace(ev);
    }, 220);
  };

  const makeCell = c => {
      const cell = document.createElement('div');
      cell.className = 'pickcell' + (opts.currentTo === c.name ? ' current' : '');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = thumbUrl({ tex: c.name, size: thumbSizeForCols() });
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      cell.addEventListener('mouseenter', ev => zoomShow(c, ev));
      cell.addEventListener('mousemove', ev => { if (zoomEl.style.display === 'block') zoomPlace(ev); });
      cell.addEventListener('mouseleave', zoomHide);
      cell.addEventListener('click', zoomHide);
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
  { id: 'diamond', label: 'diamond' },
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
  let scale = cur && cur.scale ? cur.scale : 1;
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
    <p class="mnote" style="margin:6px 0 4px">…or pick the base color from the Quake 2 palette:</p>
    <div class="palgrid" id="palGridBase"></div>
    <div id="patternSection" class="hidden">
      <div class="sectionhead">Pattern color &amp; size</div>
      <div class="flatrow">
        <span class="count">Pattern size:</span>
        <button class="scbtn" data-sc="0.5">0.5x</button>
        <button class="scbtn" data-sc="1">1x</button>
        <button class="scbtn" data-sc="2">2x</button>
        <button class="scbtn" data-sc="4">4x</button>
      </div>
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
    $('palGridBase').querySelectorAll('.palswatch').forEach(x =>
      x.classList.toggle('sel', x.dataset.c.toLowerCase() === colorInput.value.toLowerCase()));
    patSection.querySelectorAll('.scbtn').forEach(x =>
      x.classList.toggle('sel', Number(x.dataset.sc) === scale));
  };
  const thumbParams = (base, s, size) => {
    const p = { flat: base, style: s, size };
    if (color2 && s !== 'solid') p.color2 = color2;
    if (scale !== 1 && s !== 'solid') p.scale = scale;
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

  // Quake 2 palette swatches: one grid for the base color (all styles,
  // solid included), one for the pattern color
  try {
    const pal = await fetch(`/api/palette?dir=${encodeURIComponent(state.dir)}`).then(r => r.json());
    const fill = (grid, onPick) => {
      for (const c of pal.colors || []) {
        const b = document.createElement('button');
        b.className = 'palswatch';
        b.style.background = c;
        b.title = c;
        b.dataset.c = c;
        b.addEventListener('click', () => onPick(c));
        grid.appendChild(b);
      }
    };
    fill($('palGridBase'), c => {
      colorInput.value = c;
      color = c;
      renderStyles(); updatePreview(); updateRalleHint(); syncPattern();
    });
    fill($('palGrid'), c => {
      color2 = c;
      renderStyles(); updatePreview(); syncPattern();
    });
  } catch { /* no palette - the color input still works */ }
  patSection.querySelectorAll('.scbtn').forEach(b =>
    b.addEventListener('click', () => { scale = Number(b.dataset.sc); renderStyles(); updatePreview(); syncPattern(); }));
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
    // the tab's own pattern-size wins; the top size bar is the fallback default
    const sc = scale !== 1 ? scale : pickerSize;
    if (style !== 'solid' && sc !== 1) spec.scale = sc;
    setSwap(t.name, spec);
  });
  renderStyles();
  updatePreview();
  syncPattern();
  flatScaleSync = sc => {
    // tab may have been switched away since; drop the stale mirror then
    if (!document.getElementById('styleRow')) { flatScaleSync = null; return; }
    scale = sc;
    renderStyles();
    updatePreview();
    syncPattern();
  };

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
          if (style !== 'solid' && scale !== 1) spec.scale = scale;
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
  const mf = { scale: 1, ...(state.scan.missingFix || { enabled: false, color: '#0f0f0f', style: 'grid', color2: '#5b3b0f' }) };
  openModal(`
    <div class="mhead">
      <h3>🧱 Missing textures</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody">
      <p class="mnote">Maps often use textures your install doesn't have. Pick a stand-in style —
      the app shows it on every missing texture, and with the fix enabled it is applied
      <b>in game across all maps</b> too. Textures you swap yourself always win over this.
      While the fix is <b>off</b>, missing textures show as the game's classic red-dotted notexture.</p>
      <div class="mfgrid">
        <span class="mflbl">Style</span>
        <div class="stylerow" id="mfStyles"></div>
        <span class="mflbl" id="mfScaleLbl">Pattern size</span>
        <div class="scalerow" id="mfScaleRow">
          <button class="scbtn" data-sc="0.5">0.5x</button>
          <button class="scbtn" data-sc="1">1x</button>
          <button class="scbtn" data-sc="2">2x</button>
          <button class="scbtn" data-sc="4">4x</button>
        </div>
        <span class="mflbl">Preview</span>
        <div class="mfapply">
          <img id="mfPreview" class="flatpreview" alt="preview">
          <label class="mfenable" title="Without this, the style only shows in the app - the game is untouched">
            <input type="checkbox" id="mfEnabled"> Apply in game (all maps)</label>
          <button class="primary" id="mfSave">Save</button>
        </div>
      </div>
      <div class="sectionhead">Base color</div>
      <div class="flatrow palrow">
        <label>Custom: <input type="color" id="mfColor" value="${mf.color}"></label>
        <span class="count">…or pick from the Quake 2 palette below</span>
      </div>
      <div class="palgrid" id="mfPalBase"></div>
      <div class="sectionhead">Pattern color</div>
      <div class="flatrow palrow">
        <label><input type="checkbox" id="mfAuto"> auto (darker shade of the base)</label>
        <label>Custom: <input type="color" id="mfColor2"></label>
        <span class="count">…or pick from the palette below</span>
      </div>
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
    if (mf.scale && mf.scale !== 1 && s !== 'solid') p.scale = mf.scale;
    return p;
  };
  const sync = () => {
    autoBox.checked = !mf.color2;
    color2Input.value = mf.color2 || autoShade();
    $('mfPreview').src = thumbUrl(thumbParams(mf.style, 96));
    $('mfScaleRow').classList.toggle('hidden', mf.style === 'solid');
    $('mfScaleLbl').classList.toggle('hidden', mf.style === 'solid');
    $('mfScaleRow').querySelectorAll('.scbtn').forEach(x =>
      x.classList.toggle('sel', Number(x.dataset.sc) === (mf.scale || 1)));
    $('mfPal').querySelectorAll('.palswatch').forEach(x =>
      x.classList.toggle('sel', !!mf.color2 && x.dataset.c === mf.color2));
    $('mfPalBase').querySelectorAll('.palswatch').forEach(x =>
      x.classList.toggle('sel', x.dataset.c === colorInput.value.toLowerCase()));
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
      const mkSwatch = onPick => {
        const b = document.createElement('button');
        b.className = 'palswatch';
        b.style.background = c;
        b.title = c;
        b.dataset.c = c;
        b.addEventListener('click', onPick);
        return b;
      };
      $('mfPalBase').appendChild(mkSwatch(() => { colorInput.value = c; sync(); }));
      $('mfPal').appendChild(mkSwatch(() => { mf.color2 = c; sync(); }));
    }
  } catch { /* color inputs still work */ }
  colorInput.addEventListener('input', sync);
  autoBox.addEventListener('change', () => { mf.color2 = autoBox.checked ? null : color2Input.value; sync(); });
  color2Input.addEventListener('input', () => { mf.color2 = color2Input.value; sync(); });
  $('mfScaleRow').querySelectorAll('.scbtn').forEach(b =>
    b.addEventListener('click', () => { mf.scale = Number(b.dataset.sc); sync(); }));
  $('mfSave').addEventListener('click', async () => {
    try {
      const r = await apiPost('/api/missingfix', {
        enabled: $('mfEnabled').checked,
        color: colorInput.value,
        style: mf.style,
        color2: mf.color2,
        scale: mf.scale || 1,
      });
      state.scan.missingFix = r.missingFix;
      closeModal();
      bustThumbs();
      renderHook();
      if (state.detail) await selectMap(state.detail.name);
      if (r.missingFix.enabled) {
        toast(`Missing-texture fix is ON - ${(r.written || []).length} cfg(s) updated, F9 in game to see it`);
      } else {
        toast('Style saved - fix is OFF, so maps keep the classic red missing texture. Tick "Apply in game" to fix them.', true);
      }
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
      <p class="mnote">Works with <b>AQ2 / AQtion</b> and <b>plain Quake 2</b> installs (q2pro-family engines).
      For Quake 2, a mod dropdown appears next to the path — pick which mod the game runs and the app
      layers it over baseq2 exactly like the engine does.</p>
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
      <b>Import preset…</b>. Custom images travel inside the file.
      <b>🎁 Export pack…</b> (top bar) bundles the texture swaps of every customized map into
      one <code>.aq2pack.json</code> — sky and lighting stay personal.</p>

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

function openAbout() {
  const ver = state.scan && state.scan.version ? 'v' + state.scan.version : '';
  openModal(`
    <div class="mhead">
      <h3>About TexSwap</h3>
      <button class="mclose">✕</button>
    </div>
    <div class="mbody" style="text-align:center">
      <img src="texswaplogo-ui.png" alt="TexSwap" style="width:min(460px,86%);border-radius:14px;margin:6px 0 14px">
      <p style="font-size:15px;font-weight:650">TexSwap ${ver} <span style="color:var(--faint);font-weight:400">· by Ralle</span></p>
      <p class="mnote" style="margin-top:6px;text-align:left">
      <b>What it is:</b> a texture swapper for Quake 2 and Action Quake 2 (AQtion). Restyle any map for
      gameplay — swap textures and skyboxes, tune lighting, fix missing textures, save per-map presets
      and share them with friends as small files. Everything applies in the real game automatically on
      map load, powered by q2pro's <span class="mono">link</span> command; nothing the game ships with
      is ever modified.</p>
      <p class="mnote" style="text-align:left">
      <b>Who it's for:</b> players who love making their own custom versions of their favorite maps —
      and just as much a tool for mapmakers: instant overview of every texture a map uses, and a fast
      way to test different texture designs on the fly, in the 3D viewer or straight in the game.</p>
      <p class="mnote" style="text-align:left">
      <b>How it's made:</b> a small Node.js server with a hand-written web UI (no frameworks) and a
      three.js 3D map viewer, wrapped in Electron as one portable exe. Designed and built by Ralle
      together with AI — the artwork too.</p>
      <p class="mnote" style="text-align:left">
      <b>About Ralle:</b> veteran AQ2 mapper and player — creator of the maps
      <span class="mono">TempleofDoom</span> and <span class="mono">Kingslanding</span>, the
      ralle_colors texture palette, and a pile of AQ2 fan content over the years: songs, videos and
      more. In the pipeline: the <span class="mono">Nostromo</span> map.</p>
      <p class="mnote" style="text-align:left">
      <b>Contact:</b> mail <a href="mailto:smarallen@hotmail.com" style="color:var(--accent-hi)">smarallen@hotmail.com</a>
      &nbsp;·&nbsp; Discord: <span class="mono" style="color:var(--accent-hi)">smarallen</span></p>
      <p class="mnote" style="text-align:left">
      <b>Latest version:</b> <a href="https://github.com/ScaramangaDK/texswap/releases/latest" target="_blank" style="color:var(--accent-hi)">github.com/ScaramangaDK/texswap/releases</a></p>
    </div>
  `);
}
$('aboutBtn').addEventListener('click', openAbout);
$('aboutBtn2').addEventListener('click', openAbout);
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
$('upscaleMapBtn').addEventListener('click', openUpscaleMap);
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

// ---------- AI upscale: full-screen view ----------
let upscalePoll = 0;
const UP = { open: false, map: null, plan: null, status: null, cache: null, selected: null, eligible: [], done: [], bound: false, dirty: false };

function upOpts() {
  return {
    factor: Number($('upFactor').value) || 4,
    minSkip: Number($('upSkip').value) || 1024,
    src: $('upSrc').value === 'auto' ? 'auto' : 'low',
    model: $('upModel').value === 'smooth' ? 'smooth' : 'detail',
    grain: Number($('upGrain').value) || 0,
  };
}

function upIsSel(name) {
  // default: everything not yet done; done textures are opt-in (redo)
  return UP.selected ? UP.selected.has(name) : !UP.done.some(d => d.name === name);
}

function upBind() {
  if (UP.bound) return;
  UP.bound = true;
  $('upClose').addEventListener('click', closeUpscale);
  for (const [id, key] of [['upFactor', 'aq2ts.upFactor'], ['upSkip', 'aq2ts.upSkip'], ['upSrc', 'aq2ts.upSrc'], ['upModel', 'aq2ts.upModel'], ['upGrain', 'aq2ts.upGrain']]) {
    $(id).addEventListener('change', () => { localStorage.setItem(key, $(id).value); UP.selected = null; upRefresh(); });
  }
  $('upAll').addEventListener('click', () => { UP.selected = new Set([...UP.eligible, ...UP.done].map(e => e.name)); upRenderGrid(); upRenderSide(); });
  $('upNone').addEventListener('click', () => { UP.selected = new Set(); upRenderGrid(); upRenderSide(); });
  $('upFilter').addEventListener('input', upRenderGrid);
  $('upStart').addEventListener('click', async () => {
    const names = [...UP.eligible, ...UP.done].map(e => e.name).filter(upIsSel);
    if (!names.length) return;
    $('upStart').disabled = true;
    try {
      await apiPost('/api/upscale/map', { map: UP.map, ...upOpts(), names });
      UP.dirty = true;
      upRefresh();
    } catch (e) { toast('Upscale: ' + e.message, true); $('upStart').disabled = false; }
  });
  $('upCancel').addEventListener('click', () => apiPost('/api/upscale/cancel', {}).catch(() => {}));
  $('upRemove').addEventListener('click', async () => {
    try {
      const r = await apiPost('/api/upscale/remove', { map: UP.map });
      applyMutation(r);
      UP.selected = null;
      toast(`Removed ${r.removed} upscale${r.removed === 1 ? '' : 's'} on ${UP.map}`);
      upRefresh();
    } catch (e) { toast(e.message, true); }
  });
  $('upClearCache').addEventListener('click', async () => {
    $('upClearCache').disabled = true;
    try {
      const r = await apiPost('/api/upscale/clearcache', {});
      toast(`Removed ${r.removed} unused cache file${r.removed === 1 ? '' : 's'} (${(r.removedBytes / 1048576).toFixed(0)} MB)`);
      upRefresh();
    } catch (e) { toast(e.message, true); }
    $('upClearCache').disabled = false;
  });
  document.addEventListener('keydown', e => {
    if (!UP.open || e.key !== 'Escape') return;
    if (!$('modalOverlay').classList.contains('hidden')) return;
    closeUpscale();
  });
}

async function openUpscaleMap() {
  if (!state.detail) return;
  upBind();
  UP.map = state.detail.name;
  UP.open = true;
  UP.selected = null;
  UP.dirty = false;
  $('upFactor').value = String(Number(localStorage.getItem('aq2ts.upFactor')) || 4);
  $('upSkip').value = String(Number(localStorage.getItem('aq2ts.upSkip')) || 1024);
  $('upSrc').value = localStorage.getItem('aq2ts.upSrc') === 'auto' ? 'auto' : 'low';
  $('upModel').value = localStorage.getItem('aq2ts.upModel') === 'smooth' ? 'smooth' : 'detail';
  $('upGrain').value = String([25, 50, 75, 100].includes(Number(localStorage.getItem('aq2ts.upGrain'))) ? Number(localStorage.getItem('aq2ts.upGrain')) : 0);
  $('upMapName').textContent = UP.map;
  $('upFilter').value = '';
  $('upGrid').textContent = '';
  $('upStatus').textContent = 'loading…';
  $('upscaleOverlay').classList.remove('hidden');
  await upRefresh();
}

async function closeUpscale() {
  UP.open = false;
  clearTimeout(upscalePoll);
  $('upscaleOverlay').classList.add('hidden');
  if (UP.dirty && state.activeMap === UP.map) await selectMap(UP.map);
}

async function upRefresh() {
  if (!UP.open) return;
  let plan, status, cache;
  try {
    [plan, status, cache] = await Promise.all([
      apiGet('/api/upscale/plan', { name: UP.map, ...upOpts() }),
      apiGet('/api/upscale/status'),
      apiGet('/api/upscale/cache').catch(() => null),
    ]);
  } catch (e) { toast('Upscale: ' + e.message, true); return; }
  if (!UP.open) return;
  UP.plan = plan; UP.status = status; UP.cache = cache;
  UP.eligible = plan.eligible;
  UP.done = plan.already;
  if (UP.selected) {
    const all = new Set([...UP.eligible, ...UP.done].map(e => e.name));
    for (const n of [...UP.selected]) if (!all.has(n)) UP.selected.delete(n);
  }
  upRenderGrid();
  upRenderSide();
  const running = status.running && status.map === UP.map;
  if (running) {
    clearTimeout(upscalePoll);
    upscalePoll = setTimeout(async () => {
      if (!UP.open) return;
      const st = await apiGet('/api/upscale/status').catch(() => null);
      if (st && !st.running) {
        for (const f of (st.failed || []).slice(0, 4)) toast(f, true);
        toast(st.applied ? `AI upscale done: ${st.applied} textures on ${UP.map} - F9 in game (hi-res mode)` : 'AI upscale finished with nothing to apply', !st.applied);
        UP.selected = new Set(); // a finished run leaves nothing ticked
        upRefresh();
      } else {
        UP.status = st || UP.status;
        upRenderSide();
        upscalePoll = setTimeout(() => upRefresh(), 0);
      }
    }, 800);
  }
}

function upRenderSide() {
  const { plan, status, cache } = UP;
  if (!plan) return;
  const o = upOpts();
  const tool = plan.tool;
  const running = status.running && status.map === UP.map;
  const busyElsewhere = status.running && status.map !== UP.map;
  const all = [...UP.eligible, ...UP.done];
  const selNames = all.map(e => e.name).filter(upIsSel);
  const nSel = selNames.length;
  const secs = Math.max(0, nSel - (UP.plan.cached || 0)) * 3;
  const est = nSel ? (secs < 90 ? `about ${Math.max(5, Math.round(secs / 5) * 5)} s` : `about ${Math.round(secs / 60)} min`) : '';

  $('upSelCount').textContent = nSel;
  $('upSelText').textContent = `of ${all.length} texture${all.length === 1 ? '' : 's'} selected` + (est ? ` · ${est} on your GPU` : '');

  const notes = [];
  if (UP.done.length) notes.push(`${UP.done.length} already upscaled - tick any to redo them with the settings above.`);
  if (plan.cached) notes.push(`${plan.cached} cached: instant.`);
  const regen = UP.eligible.filter(e => e.regen).length;
  if (regen) notes.push(`<span class="warn">${regen} of this map's preset ${regen === 1 ? 'has' : 'have'} no generated file on this PC (imported preset or cleared cache) - ticked, the run regenerates them with their own settings.</span>`);
  const skipped = [];
  if (plan.skipHiRes.length) skipped.push(`${plan.skipHiRes.length} already at ${o.minSkip >= 100000 ? 'hi-res' : o.minSkip + ' px or more'}`);
  if (plan.skipSwapped.length) skipped.push(`${plan.skipSwapped.length} with other swaps`);
  if (plan.skipMissing.length) skipped.push(`${plan.skipMissing.length} missing`);
  if (plan.tooBig.length) skipped.push(`${plan.tooBig.length} over the size limit`);
  if (plan.noGrid.length) skipped.push(`<span title="${plan.noGrid.join(', ')}">${plan.noGrid.length} without a .wal (the engine would tile them denser)</span>`);
  if (skipped.length) notes.push('Left alone: ' + skipped.join(' · ') + '.');
  if (!tool.installed) notes.push(`<span class="warn">The AI upscaler is not installed yet - open ✨ AI upscale… on a map once to download it (${tool.downloadMB} MB).</span>`);
  if (busyElsewhere) notes.push(`<span class="warn">Busy upscaling ${status.map} - wait for it to finish.</span>`);
  $('upNotes').innerHTML = notes.map(n => `<div>${n}</div>`).join('');

  $('upStart').classList.toggle('hidden', running);
  $('upStart').disabled = !tool.installed || !nSel || busyElsewhere;
  $('upStart').textContent = nSel ? `Upscale ${nSel} texture${nSel === 1 ? '' : 's'}` : 'Nothing selected';
  $('upProgress').classList.toggle('hidden', !running);
  if (running) {
    const pct = status.total ? Math.round(status.done / status.total * 100) : 0;
    $('upBar').style.width = pct + '%';
    $('upProgText').textContent = `${status.done} / ${status.total}${status.current ? ' · ' + status.current : ''}`;
  }
  $('upLast').textContent = status.finished && status.map === UP.map
    ? `Last run: ${status.applied} textures applied${status.failed.length ? `, ${status.failed.length} failed` : ''}${status.cancelled ? ' (cancelled)' : ''}.`
    : '';
  $('upRemove').disabled = !UP.done.length || running;
  $('upRemove').textContent = UP.done.length ? `Remove ${UP.done.length} upscale${UP.done.length === 1 ? '' : 's'} on this map` : 'No upscales on this map';
  if (cache) {
    const big = cache.bytes > 1073741824;
    $('upCache').innerHTML = `${big ? '<span class="warn">Getting big. </span>' : ''}${cache.files} file${cache.files === 1 ? '' : 's'}, ${(cache.bytes / 1048576).toFixed(0)} MB on this PC, shared by every map` +
      (cache.unusedFiles ? ` · <b>${cache.unusedFiles}</b> unused (${(cache.unusedBytes / 1048576).toFixed(0)} MB)` : ' · nothing unused');
    $('upClearCache').disabled = !cache.unusedFiles;
  }
  $('upStatus').textContent = running
    ? `upscaling… ${status.done} / ${status.total}`
    : `${UP.done.length} of ${all.length + plan.skipHiRes.length + plan.skipSwapped.length} textures upscaled on this map`;
}

function upRenderGrid() {
  const grid = $('upGrid');
  grid.textContent = '';
  const o = upOpts();
  const q = $('upFilter').value.trim().toLowerCase();
  const running = UP.status && UP.status.running && UP.status.map === UP.map;
  const items = [
    ...UP.eligible.map(e => ({ ...e, isDone: false })),
    ...UP.done.map(a => ({ ...a, isDone: true })),
  ].filter(e => !q || e.name.includes(q));
  items.sort((a, b) => a.name.localeCompare(b.name));
  $('upGridInfo').textContent = items.length ? `${items.length} texture${items.length === 1 ? '' : 's'}${q ? ' matching' : ''} · click to tick` : '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'up-empty';
    d.textContent = q ? 'No texture matches the filter.' : 'Nothing to upscale with these settings - every texture is already hi-res, swapped, or has no .wal.';
    grid.appendChild(d);
    return;
  }
  for (const e of items) {
    const card = document.createElement('div');
    card.className = 'up-card' + (upIsSel(e.name) ? ' sel' : '') + (e.isDone ? ' done' : '');
    card.dataset.name = e.name;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = e.isDone
      ? thumbUrl({ upscale: e.name, factor: e.factor, src: e.src, model: e.model, grain: e.grain || 0, size: 256 })
      : thumbUrl({ tex: e.name, size: 256, res: o.src === 'low' ? 'low' : 'hi' });
    const badge = document.createElement('span');
    badge.className = 'up-badge';
    badge.textContent = e.isDone
      ? `done · ${e.factor}x ${e.model}${e.grain ? ' · grain ' + e.grain : ''}${e.src === 'low' ? ' · wal' : ''}`
      : e.regen ? 'regenerate' : `${e.w}×${e.h} → ${e.factor}x`;
    const tick = document.createElement('span');
    tick.className = 'up-tick';
    tick.textContent = upIsSel(e.name) ? '✓' : '';
    const name = document.createElement('div');
    name.className = 'up-name';
    name.textContent = e.name;
    name.title = e.name;
    const meta = document.createElement('div');
    meta.className = 'up-meta';
    meta.textContent = e.isDone
      ? 'tick to redo with the settings on the left'
      : `${e.w}×${e.h} ${e.ext ? e.ext.slice(1) : ''} → ${e.w * e.factor}×${e.h * e.factor}`;
    card.append(img, badge, tick, name, meta);
    card.addEventListener('click', () => {
      if (running) return;
      if (!UP.selected) UP.selected = new Set(UP.eligible.map(x => x.name));
      if (UP.selected.has(e.name)) UP.selected.delete(e.name); else UP.selected.add(e.name);
      card.classList.toggle('sel', UP.selected.has(e.name));
      tick.textContent = UP.selected.has(e.name) ? '✓' : '';
      upRenderSide();
    });
    grid.appendChild(card);
  }
}

async function upscaleOne(t) {
  if (!state.detail) return;
  const map = state.detail.name;
  const factor = Number(localStorage.getItem('aq2ts.upFactor')) || 4;
  const src = localStorage.getItem('aq2ts.upSrc') === 'low' ? 'low' : 'auto';
  const model = localStorage.getItem('aq2ts.upModel') === 'smooth' ? 'smooth' : 'detail';
  const grain = [25, 50, 75, 100].includes(Number(localStorage.getItem('aq2ts.upGrain'))) ? Number(localStorage.getItem('aq2ts.upGrain')) : 0;
  try {
    const st = await apiGet('/api/upscale/status');
    if (!st.tool.installed) { toast('The AI upscaler is not installed yet - open ✨ AI upscale… on the map to download it', true); return; }
    if (st.running) { toast(`Busy upscaling ${st.map} - try again when it finishes`, true); return; }
    if (t.swap && t.swap.type === 'upscale') await apiPost('/api/swap', { map, from: t.name, spec: null });
    const r = await apiPost('/api/upscale/map', { map, factor, minSkip: 100000, src, model, grain, names: [t.name] });
    if (!r.total) {
      toast(t.ext === '.wal' || t.missing
        ? `${t.name}: nothing to upscale (missing file, or already over the 4096 px limit)`
        : `${t.name}: no .wal original - the engine would tile an upscale ${factor}x denser, so it is left alone`, true);
      return;
    }
    toast(`Upscaling ${t.name} ${factor}x ${model}${src === 'low' ? ', from the original .wal' : ''}…`);
    const wait = async () => {
      const s2 = await apiGet('/api/upscale/status');
      if (s2.running) { setTimeout(wait, 700); return; }
      for (const f of (s2.failed || []).slice(0, 2)) toast(f, true);
      if (s2.applied) toast(`${t.name} upscaled - F9 in game (hi-res mode)`);
      if (state.activeMap === map) await selectMap(map);
    };
    setTimeout(wait, 700);
  } catch (e) {
    toast('Upscale: ' + e.message, true);
  }
}
// bridge for the viewer module
window.AQTS = {
  state,
  thumbUrl,
  swapThumbUrl,
  toast,
  texDims: async names => (await apiPost('/api/texdims', { names })).dims,
  openPickerByName: name => {
    const t = state.detail && state.detail.textures.find(x => x.name === name);
    if (t) openPicker(t);
    else toast('Texture not found on this map: ' + name, true);
  },
};

boot();
