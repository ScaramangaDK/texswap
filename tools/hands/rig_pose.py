"""Rig the MakeHuman arms and pose them on a weapon by explicit hand frames.

    blender -b -P rig_pose.py -- arms_uv.blend arms_joints.json pose.json out.blend [--md2 v_m4.md2 --skin skin.png --band arm_band.png --md3 out.md3 --outskin out_skin.png] [--render dir]

pose.json (gun space: x forward, y left, z up):
{ "scale": 1.25,
  "l": {"wrist": [x,y,z], "fdir": [..], "palm": [..], "elbow_dir": [..],
        "curl": {"1": [a,b,c], "2": [...], ...}, "thumb_along": true},
  "r": {...} }
wrist     = where the wrist joint goes; fdir = wrist -> knuckles direction; palm = palm normal (out of the palm);
elbow_dir = direction from the wrist toward the elbow; curl = joint angles (deg) per finger (1 = thumb).
Frames: the gun's own per-frame rigid motion (Kabsch, REF frame 30) moves both hands with the gun.
"""
import sys, os, json, math, struct
import numpy as np
import bpy
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
arms_blend, joints_path, pose_path, out_blend = [os.path.abspath(a) for a in argv[:4]]
def opt(k):
    return os.path.abspath(argv[argv.index(k) + 1]) if k in argv else None
MD2, SKIN, BAND, MD3, OUTSKIN, RENDER = opt('--md2'), opt('--skin'), opt('--band'), opt('--md3'), opt('--outskin'), opt('--render')
REF = 30

pose = json.load(open(pose_path))
SCALE = float(pose.get('scale', 1.0))
bpy.ops.wm.open_mainfile(filepath=arms_blend)
joints = json.load(open(joints_path))

def V3(a): return Vector([float(x) for x in a])
def unit(v): v = Vector(v); return v / v.length

# ---------------- gun (optional) ----------------
gun = None
if MD2:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    from md2_to_md3 import read_md2, write_md3
    md2 = read_md2(MD2)
    W, H = md2['skinw'], md2['skinh']
    REGIONS = [(0.335, 0.495), (0.835, 0.985)]        # old arm strips in the M4 skin
    def tri_u(t): return sum(md2['st'][t[3 + k]][0] / W for k in range(3)) / 3
    gun_tris = [t for t in md2['tris'] if not any(a <= tri_u(t) <= b for a, b in REGIONS)]
    frames_np = [np.array(f[1], dtype=np.float64) for f in md2['frames']]
    gun_vidx = sorted({t[k] for t in gun_tris for k in range(3)})
    def kabsch(P, Q):
        cp, cq = P.mean(axis=0), Q.mean(axis=0)
        U, S, Vt = np.linalg.svd((P - cp).T @ (Q - cq))
        d = np.sign(np.linalg.det(Vt.T @ U.T))
        R = Vt.T @ np.diag([1, 1, d]) @ U.T
        return R, cq - R @ cp
    gun_motion = [kabsch(frames_np[REF][gun_vidx], frames_np[f][gun_vidx]) for f in range(len(frames_np))]
    gun = dict(tris=gun_tris, frames=frames_np)

