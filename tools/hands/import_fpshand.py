"""Build an AQ2 view-weapon MD3 from the CC0 'Animated FPS HAND' (OpenGameArt) arms + animation
and our own M4 mesh/skin.

    blender -b -P import_fpshand.py -- FPS_Hand.blend v_m4.md2 skin.png out.md3 out_skin.png [--s 94.6 --ox 17.4 --oy -7.8 --oz -17.3] [--gain 0.4] [--dump dir]

Their space (metres-ish, gun along -y, +x = left, +z up) -> ours (gun along +x, +y left, +z up):
    our = (-s*y + ox,  s*x + oy,  s*z + oz)
Our M4 follows their weapon bone's per-frame motion. AQ2 frame list (72 frames) is filled by
resampling their clips: idle 1-16, shoot 29-44, reload 59-126 (25 fps); active/putaway reuse
the old md2's gun motion on the idle pose.
"""
import sys, os, math, struct
import numpy as np
import bpy
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
BLEND, MD2, SKIN, OUT_MD3, OUT_SKIN = [os.path.abspath(a) for a in argv[:5]]
def opt(k, d): return float(argv[argv.index(k) + 1]) if k in argv else d
S, OX, OY, OZ = opt('--s', 94.6), opt('--ox', 17.4), opt('--oy', -7.8), opt('--oz', -17.3)
GAIN = opt('--gain', 0.4)
DUMP = os.path.abspath(argv[argv.index('--dump') + 1]) if '--dump' in argv else None
REF = 30
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from md2_to_md3 import read_md2, write_md3

md2 = read_md2(MD2)
W, H = md2['skinw'], md2['skinh']
REGIONS = [(0.335, 0.495), (0.835, 0.985)]
def tri_u(t): return sum(md2['st'][t[3 + k]][0] / W for k in range(3)) / 3
gun_tris = [t for t in md2['tris'] if not any(a <= tri_u(t) <= b for a, b in REGIONS)]
frames_np = [np.array(f[1], dtype=np.float64) for f in md2['frames']]
names = [f[0] for f in md2['frames']]
gun_vidx = sorted({t[k] for t in gun_tris for k in range(3)})
def kabsch(P, Q):
    cp, cq = P.mean(axis=0), Q.mean(axis=0)
    U, Sg, Vt = np.linalg.svd((P - cp).T @ (Q - cq))
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1, 1, d]) @ U.T
    return R, cq - R @ cp
old_motion = [kabsch(frames_np[REF][gun_vidx], frames_np[f][gun_vidx]) for f in range(len(frames_np))]

# ---- their scene ----
bpy.ops.wm.open_mainfile(filepath=BLEND)
sc = bpy.context.scene
arms = bpy.data.objects['testMesh']; weapon = bpy.data.objects['weapon']
A = Matrix([[0, -S, 0, OX], [S, 0, 0, OY], [0, 0, S, OZ], [0, 0, 0, 1]])   # their world -> our gun space
Ainv = A.inverted()

# AQ2 frame -> their frame (float) or ('old', f) for frames driven by the old md2 motion
def their_frame(i, name):
    base = name.rstrip('0123456789'); k = int(name[len(base):])
    if base == 'idle':   return 1 + 15 * (k / 26.0)
    if base == 'fire':   return [30, 35][k]
    if base == 'lastround': return [30, 35][k]
    if base == 'burstfire': return 29 + 15 * (k / 5.0)
    if base == 'reload': return 59 + 67 * (k / 18.0)
    return None   # active / putaway
plan = [(i, n, their_frame(i, n)) for i, n in enumerate(names)]
print('frame plan:', [(n, None if t is None else round(t, 1)) for i, n, t in plan][:80])

# ---- arm mesh topology + UVs (taken once, from frame 1) ----
sc.frame_set(1); bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get(); ev = arms.evaluated_get(dg); me = ev.to_mesh(); me.calc_loop_triangles()
uvl = me.uv_layers.active.data
key_to_i, a_uvs, a_src, a_tris = {}, [], [], []
for lt in me.loop_triangles:
    idx = []
    for li in lt.loops:
        vi = me.loops[li].vertex_index; u, v = uvl[li].uv
        k = key_to_i.get((vi, round(u, 5), round(v, 5)))
        if k is None:
            k = len(a_uvs); key_to_i[(vi, round(u, 5), round(v, 5))] = k; a_uvs.append((u, v)); a_src.append(vi)
        idx.append(k)
    a_tris.append(tuple(idx))
