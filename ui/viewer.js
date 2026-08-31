// 3D map viewer: renders the BSP with the current swaps applied.
// Talks to main.js through window.AQTS (thumb URLs, picker, state).
import * as THREE from '/vendor/three.module.js';

let ctx = null;

function urlForGroup(name, detail) {
  const t = detail && detail.textures.find(x => x.name === name);
  const AQTS = window.AQTS;
  if (t && t.swap) {
    if (t.swap.type === 'invisible') return { invisible: true, trans: t.flags.some(f => f.startsWith('trans')) };
    return { url: AQTS.swapThumbUrl(t.swap, 256) };
  }
  return { url: AQTS.thumbUrl({ tex: name, size: 256 }) };
}

function loadMapTexture(url) {
  if (ctx.texCache.has(url)) return ctx.texCache.get(url);
  const tex = ctx.loader.load(url);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  ctx.texCache.set(url, tex);
  return tex;
}

function applyGroupLook(mesh, detail) {
  const info = urlForGroup(mesh.userData.texName, detail);
  const mat = mesh.material;
  if (info.invisible) {
    if (info.trans) {
      mesh.visible = false; // engine-verified: trans surfaces really disappear
    } else {
      mesh.visible = true;  // opaque surfaces render black in-game
      mat.map = null;
      mat.color.set(0x000000);
      mat.needsUpdate = true;
    }
    return;
  }
  mesh.visible = true;
  mat.color.set(0xffffff);
  mat.map = loadMapTexture(info.url);
  mat.needsUpdate = true;
}