# ---------------- rig one arm ----------------
def build_arm(side):
    ob = bpy.data.objects['arm_%s' % side]
    j = joints[side]
    P = pose[side]
    # --- scale + the rest->target rigid transform is applied to the MESH (object matrix), the armature follows ---
    # rest frame of the hand: origin wrist, Y = wrist->knuckle mean, Z = back of hand (-palm)
    wrist_r = V3(j['wrist']); kn_r = [V3(j['fingers'][str(i)][0]) for i in range(2, 6)]
    knc_r = sum(kn_r, Vector()) / 4
    pts = np.array([list(k) for k in kn_r] + [list(wrist_r)])
    n_r = Vector(np.linalg.svd(pts - pts.mean(axis=0))[2][2])
    # palm sign: the thumb-side/knuckle test is unreliable; use MakeHuman's known rest: palms face inward (-x for left, +x for right)
    if (n_r.x < 0) != (side == 'l'): n_r = -n_r
    palm_r = unit(n_r); y_r = unit(knc_r - wrist_r); x_r = unit(y_r.cross(-palm_r)); z_r = unit(x_r.cross(y_r))
    Rrest = Matrix([[x_r.x, y_r.x, z_r.x], [x_r.y, y_r.y, z_r.y], [x_r.z, y_r.z, z_r.z]])   # columns = rest axes
    # target frame from pose.json
    fdir = unit(V3(P['fdir'])); palm = unit(V3(P['palm']))
    palm = unit(palm - fdir * fdir.dot(palm))            # orthogonalise
    x_t = unit(fdir.cross(-palm)); z_t = unit(x_t.cross(fdir))
    Rt = Matrix([[x_t.x, fdir.x, z_t.x], [x_t.y, fdir.y, z_t.y], [x_t.z, fdir.z, z_t.z]])
    R = Rt @ Rrest.transposed()                            # rest axes -> target axes
    wrist_t = V3(P['wrist'])
    M = Matrix.Translation(wrist_t) @ (R @ Matrix.Scale(SCALE, 3)).to_4x4() @ Matrix.Translation(-wrist_r)
    ob.matrix_world = M
    # --- armature in TARGET space (bones created from transformed joints) ---
    def T(p): return M @ V3(p)
    arm_data = bpy.data.armatures.new('rig_%s' % side); rig = bpy.data.objects.new('rig_%s' % side, arm_data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    cut, wrist, knc = T(j['cut']), T(j['wrist']), sum((T(j['fingers'][str(i)][0]) for i in range(2, 6)), Vector()) / 4
    palm_w = unit(R @ palm_r)
    fore = eb.new('forearm'); fore.head, fore.tail = cut, wrist; fore.align_roll(-palm_w)
    hand = eb.new('hand'); hand.head, hand.tail = wrist, knc; hand.parent = fore; hand.use_connect = True; hand.align_roll(-palm_w)
    for fi in range(1, 6):
        ch = [T(p) for p in j['fingers'][str(fi)]]
        parent = hand
        for k in range(3):
            b = eb.new('f%d_%d' % (fi, k)); b.head, b.tail = ch[k], ch[k + 1]; b.parent = parent
            b.use_connect = (k > 0); b.align_roll(-palm_w)         # local Z = back of hand -> curl = rotation about local X
            parent = b
    bpy.ops.object.mode_set(mode='OBJECT')
    # --- bind with automatic weights ---
    for o in bpy.data.objects: o.select_set(False)
    ob.select_set(True); rig.select_set(True); bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    ob.select_set(False); rig.select_set(False)
    # --- pose: forearm direction (elbow), finger curls, thumb ---
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    pb = rig.pose.bones
    for b in pb: b.rotation_mode = 'XYZ'
    # forearm: keep the wrist fixed, aim the elbow along elbow_dir
    if 'elbow_dir' in P:
        ed = unit(V3(P['elbow_dir'])); L = (wrist - cut).length
        new_cut = wrist + ed * L
        # rotation that maps (cut->wrist) onto (new_cut->wrist), applied about the wrist... bones rotate about their head,
        # so rotate the forearm about its head and translate the head to new_cut
        want = unit(wrist - new_cut); have = unit(wrist - cut)
        q = have.rotation_difference(want)
        pb['forearm'].matrix = Matrix.Translation(new_cut) @ (q.to_matrix().to_4x4() @ Matrix.Translation(-cut) @ pb['forearm'].bone.matrix_local)
        bpy.context.view_layer.update()
        # the hand keeps its world orientation: counter-rotate
        hm = pb['hand'].bone.matrix_local.copy(); hm.translation = wrist
        pb['hand'].matrix = hm
        bpy.context.view_layer.update()
    curls = P.get('curl', {})
    for fi in range(1, 6):
        angs = curls.get(str(fi), [0, 0, 0])
        if fi == 1 and P.get('thumb_along'):
            # lay the thumb along the index finger: rotate the thumb base about the palm normal (local Z) toward the index direction
            b0 = pb['f1_0']; idx = pb['f2_0']
            t_dir = unit(b0.tail - b0.head); i_dir = unit(idx.tail - idx.head)
            n = unit(R @ palm_r)
            a = math.atan2(t_dir.cross(i_dir).dot(n), t_dir.dot(i_dir))
            b0.rotation_euler = (0, 0, a)
            bpy.context.view_layer.update()
            if P.get('thumb_flat'):
                # press the thumb down into the palm plane (it naturally stands ~30 deg out of it)
                t_dir = unit(b0.tail - b0.head); flat = unit(t_dir - n * t_dir.dot(n))
                q = t_dir.rotation_difference(flat)
                b0.matrix = Matrix.Translation(b0.head) @ q.to_matrix().to_4x4() @ Matrix.Translation(-b0.head) @ b0.matrix
                bpy.context.view_layer.update()
        for k in range(3):
            b = pb['f%d_%d' % (fi, k)]
            if fi == 1 and k == 0 and P.get('thumb_along'):
                b.rotation_euler = (math.radians(angs[k]) * P.get('curl_sign', 1) + b.rotation_euler.x, b.rotation_euler.y, b.rotation_euler.z)
            else:
                b.rotation_euler = (math.radians(angs[k]) * P.get('curl_sign', 1), 0, 0)
    bpy.context.view_layer.update()
    # --- debug: actual posed hand frame vs. target ---
    Mw = rig.matrix_world
    kn = [(Mw @ pb['f%d_0' % i].head) for i in range(2, 6)]; wr = Mw @ pb['hand'].head; th = Mw @ pb['f1_1'].head
    knc = sum(kn, Vector()) / 4; f_act = unit(knc - wr)
    ptsw = np.array([list(k) for k in kn] + [list(wr)]); n_act = Vector(np.linalg.svd(ptsw - ptsw.mean(axis=0))[2][2])
    side_sign = 1 if side == 'l' else -1
    if (th - Vector(ptsw.mean(axis=0))).dot(n_act.cross(f_act)) * side_sign < 0: n_act = -n_act   # thumb rule: left thumb = palm x fdir
    print('%s posed: wrist %s fdir %s (want %s) palm %s (want %s) rest-palm-sign n_r.x=%.2f' % (side, tuple(round(x, 1) for x in wr), tuple(round(x, 2) for x in f_act), tuple(round(x, 2) for x in fdir), tuple(round(x, 2) for x in n_act), tuple(round(x, 2) for x in palm), n_r.x))
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()
    return ob, rig

arms = {s: build_arm(s) for s in ('l', 'r') if s in pose}

# ---------------- verify the curl direction (tips should move toward the palm) ----------------
for s, (ob, rig) in arms.items():
    dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg).to_mesh()
    posed = np.array([ob.matrix_world @ v.co for v in ev.vertices]); ob.evaluated_get(dg).to_mesh_clear()
    print('%s arm posed: bbox %s .. %s' % (s, np.round(posed.min(axis=0), 1), np.round(posed.max(axis=0), 1)))