nv_arms = len(me.vertices); ev.to_mesh_clear(); a_src = np.array(a_src)
print('arms: %d verts (%d split) %d tris' % (nv_arms, len(a_uvs), len(a_tris)))

def arms_at(t):
    """posed arm vertices (all mesh verts) in OUR space at their (float) frame t"""
    sc.frame_set(int(round(t))); bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get(); ev = arms.evaluated_get(dg); m = ev.to_mesh()
    M = A @ arms.matrix_world
    P = np.array([(M @ v.co)[:] for v in m.vertices]); ev.to_mesh_clear()
    Mg = A @ weapon.matrix_world @ Ainv                  # our M4 follows their weapon
    return P, Mg
_, Mg1 = arms_at(1); Mg1inv = Mg1.inverted()

# ---- skin: our M4 on top, their hand texture (square) below ----
simg = bpy.data.images.load(SKIN); SW, SH = simg.size
himg = None
for im in bpy.data.images:
    if 'Hand_TEX' in im.name: himg = im
himg.scale(SW, SW); BH = SW
hp = np.array(himg.pixels[:], dtype=np.float32).reshape(BH, SW, 4); hp[..., :3] *= GAIN; hp[..., 3] = 1
GUN_F = SH / (SH + BH)

# ---- assemble MD3 ----
key_to_i, g_uvs, g_src, g_tris = {}, [], [], []
for t in gun_tris:
    idx = []
    for k in range(3):
        vi, st = t[k], t[3 + k]
        kk = key_to_i.get((vi, st))
        if kk is None:
            kk = len(g_uvs); key_to_i[(vi, st)] = kk; g_uvs.append((md2['st'][st][0] / W, md2['st'][st][1] / H * GUN_F)); g_src.append(vi)
        idx.append(kk)
    g_tris.append(tuple(idx))
g_src = np.array(g_src)
def smooth_normals(T, Vv):
    n = np.zeros_like(Vv)
    for a, b, c in T:
        fn = np.cross(Vv[b] - Vv[a], Vv[c] - Vv[a]); n[a] += fn; n[b] += fn; n[c] += fn
    l = np.linalg.norm(n, axis=1); l[l == 0] = 1
    return n / l[:, None]
base = len(g_uvs)
all_tris = list(g_tris) + [tuple(base + i for i in t) for t in a_tris]
all_uvs = list(g_uvs) + [(u, GUN_F + (1 - v) * (1 - GUN_F)) for (u, v) in a_uvs]
loc_tris = [tuple(t) for t in a_tris]
fverts, fnorms = [], []
gun_ref = frames_np[REF][g_src]
idle_P, _ = arms_at(1)
for i, n, t in plan:
    if t is None:                       # active/putaway: old md2 gun motion applied to the idle pose
        R, tr = old_motion[i]
        gv = gun_ref @ R.T + tr; av = idle_P @ R.T + tr
    else:
        P, Mg = arms_at(t)
        Mrel = np.array(Mg @ Mg1inv)
        gv = gun_ref @ Mrel[:3, :3].T + Mrel[:3, 3]; av = P
    a = av[a_src]
    fverts.append([tuple(v) for v in gv] + [tuple(v) for v in a])
    fnorms.append([tuple(v) for v in smooth_normals(g_tris, gv)] + [tuple(v) for v in smooth_normals(loc_tris, a)])
    if i in (0, 13, 30, 45, 55):
        print('frame %2d %-11s gun bbox %s..%s arms bbox %s..%s' % (i, n, np.round(gv.min(0), 1), np.round(gv.max(0), 1), np.round(a.min(0), 1), np.round(a.max(0), 1)))
nsurf = write_md3(OUT_MD3, os.path.basename(OUT_MD3), names, 'mesh', md2['skins'][0], all_tris, all_uvs, fverts, fnorms)
print('MD3: %d verts, %d tris, %d surfaces -> %s' % (len(all_uvs), len(all_tris), nsurf, OUT_MD3))
px = np.array(simg.pixels[:], dtype=np.float32).reshape(SH, SW, 4)
oimg = bpy.data.images.new('combined', SW, SH + BH, alpha=True)
oimg.pixels = np.concatenate([hp, px], axis=0).ravel().tolist()
oimg.filepath_raw = OUT_SKIN; oimg.file_format = 'PNG'; oimg.save(); print('skin written', OUT_SKIN, SW, SH + BH)
