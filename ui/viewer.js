// 3D map viewer: renders the BSP with the current swaps applied.
// Talks to main.js through window.AQTS (thumb URLs, picker, state).
import * as THREE from '/vendor/three.module.js';

let ctx = null;

function urlForGroup(name, detail, isTrans) {
  const t = detail && detail.textures.find(x => x.name === name);
  const AQTS = window.AQTS;
  // trans surfaces: always load the .wal with palette-255 masking — hi-res
  // conversions often have the salmon "transparent color" baked in opaquely
  if (t && t.swap) {
    if (t.swap.type === 'invisible') {
      return { invisible: true, trans: t.flags.some(f => f.startsWith('trans') || f === 'alphatest') };
    }
    if (t.swap.type === 'stock' && isTrans) {
      return { url: AQTS.thumbUrl({ tex: t.swap.to, size: 256, alpha: 1, res: 'low' }) };
    }
    return { url: AQTS.swapThumbUrl(t.swap, 256) };
  }
  const params = { tex: name, size: 256 };
  if (isTrans) { params.alpha = 1; params.res = 'low'; }
  return { url: AQTS.thumbUrl(params) };
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
  const f = mesh.userData.flags || [];
  const isMasked = f.includes('trans33') || f.includes('trans66') || f.includes('alphatest');
  const info = urlForGroup(mesh.userData.texName, detail, isMasked);
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

// Q2 sky face -> three.js cubemap side, in our world transform (x, z, -y):
// rt=+X lf=-X up=+Y(top) dn=-Y ft=+Z(quake -Y) bk=-Z. Each face takes
// quarter-turns (q) and mirroring (mx) because three samples cube faces in
// the GL convention while Q2 faces are straight photos; calibrated against
// cloud-seam continuity (see AQVskyRot for live tuning).
// derived from id's st_to_vec tables vs GL cube sampling: sides mirror,
// the caps also rotate (up transposes, dn anti-transposes)
const SKY_XFORM = {
  rt: { q: 0, mx: true }, lf: { q: 0, mx: true },
  up: { q: 1, mx: true }, dn: { q: 3, mx: true },
  ft: { q: 0, mx: true }, bk: { q: 0, mx: true },
};

function buildSkyCube(imgs, xf) {
  const prep = (img, t) => {
    const s = img.width;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.translate(s / 2, s / 2);
    if (t.mx) g.scale(-1, 1);
    g.rotate((t.q || 0) * Math.PI / 2);
    g.drawImage(img, -s / 2, -s / 2, s, s);
    return cv;
  };
  const cube = new THREE.CubeTexture([
    prep(imgs.rt, xf.rt), prep(imgs.lf, xf.lf),
    prep(imgs.up, xf.up), prep(imgs.dn, xf.dn),
    prep(imgs.ft, xf.ft), prep(imgs.bk, xf.bk),
  ]);
  cube.needsUpdate = true;
  cube.colorSpace = THREE.SRGBColorSpace;
  return cube;
}

async function loadSkyBackground(myCtx, scene, detail) {
  const AQTS = window.AQTS;
  const name = detail.skySwap || detail.sky;
  if (!name) return;
  const faceUrl = f => {
    const u = new URL('/api/skyface', location.origin);
    u.searchParams.set('dir', AQTS.state.dir);
    u.searchParams.set('sky', name);
    u.searchParams.set('face', f);
    return u.toString();
  };
  const loadImg = f => new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = faceUrl(f);
  });
  const faces = ['rt', 'lf', 'up', 'dn', 'ft', 'bk'];
  const loaded = await Promise.all(faces.map(loadImg));
  if (ctx !== myCtx || loaded.some(x => !x)) return; // closed, or incomplete set
  const imgs = Object.fromEntries(faces.map((f, i) => [f, loaded[i]]));
  myCtx.skyImgs = imgs;
  scene.background = buildSkyCube(imgs, SKY_XFORM);
  // live recalibration helper: AQVskyRot({rt: {q: 1, mx: true}, ...})
  window.AQVskyRot = xf => { scene.background = buildSkyCube(imgs, { ...SKY_XFORM, ...xf }); };
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
    // linear sampling: sRGB-decoding crushes dark luxels and everything
    // ends up far darker than the engine's straight byte-multiply
    lightMap.magFilter = THREE.LinearFilter;
    lightMap.minFilter = THREE.LinearFilter;
    lightMap.generateMipmaps = false;
  } else {
    scene.add(new THREE.AmbientLight(0xffffff, 1.35));
  }
  // q2pro's world lighting: tex * (lightmap + gl_brightness) * gl_modulate.
  // meshbasic computes tex * lm * intensity * RECIPROCAL_PI + tex * uBright,
  // so intensity = modulate * PI and uBright = brightness * modulate.
  const Lg = AQTS.state.scan && AQTS.state.scan.lighting;
  const cvar = n => Lg && Lg.manage && Lg.global ? parseFloat(Lg.global[n]) : NaN;
  const savedMod = parseFloat(localStorage.getItem('aq2ts.vmod'));
  const savedAdd = parseFloat(localStorage.getItem('aq2ts.vadd'));
  let mod = Number.isFinite(savedMod) ? savedMod : (cvar('gl_modulate') || 1);
  let add = Number.isFinite(savedAdd) ? savedAdd : (Number.isFinite(cvar('gl_brightness')) ? cvar('gl_brightness') : 0.1);
  mod = Math.min(4, Math.max(0.25, mod));
  add = Math.min(0.4, Math.max(0, add));
  const lmIntensity = mod * Math.PI;
  const brightUniform = { value: add * mod };
  const modInput = document.getElementById('vMod'), addInput = document.getElementById('vAdd');
  const modVal = document.getElementById('vModVal'), addVal = document.getElementById('vAddVal');
  const applyLight = () => {
    mod = parseFloat(modInput.value);
    add = parseFloat(addInput.value);
    localStorage.setItem('aq2ts.vmod', mod);
    localStorage.setItem('aq2ts.vadd', add);
    modVal.textContent = mod.toFixed(2);
    addVal.textContent = add.toFixed(3);
    brightUniform.value = add * mod;
    if (ctx) for (const m of ctx.meshes) m.material.lightMapIntensity = mod * Math.PI;
  };
  modInput.value = mod;
  addInput.value = add;
  modVal.textContent = mod.toFixed(2);
  addVal.textContent = add.toFixed(3);
  modInput.oninput = addInput.oninput = applyLight;

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
    timeUniform: { value: 0 },
  };
  window.AQV = ctx;
  loadSkyBackground(ctx, scene, detail);

  // quake (x, y, z-up) -> three (x, z, -y)
  let maskedCount = 0;
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
    const alphatest = g.flags.includes('alphatest');
    const trans = !alphatest && (g.flags.includes('trans33') || g.flags.includes('trans66'));
    const opacity = trans ? (g.flags.includes('trans33') ? 0.45 : 0.75) : 1;
    const overlay = alphatest || trans;
    const common = {
      // one-sided like the engine: coplanar back-to-back faces (thin fences,
      // grass sheets, water tops/bottoms) otherwise z-fight their own twin.
      // BSP winding is clockwise-from-front, which is three.js's back side.
      side: THREE.BackSide,
      transparent: trans,
      opacity,
      // alphatest surfaces: opaque where texels exist, hard holes elsewhere;
      // blended trans surfaces still cut their palette-255 holes
      alphaTest: alphatest ? 0.5 : trans ? 0.05 : 0,
      // overlays are usually coplanar with the wall behind - offset to stop
      // z-fighting, each masked group on its own step so coplanar overlays
      // (fence + inner pass-through brush) get a stable winner at any angle
      polygonOffset: overlay,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: overlay ? -(1 + (maskedCount++ % 6)) : 0,
      depthWrite: !trans,
    };
    const mat = lightMap
      ? new THREE.MeshBasicMaterial({ ...common, lightMap, lightMapIntensity: lmIntensity })
      : new THREE.MeshLambertMaterial(common);
    if (lightMap) {
      // one shader patch: additive gl_brightness for everything, plus classic
      // q2 warp undulation and engine-rate flowing scroll along -U: water
      // (warp) runs 64 texels per 2s, conveyors 64 texels per 40s (ref_gl)
      const warp = g.flags.includes('warp');
      const flow = g.flags.includes('flowing') ? (warp ? 32 : 1.6) / (g.texW || 64) : 0;
      // distinct cache key per shader variant - otherwise three reuses one
      // compiled program across materials and the patches get cross-assigned
      mat.customProgramCacheKey = () => `aq2_${warp ? 'w' : ''}_${flow.toFixed(5)}`;
      mat.onBeforeCompile = shader => {
        shader.uniforms.uTime = ctx.timeUniform;
        shader.uniforms.uBright = brightUniform;
        // meshbasic inlines its lightmap accumulation (no lightmap_fragment chunk)
        shader.fragmentShader = 'uniform float uTime;\nuniform float uBright;\n' + shader.fragmentShader.replace(
          'reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;',
          'reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI + vec3( uBright );',
        );
        if (warp || flow) {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
              vec2 aqUv = vMapUv;
              ${warp ? 'aqUv += 0.045 * sin(vMapUv.yx * 8.0 + uTime * 0.9);' : ''}
              ${flow ? `aqUv.x -= uTime * ${flow.toFixed(5)};` : ''}
              vec4 sampledDiffuseColor = texture2D( map, aqUv );
              diffuseColor *= sampledDiffuseColor;
            #endif`,
          );
        }
      };
    }
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
    ctx.timeUniform.value = now / 1000;
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