bpy.ops.wm.save_as_mainfile(filepath=out_blend)
print('saved', out_blend)

# ---------------- renders ----------------
if RENDER:
    os.makedirs(RENDER, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'; scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'OBJECT'
    scene.render.resolution_x, scene.render.resolution_y = 960, 640
    if gun:
        me = bpy.data.meshes.new('gun'); me.from_pydata([tuple(v) for v in gun['frames'][REF]], [], [(t[0], t[1], t[2]) for t in gun['tris']]); me.update()
        g = bpy.data.objects.new('gun', me); bpy.context.collection.objects.link(g); g.color = (0.5, 0.5, 0.5, 1)
    for ob, rig in arms.values(): ob.color = (0.85, 0.6, 0.5, 1); rig.hide_render = True
    cam_data = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_data); bpy.context.collection.objects.link(cam)
    cam_data.clip_start = 0.5; cam_data.clip_end = 2000; scene.camera = cam
    views = [('eye', (0, 0, 0), (60, -18, -14), 100), ('side', (40, -160, -20), (40, -20, -20), 40), ('top', (40, -20, 140), (40, -20, -20), 40),
             ('grip', (50, -75, -45), (22, -24, -22), 35), ('grip_below', (35, -30, -85), (22, -23, -22), 40), ('guard', (70, -45, -60), (63, -20, -16), 40), ('guard_front', (110, -10, -30), (62, -20, -12), 40)]
    views += [('side_ortho', (40, -200, -20), (40, -20, -20), 0), ('top_ortho', (40, -20, 200), (40, -20, -20), 0), ('grip_ortho', (22, -200, -22), (22, -24, -22), -45), ('guard_ortho', (62, -200, -14), (62, -20, -14), -45)]
    for name, loc, aim, fov in views:
        cam.location = loc; cam.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        if fov <= 0:
            cam_data.type = 'ORTHO'; cam_data.ortho_scale = 120 if fov == 0 else -fov
        else:
            cam_data.type = 'PERSP'; cam_data.angle = math.radians(fov)
        scene.render.filepath = os.path.join(RENDER, name + '.png'); bpy.ops.render.render(write_still=True)
    print('renders in', RENDER)