async function open(detail) {
  close();
  const AQTS = window.AQTS;
  const overlay = document.getElementById('viewerOverlay');
  overlay.classList.remove('hidden');
  document.getElementById('vMapName').textContent = detail.name;
  document.getElementById('vHover').textContent = 'loading map…';
  document.getElementById('vSelected').classList.add('hidden');

  let geo;
  try {
    const url = new URL('/api/mapgeo', location.origin);
    url.searchParams.set('dir', AQTS.state.dir);
    url.searchParams.set('name', detail.name);
    const r = await fetch(url);
    geo = await r.json();
    if (!r.ok) throw new Error(geo.error || r.statusText);
  } catch (e) {
    AQTS.toast('3D view failed: ' + e.message, true);
    overlay.classList.add('hidden');
    return;
  }

  const canvas = document.getElementById('viewerCanvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141a);

  // lightmap atlas (real Q2 lighting); intensity follows the user's
  // gl_modulate when lighting is managed, else a sensible default
  let lightMap = null;
  if (geo.hasLightmap) {
    const lmUrl = new URL('/api/maplight', location.origin);
    lmUrl.searchParams.set('dir', AQTS.state.dir);
    lmUrl.searchParams.set('name', detail.name);
    lightMap = new THREE.TextureLoader().load(lmUrl.toString());
    lightMap.channel = 1; // sample the uv1 attribute, not the diffuse UVs
    lightMap.flipY = false;
    lightMap.colorSpace = THREE.SRGBColorSpace;
    lightMap.magFilter = THREE.LinearFilter;
    lightMap.minFilter = THREE.LinearFilter;
    lightMap.generateMipmaps = false;
  } else {
    scene.add(new THREE.AmbientLight(0xffffff, 1.35));
  }
  const L = AQTS.state.scan && AQTS.state.scan.lighting;
  const modulate = L && L.manage && L.global && L.global.gl_modulate ? parseFloat(L.global.gl_modulate) : 2;
  const lmIntensity = Math.min(4, Math.max(1, isNaN(modulate) ? 2 : modulate)) * 1.25;

  const camera = new THREE.PerspectiveCamera(80, 1, 1, 30000);
  camera.rotation.order = 'YXZ';

  ctx = {
    renderer, scene, camera, lightMap,
    loader: new THREE.TextureLoader(),
    texCache: new Map(),
    meshes: [],
    keys: new Set(),
    raycaster: new THREE.Raycaster(),
    raf: 0,
    detailName: detail.name,
    last: performance.now(),
    yaw: 0, pitch: 0,
  };

  // quake (x, y, z-up) -> three (x, z, -y)
  for (const g of geo.groups) {
    const n = g.positions.length / 3;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = g.positions[i * 3];
      pos[i * 3 + 1] = g.positions[i * 3 + 2];
      pos[i * 3 + 2] = -g.positions[i * 3 + 1];
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.uvs), 2));
    if (lightMap && g.luvs) {
      bg.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(g.luvs), 2));
    }
    const trans = g.flags.includes('trans33') || g.flags.includes('trans66');
    const mat = lightMap
      ? new THREE.MeshBasicMaterial({
          side: THREE.DoubleSide,
          transparent: trans,
          opacity: trans ? 0.6 : 1,
          lightMap,
          lightMapIntensity: lmIntensity,
        })
      : new THREE.MeshLambertMaterial({
          side: THREE.DoubleSide,
          transparent: trans,
          opacity: trans ? 0.6 : 1,
        });
    const mesh = new THREE.Mesh(bg, mat);
    mesh.userData.texName = g.name;
    mesh.userData.flags = g.flags;
    scene.add(mesh);
    ctx.meshes.push(mesh);
    applyGroupLook(mesh, detail);
  }

  // camera start: a player spawn, else above bounds center
  if (geo.spawns.length) {
    const [x, y, z, angle] = geo.spawns[0];
    camera.position.set(x, z + 40, -y);
    ctx.yaw = THREE.MathUtils.degToRad(angle - 90);
  } else {
    const c = geo.bounds;
    camera.position.set((c.min[0] + c.max[0]) / 2, c.max[2] + 200, -(c.min[1] + c.max[1]) / 2);
    ctx.pitch = -0.9;
  }

  const resize = () => {
    const w = overlay.clientWidth, h = overlay.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  ctx.onResize = resize;
  window.addEventListener('resize', resize);

  // controls: drag to look, WASD + QE to move, shift = fast, click = select
  let dragging = false, moved = 0, lastX = 0, lastY = 0;
  ctx.onDown = e => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; };
  ctx.onMove = e => {
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX; lastY = e.clientY;
      ctx.yaw -= dx * 0.004;
      ctx.pitch = Math.max(-1.5, Math.min(1.5, ctx.pitch - dy * 0.004));
    } else {
      hover(e);
    }
  };
  ctx.onUp = e => {
    if (dragging && moved < 5) select(e);
    dragging = false;
  };
  ctx.onKey = e => {
    if (e.type === 'keydown') {
      if (e.code === 'Escape') { close(); return; }
      ctx.keys.add(e.code);
    } else ctx.keys.delete(e.code);
  };
  canvas.addEventListener('mousedown', ctx.onDown);
  window.addEventListener('mousemove', ctx.onMove);
  window.addEventListener('mouseup', ctx.onUp);
  window.addEventListener('keydown', ctx.onKey);
  window.addEventListener('keyup', ctx.onKey);

  const pick = e => {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    ctx.raycaster.setFromCamera(ndc, camera);
    const hits = ctx.raycaster.intersectObjects(ctx.meshes.filter(m => m.visible), false);
    return hits.length ? hits[0].object : null;
  };
  let hoverThrottle = 0;
  const hover = e => {
    const now = performance.now();
    if (now - hoverThrottle < 80) return;
    hoverThrottle = now;
    const m = pick(e);
    document.getElementById('vHover').textContent = m ? m.userData.texName : '';
  };
  const select = e => {
    const m = pick(e);
    const panel = document.getElementById('vSelected');
    if (!m) { panel.classList.add('hidden'); return; }
    ctx.selectedTex = m.userData.texName;
    document.getElementById('vSelName').textContent = m.userData.texName;
    panel.classList.remove('hidden');
  };

  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - ctx.last) / 1000);
    ctx.last = now;
    camera.rotation.set(ctx.pitch, ctx.yaw, 0);
    const speed = (ctx.keys.has('ShiftLeft') || ctx.keys.has('ShiftRight')) ? 1200 : 400;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
    const move = new THREE.Vector3();
    if (ctx.keys.has('KeyW')) move.add(fwd);
    if (ctx.keys.has('KeyS')) move.sub(fwd);
    if (ctx.keys.has('KeyD')) move.add(right);
    if (ctx.keys.has('KeyA')) move.sub(right);
    if (ctx.keys.has('KeyE')) move.y += 1;
    if (ctx.keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq()) camera.position.addScaledVector(move.normalize(), speed * dt);
    renderer.render(scene, camera);
    ctx.raf = requestAnimationFrame(step);
  };
  document.getElementById('vHover').textContent = '';
  step();
}

function close() {
  if (!ctx) {
    document.getElementById('viewerOverlay').classList.add('hidden');
    return;
  }
  cancelAnimationFrame(ctx.raf);
  window.removeEventListener('resize', ctx.onResize);
  window.removeEventListener('mousemove', ctx.onMove);
  window.removeEventListener('mouseup', ctx.onUp);
  window.removeEventListener('keydown', ctx.onKey);
  window.removeEventListener('keyup', ctx.onKey);
  for (const m of ctx.meshes) {
    m.geometry.dispose();
    m.material.dispose();
  }
  for (const t of ctx.texCache.values()) t.dispose();
  if (ctx.lightMap) ctx.lightMap.dispose();
  ctx.renderer.dispose();
  ctx = null;
  document.getElementById('viewerOverlay').classList.add('hidden');
}

function onSwapsChanged(detail) {
  if (!ctx || !detail || detail.name !== ctx.detailName) return;
  for (const mesh of ctx.meshes) applyGroupLook(mesh, detail);
}

document.getElementById('vClose').addEventListener('click', close);
document.getElementById('vSwapBtn').addEventListener('click', () => {
  if (ctx && ctx.selectedTex) window.AQTS.openPickerByName(ctx.selectedTex);
});
document.getElementById('vSelClose').addEventListener('click', () => {
  document.getElementById('vSelected').classList.add('hidden');
});

window.AQViewer = { open, close, onSwapsChanged };