# ---------------- MD3 export ----------------
if MD3 and gun:
    W, H = md2['skinw'], md2['skinh']
    simg = bpy.data.images.load(SKIN); SW, SH = simg.size
    bimg = bpy.data.images.load(BAND) if BAND else None
    BH = int(round(bimg.size[1] * SW / bimg.size[0])) if bimg else SH
    GUN_F = SH / (SH + BH)
    nframes = len(gun['frames'])
    # gun surface
    key_to_i, uvs, src, tris = {}, [], [], []
    for t in gun['tris']:
        idx = []
        for k in range(3):
            vi, st = t[k], t[3 + k]
            kk = key_to_i.get((vi, st))
            if kk is None:
                kk = len(uvs); key_to_i[(vi, st)] = kk; uvs.append((md2['st'][st][0] / W, md2['st'][st][1] / H * GUN_F)); src.append(vi)
            idx.append(kk)
        tris.append(tuple(idx))
    def smooth_normals(T, Vv):
        n = np.zeros_like(Vv)
        for a, b, c in T:
            fn = np.cross(Vv[b] - Vv[a], Vv[c] - Vv[a]); n[a] += fn; n[b] += fn; n[c] += fn
        l = np.linalg.norm(n, axis=1); l[l == 0] = 1
        return n / l[:, None]
    fverts = [[] for _ in range(nframes)]; fnorms = [[] for _ in range(nframes)]
    g_src = np.array(src)
    for f in range(nframes):
        gv = gun['frames'][f][g_src]; fverts[f].extend(map(tuple, gv)); fnorms[f].extend(map(tuple, smooth_normals(tris, gv)))
    all_tris, all_uvs = list(tris), list(uvs)
    for s, (ob, rig) in arms.items():
        dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg); me = ev.to_mesh(); me.calc_loop_triangles()
        uvl = me.uv_layers.active.data
        posed = np.array([ob.matrix_world @ v.co for v in me.vertices])
        key_to_i, a_uvs, a_src, a_tris = {}, [], [], []
        base = len(all_uvs)
        for lt in me.loop_triangles:
            idx = []
            for li in lt.loops:
                vi = me.loops[li].vertex_index; u, v = uvl[li].uv
                k = key_to_i.get((vi, round(u, 5), round(v, 5)))
                if k is None:
                    k = len(a_uvs); key_to_i[(vi, round(u, 5), round(v, 5))] = k; a_uvs.append((u, GUN_F + (1 - v) * (1 - GUN_F))); a_src.append(vi)
                idx.append(base + k)
            a_tris.append(tuple(idx))
        ev.to_mesh_clear()
        all_uvs.extend(a_uvs); all_tris.extend(a_tris)
        loc = [tuple(i - base for i in t) for t in a_tris]; a_src = np.array(a_src)
        for f in range(nframes):
            Rf, tf = gun_motion[f]
            pv = posed[a_src] @ Rf.T + tf
            fverts[f].extend(map(tuple, pv)); fnorms[f].extend(map(tuple, smooth_normals(loc, pv)))
    names = [fn for fn, _ in md2['frames']]
    n = write_md3(MD3, os.path.basename(MD3), names, 'mesh', md2['skins'][0], all_tris, all_uvs, fverts, fnorms)
    print('MD3: %d verts, %d tris, %d surfaces -> %s' % (len(all_uvs), len(all_tris), n, MD3))
    if OUTSKIN:
        px = np.array(simg.pixels[:], dtype=np.float32).reshape(SH, SW, 4)
        if bimg:
            bimg.scale(SW, BH); band = np.array(bimg.pixels[:], dtype=np.float32).reshape(BH, SW, 4); band[..., :3] *= float(pose.get('bandgain', 0.35)); band[..., 3] = 1
        else:
            band = np.zeros((BH, SW, 4), dtype=np.float32); band[..., :3] = (0.3, 0.2, 0.15); band[..., 3] = 1
        oimg = bpy.data.images.new('combined', SW, SH + BH, alpha=True)
        oimg.pixels = np.concatenate([band, px], axis=0).ravel().tolist()
        oimg.filepath_raw = OUTSKIN; oimg.file_format = 'PNG'; oimg.save(); print('skin written', OUTSKIN)
