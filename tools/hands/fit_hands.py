"""Fit new arm meshes (MakeHuman, CC0) onto an AQ2 view model's old arm animation.

    blender -b -P tools/hands/fit_hands.py -- v_m4.md2 skin.png arms_uv.blend arms_joints.json out.md3 out_skin.png
            --band arm_band.png --bandgain 0.35 --scale 1.25 --curl_l 0.7 --thumb_l along
            --palmdir_l 0,-0.15,1 --hand_l 62,-20,-14.5 --palmdir_r 0,1,0 --hand_r 22.5,-26,-20.5 [--gunmove 0,3,6] [--render dir]

The M4 settings above are the shipped ones (v3). Per weapon you set: --palmdir_<side>
(direction the palm faces, gun space: x forward, y left, z up), --hand_<side> (palm-centre
position; without it the palm slides along its normal until it touches the gun),
--curl_<side> (0..1), --thumb_<side> along|curl, --scale (hand size), --gunmove (shift the
whole model), --shift/--move for small corrections. See tools/hands/README.md.
                             [--scale k] [--render dir]

Old arm/hand triangles are found by their skin UV strips, then grouped into the
two arms by touching pieces (fingers, palms and forearms are separate islands).
Each new arm is aligned onto its old arm at a reference frame with a scaled
rigid ICP started from many orientations, then follows the old arm's per-frame
rigid motion (Kabsch). Output: one MD3 (gun surface with the old UVs squeezed
into the top band, two arm surfaces in the bottom band) plus the 2-band skin.
"""
import sys, os, json, math
import numpy as np
import bpy
from mathutils import Vector, kdtree

TOOLS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')   # md2_to_md3.py lives one level up
sys.path.insert(0, TOOLS)
from md2_to_md3 import read_md2, write_md3

argv = sys.argv[sys.argv.index('--') + 1:]
md2_path, skin_path, arms_blend, joints_path, out_md3, out_skin = [os.path.abspath(a) for a in argv[:6]]
opt = lambda k, d: float(argv[argv.index(k) + 1]) if k in argv else d
SCALE = opt('--scale', 1.0)
CURL = opt('--curl', 1.0)          # 1 = full grip, 0 = open hand
CURLS = {'l': opt('--curl_l', CURL), 'r': opt('--curl_r', CURL)}
GAP = opt('--gap', 1.2)
THUMB = {k: (argv[argv.index('--thumb_' + k) + 1] if '--thumb_' + k in argv else 'curl') for k in ('l', 'r')}   # 'along' = thumb laid parallel to the index finger (resting along the barrel)
GUNMOVE = np.array([float(x) for x in argv[argv.index('--gunmove') + 1].split(',')]) if '--gunmove' in argv else np.zeros(3)   # shift the whole model (gun + hands) in every frame
HAND = {k: (np.array([float(x) for x in argv[argv.index('--hand_' + k) + 1].split(',')]) if '--hand_' + k in argv else None) for k in ('l', 'r')}   # put the palm centre HERE (gun space) instead of the contact push            # palm-to-gun distance after the contact push (gun units)
PALMDIR = {k: (np.array([float(x) for x in argv[argv.index('--palmdir_' + k) + 1].split(',')]) if '--palmdir_' + k in argv else None) for k in ('l', 'r')}   # force the palm-facing direction (gun space)
PALM = opt('--palm', 1.0)
SHIFT = {'l': opt('--shift_l', 0.0), 'r': opt('--shift_r', 0.0)}
MOVE = {k: (np.array([float(x) for x in argv[argv.index('--move_' + k) + 1].split(',')]) if '--move_' + k in argv else np.zeros(3)) for k in ('l', 'r')}   # constant offset in gun space (x fwd, y left, z up)   # move a hand away from its palm side (out of the grip), gun units          # -1 flips the curl direction if it bends the wrong way
RENDER = argv[argv.index('--render') + 1] if '--render' in argv else None
BAND = os.path.abspath(argv[argv.index('--band') + 1]) if '--band' in argv else None
BAND_GAIN = opt('--bandgain', 1.0)   # q2 lights view models ~2.5x: stock skins are stored dark, so darken the bake
# skin layout: gun skin (iw x ih) on top, arm band (iw x bh) below; bh = ih unless a baked band is given
_skin_img = bpy.data.images.load(skin_path); SKIN_W, SKIN_H = _skin_img.size
if BAND:
    _band_img = bpy.data.images.load(BAND)
    BAND_H = int(round(_band_img.size[1] * SKIN_W / _band_img.size[0]))
else:
    BAND_H = SKIN_H
GUN_F = SKIN_H / (SKIN_H + BAND_H)        # fraction of the combined height used by the gun
print('skin %dx%d + band %dx%d' % (SKIN_W, SKIN_H, SKIN_W, BAND_H))
REGIONS = [(0.335, 0.495), (0.835, 0.985)]
REF = 30   # reference frame: mid idle, both hands on the gun
rng = np.random.default_rng(1)

md2 = read_md2(md2_path)
W, H = md2['skinw'], md2['skinh']
nframes = len(md2['frames'])
frames_np = [np.array(f[1], dtype=np.float64) for f in md2['frames']]

# ---- old arms: triangles by UV strip, grouped into two arms by touching pieces ----
def tri_u(t):
    return sum(md2['st'][t[3 + k]][0] / W for k in range(3)) / 3
arm_all, gun_tris = [], []
for t in md2['tris']:
    (arm_all if any(a <= tri_u(t) <= b for a, b in REGIONS) else gun_tris).append(t)
parent = list(range(len(md2['frames'][0][1])))
def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]; x = parent[x]
    return x
for t in arm_all:
    for k in (1, 2): parent[find(t[0])] = find(t[k])
pieces = {}
for t in arm_all: pieces.setdefault(find(t[0]), []).append(t)
pieces = list(pieces.values())
piece_v = [sorted({t[k] for t in p for k in range(3)}) for p in pieces]
Pref = frames_np[REF]
touch = 2.5
labels = list(range(len(pieces)))
def lfind(i):
    while labels[i] != i:
        labels[i] = labels[labels[i]]; i = labels[i]
    return i
for i in range(len(pieces)):
    for j in range(i + 1, len(pieces)):
        A, B = Pref[piece_v[i]], Pref[piece_v[j]]
        d = np.sqrt(((A[:, None, :] - B[None, :, :]) ** 2).sum(-1)).min()
        if d < touch: labels[lfind(i)] = lfind(j)
clusters = {}
for i in range(len(pieces)): clusters.setdefault(lfind(i), []).extend(pieces[i])
clusters = sorted(clusters.values(), key=len, reverse=True)
print('arm pieces %d -> clusters %s' % (len(pieces), [len(c) for c in clusters]))
old_arms = []
for tris in clusters[:2]:
    vidx = sorted({t[k] for t in tris for k in range(3)})
    old_arms.append(dict(tris=tris, vidx=vidx, cref=Pref[vidx].mean(axis=0)))
for c in clusters[2:]:
    gun_tris.extend(c)
if old_arms[0]['cref'][1] < old_arms[1]['cref'][1]: old_arms.reverse()
old_arms[0]['side'], old_arms[1]['side'] = 'l', 'r'
for oa in old_arms:
    print('old %s arm: %d tris, centroid@%d %s' % (oa['side'], len(oa['tris']), REF, np.round(oa['cref'], 1)))

def kabsch(P, Q):
    cp, cq = P.mean(axis=0), Q.mean(axis=0)
    U, S, Vt = np.linalg.svd((P - cp).T @ (Q - cq))
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1, 1, d]) @ U.T
    return R, cq - R @ cp

def surface_samples(tris, verts, n):
    T = np.array([[t[0], t[1], t[2]] for t in tris])
    A, B, C = verts[T[:, 0]], verts[T[:, 1]], verts[T[:, 2]]
    area = np.linalg.norm(np.cross(B - A, C - A), axis=1) / 2
    idx = rng.choice(len(T), size=n, p=area / area.sum())
    r1, r2 = np.sqrt(rng.random(n)), rng.random(n)
    return (1 - r1)[:, None] * A[idx] + (r1 * (1 - r2))[:, None] * B[idx] + (r1 * r2)[:, None] * C[idx]

# ---- new arms ----
bpy.ops.wm.open_mainfile(filepath=arms_blend)
joints = json.load(open(joints_path))
new_arms = {}
for side in ('l', 'r'):
    me = bpy.data.objects['arm_%s' % side].data
    me.calc_loop_triangles()
    V = np.array([v.co[:] for v in me.vertices], dtype=np.float64)
    uvl = me.uv_layers.active.data
    key_to_i, uvs, src, tris = {}, [], [], []
    for lt in me.loop_triangles:
        idx = []
        for li in lt.loops:
            vi = me.loops[li].vertex_index
            u, v = uvl[li].uv
            k = key_to_i.get((vi, round(u, 5), round(v, 5)))
            if k is None:
                k = len(uvs); key_to_i[(vi, round(u, 5), round(v, 5))] = k; uvs.append((u, v)); src.append(vi)
            idx.append(k)
        tris.append(tuple(idx))
    j = joints[side]
    new_arms[side] = dict(V=V, src=np.array(src), uvs=uvs, tris=tris,
                          wrist=np.array(j['wrist']), elbow=np.array(j['elbow']), cut=np.array(j['cut']), tip=np.array(j['tip']))

def rot_between(a, b):
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v = np.cross(a, b); s_ = np.linalg.norm(v); c = float(np.dot(a, b))
    if s_ < 1e-9: return np.eye(3) if c > 0 else -np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / (s_ * s_))

# ---- finger posing (rest space): curl each finger about its joints toward the palm ----
def rot_axis(axis, ang):
    axis = axis / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * K @ K

def seg_dist(P, a, b):
    ab = b - a; t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)

# per-joint angles (MCP, PIP, DIP) in degrees. MakeHuman: finger 1 = thumb, 2 = index, 5 = pinky.
GRIP = {
    'r': {1: (35, 30, 15), 2: (45, 40, 20), 3: (70, 85, 40), 4: (75, 90, 45), 5: (80, 90, 50)},   # trigger hand: index bent onto the trigger
    'l': {1: (40, 30, 15), 2: (55, 70, 35), 3: (60, 80, 40), 4: (65, 85, 45), 5: (70, 90, 50)},   # support hand wraps the handguard
}

def curl_fingers(V, j, curl, palm_sign, grip, thumb='curl'):
    V = V.copy()
    wrist = np.array(j['wrist'])
    chains = {fi: np.array(j['fingers'][str(fi)], dtype=np.float64) for fi in range(1, 6)}
    knuckles = np.array([chains[fi][0] for fi in range(2, 6)])
    pts = np.vstack([knuckles, wrist[None]])
    c = pts.mean(axis=0); U, S, Vt = np.linalg.svd(pts - c)
    normal = Vt[2] * palm_sign
    hand_dir = knuckles.mean(axis=0) - wrist; hand_dir /= np.linalg.norm(hand_dir)
    # candidate hand vertices: beyond the wrist, then assigned to the nearest finger chain
    cand = np.where((V - wrist) @ hand_dir > 0.01)[0]
    dists = np.stack([np.minimum.reduce([seg_dist(V[cand], ch[k], ch[k + 1]) for k in range(3)]) for fi, ch in sorted(chains.items())], axis=1)
    owner = dists.argmin(axis=1) + 1
    for fi in range(1, 6):
        ch = chains[fi].copy()
        mine = cand[owner == fi]
        fdir = ch[3] - ch[0]; fdir /= np.linalg.norm(fdir)
        if fi == 1 and thumb == 'along':
            # lay the thumb parallel to the index finger: one rotation about the thumb base, no curl
            idx_dir = chains[2][3] - chains[2][0]; idx_dir /= np.linalg.norm(idx_dir)
            R = rot_between(fdir, idx_dir)
            V[mine] = (V[mine] - ch[0]) @ R.T + ch[0]
            continue
        axis = np.cross(fdir, normal)      # tips move toward +normal (the palm side)
        for k in range(3):
            ang = math.radians(grip[fi][k] * curl)
            if ang == 0: continue
            R = rot_axis(axis, ang)
            proj = (V[mine] - ch[k]) @ fdir
            sel = mine[proj > -0.004]
            V[sel] = (V[sel] - ch[k]) @ R.T + ch[k]
            for kk in range(k + 1, 4): ch[kk] = (ch[kk] - ch[k]) @ R.T + ch[k]
            fdir = ch[3] - ch[k]; fdir /= np.linalg.norm(fdir)
    return V

for side in ('l', 'r'):
    na = new_arms[side]
    na['V_rest'] = na['V']
    na['V'] = curl_fingers(na['V'], joints[side], CURLS[side], PALM, GRIP[side], THUMB[side])
    _j = joints[side]; _kn = np.array([_j['fingers'][str(fi)][0] for fi in range(2, 6)]); _pts = np.vstack([_kn, np.array(_j['wrist'])[None]])
    _n = np.linalg.svd(_pts - _pts.mean(axis=0))[2][2]
    _mv = np.linalg.norm(na['V'] - na['V_rest'], axis=1) > 1e-6
    print('%s hand: fingertips moved %.3f along the palm-plane normal %s (thumb side check: %.3f)' % (side, ((na['V'][_mv] - na['V_rest'][_mv]).mean(axis=0)) @ _n, np.round(_n, 2), (np.array(_j['fingers']['1'][1]) - _pts.mean(axis=0)) @ np.cross(_n, _kn.mean(axis=0) - np.array(_j['wrist']))))
    na['hand_mask'] = ((na['V'] - np.array(joints[side]['wrist'])) @ (np.array(joints[side]['hand2']) - np.array(joints[side]['wrist']))) > 0
print('fingers curled (curl l %.2f r %.2f, palm %+d)' % (CURLS['l'], CURLS['r'], int(PALM)))

# ---- scaled rigid ICP ----
def rot_between(a, b):
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v = np.cross(a, b); s = np.linalg.norm(v); c = float(np.dot(a, b))
    if s < 1e-9: return np.eye(3) if c > 0 else -np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / (s * s))

def umeyama(P, Q):
    cp, cq = P.mean(axis=0), Q.mean(axis=0)
    Pc, Qc = P - cp, Q - cq
    U, S, Vt = np.linalg.svd(Pc.T @ Qc / len(P))
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1, 1, d])
    R = Vt.T @ D @ U.T
    s = (S * np.diag(D)).sum() / (Pc ** 2).sum() * len(P)
    return s, R, cq - s * R @ cp

def icp(src_pts, target_pts, iters=20):
    kd = kdtree.KDTree(len(target_pts))
    for i, p in enumerate(target_pts): kd.insert(Vector(p), i)
    kd.balance()
    cur = src_pts.copy()
    S_tot, R_tot, t_tot = 1.0, np.eye(3), np.zeros(3)
    cost = None
    for _ in range(iters):
        nn = np.array([kd.find(Vector(p))[0][:] for p in cur])
        R, t = kabsch(cur, nn); s = 1.0   # rigid only: the size comes from the arm-length estimate (--scale tweaks it)
        cur = cur @ R.T + t
        S_tot *= s; R_tot = R @ R_tot; t_tot = s * R @ t_tot + t
        cost = np.linalg.norm(cur - nn, axis=1).mean()
    return S_tot, R_tot, t_tot, cost

fitted = {}
gun_samples = surface_samples(gun_tris, frames_np[REF], 20000)
for oa in old_arms:
    side = oa['side']; na = new_arms[side]
    Pold = frames_np[REF][oa['vidx']]
    c_old = Pold.mean(axis=0)
    U, S, Vt = np.linalg.svd(Pold - c_old); ax_old = Vt[0]
    gun_c = frames_np[REF][sorted({t[k] for t in gun_tris for k in range(3)})].mean(axis=0)
    if np.linalg.norm(c_old + ax_old - gun_c) > np.linalg.norm(c_old - ax_old - gun_c): ax_old = -ax_old  # +axis = toward the hand
    ext_old = (Pold - c_old) @ ax_old; old_len = ext_old.max() - ext_old.min()
    samp = surface_samples(oa['tris'], frames_np[REF], 3000)
    hand_side = ((samp - c_old) @ ax_old) > 0
    target = np.vstack([Pold, samp, samp[hand_side], samp[hand_side]])   # the hand counts three times
    ax_new = na['tip'] - na['cut']; new_len = np.linalg.norm(ax_new); ax_new /= new_len
    base_scale = old_len / new_len * SCALE
    V0 = (na['V'] - na['V'].mean(axis=0)) * base_scale
    hand_idx = np.where(na['hand_mask'])[0]; arm_idx = np.where(~na['hand_mask'])[0]
    src_sample = np.vstack([V0[rng.choice(hand_idx, size=450, replace=False)], V0[rng.choice(arm_idx, size=150, replace=False)]])
    best = None
    for sign in (1, -1):
        R0 = rot_between(ax_new, sign * ax_old)
        for roll in range(0, 360, 45):
            Rr = rot_axis(sign * ax_old, math.radians(roll)) @ R0
            start = src_sample @ Rr.T + c_old
            s, R, t, cost = icp(start, target)
            if best is None or cost < best[0]:
                best = (cost, Rr, s, R, t, sign, roll)
    cost, Rr, s, R, t, sign, roll = best
    # rest -> fitted as an affine map (so joints can be mapped too)
    mean_rest = na['V'].mean(axis=0)
    A = s * base_scale * (R @ Rr); b = s * (R @ c_old) + t - A @ mean_rest
    j = joints[side]
    kn = np.array([j['fingers'][str(fi)][0] for fi in range(2, 6)]); pts = np.vstack([kn, np.array(j['wrist'])[None]])
    # palm direction = where the fingertips went when they curled (out of the palm surface)
    # (curl displacement alone is tilted ~45 deg toward the wrist for a strong curl - use only its sign)
    moved = np.linalg.norm(na['V'] - na['V_rest'], axis=1) > 1e-6
    disp = (na['V'][moved] - na['V_rest'][moved]).mean(axis=0)
    palm_n_rest = np.linalg.svd(pts - pts.mean(axis=0))[2][2]; palm_n_rest *= np.sign(disp @ palm_n_rest)
    axis_rest = na['tip'] - na['cut']; axis_rest /= np.linalg.norm(axis_rest)
    hand_c = (A @ na['V'][na['hand_mask']].T).T.mean(axis=0) + b
    # --- anatomical roll: rotate about the arm axis so the palm faces what it holds ---
    ax = A @ axis_rest; ax /= np.linalg.norm(ax)
    pn = A @ palm_n_rest; pn /= np.linalg.norm(pn)
    if PALMDIR[side] is not None:
        want = PALMDIR[side] / np.linalg.norm(PALMDIR[side])
    else:
        d2 = np.linalg.norm(gun_samples - hand_c, axis=1); want = gun_samples[d2.argmin()] - hand_c; want /= np.linalg.norm(want)
    p1 = pn - ax * (pn @ ax); p2 = want - ax * (want @ ax)
    if np.linalg.norm(p1) > 1e-6 and np.linalg.norm(p2) > 1e-6:
        p1 /= np.linalg.norm(p1); p2 /= np.linalg.norm(p2)
        ang = math.atan2(np.cross(p1, p2) @ ax, p1 @ p2)
        Rroll = rot_axis(ax, ang)
        A = Rroll @ A; b = Rroll @ (b - hand_c) + hand_c
        print('%s arm: palm rolled %.0f deg to face %s' % (side, math.degrees(ang), np.round(want, 2)))
    # --- contact push: slide along the palm normal until the palm plane is GAP units from the gun ---
    pn = A @ palm_n_rest; pn /= np.linalg.norm(pn)
    palm_c = (A @ pts.T).T.mean(axis=0) + b
    rel = gun_samples - palm_c; along = rel @ pn; lat = np.linalg.norm(rel - np.outer(along, pn), axis=1)
    cand = along[(lat < 4.5) & (along > -3)]
    if HAND[side] is not None:
        b = b + (HAND[side] - palm_c)
        print('%s arm: palm centre placed at %s' % (side, np.round(HAND[side], 1)))
    elif len(cand):
        push = cand.min() - GAP
        b = b + push * pn
        print('%s arm: palm pushed %.1f to contact (%d gun samples in front)' % (side, push, len(cand)))
    if SHIFT[side]:
        b = b - SHIFT[side] * pn
    b = b + MOVE[side]
    Vfit = (A @ na['V'].T).T + b + GUNMOVE
    _h = Vfit[na['hand_mask']]; _pc = (A @ pts.T).T.mean(axis=0) + b; _kn = (A @ kn.T).T + b
    print('%s hand @REF: bbox %s..%s  palm centre %s  knuckles x %.1f..%.1f  tip %s  wrist %s' % (side, np.round(_h.min(axis=0), 1), np.round(_h.max(axis=0), 1), np.round(_pc, 1), _kn[:, 0].min(), _kn[:, 0].max(), np.round(A @ na['tip'] + b, 1), np.round(A @ na['wrist'] + b, 1)))
    print('%s arm: old len %.1f, start scale %.1f, icp scale %.2f, axis %+d roll %d, cost %.2f' % (side, old_len, base_scale, s, sign, roll, cost))
    Pref_old = frames_np[REF][oa['vidx']]
    per_frame = []
    for f in range(nframes):
        Rf, tf = kabsch(Pref_old, frames_np[f][oa['vidx']])
        per_frame.append(Vfit @ Rf.T + tf)
    fitted[side] = dict(frames=per_frame, arm=na)

# ---- assemble MD3 ----
key_to_i, g_uvs, g_src, g_tris = {}, [], [], []
for t in gun_tris:
    idx = []
    for k in range(3):
        vi, st = t[k], t[3 + k]
        kk = key_to_i.get((vi, st))
        if kk is None:
            kk = len(g_uvs); key_to_i[(vi, st)] = kk
            g_uvs.append((md2['st'][st][0] / W, md2['st'][st][1] / H * GUN_F)); g_src.append(vi)
        idx.append(kk)
    g_tris.append(tuple(idx))
g_src = np.array(g_src)

def smooth_normals(tris, verts):
    n = np.zeros_like(verts)
    for a, b, c in tris:
        fn = np.cross(verts[b] - verts[a], verts[c] - verts[a])
        n[a] += fn; n[b] += fn; n[c] += fn
    l = np.linalg.norm(n, axis=1); l[l == 0] = 1
    return n / l[:, None]

all_tris, all_uvs = list(g_tris), list(g_uvs)
frame_verts = [[] for _ in range(nframes)]
frame_norms = [[] for _ in range(nframes)]
for f in range(nframes):
    gv = frames_np[f][g_src] + GUNMOVE
    frame_verts[f].extend(map(tuple, gv)); frame_norms[f].extend(map(tuple, smooth_normals(g_tris, gv)))
for side in ('l', 'r'):
    na, fr = fitted[side]['arm'], fitted[side]['frames']
    base = len(all_uvs)
    all_uvs.extend((u, GUN_F + (1 - v) * (1 - GUN_F)) for (u, v) in na['uvs'])   # Blender v is bottom-up, MD3 v top-down
    all_tris.extend(tuple(base + i for i in t) for t in na['tris'])
    for f in range(nframes):
        av = fr[f][na['src']]
        frame_verts[f].extend(map(tuple, av)); frame_norms[f].extend(map(tuple, smooth_normals(na['tris'], av)))
names = [fn for fn, _ in md2['frames']]
n = write_md3(out_md3, os.path.basename(out_md3), names, 'mesh', md2['skins'][0], all_tris, all_uvs, frame_verts, frame_norms)
print('MD3: %d verts, %d tris, %d surfaces -> %s' % (len(all_uvs), len(all_tris), n, out_md3))

img = bpy.data.images.load(skin_path)      # (re)load: open_mainfile above dropped the earlier handles
_band_img = bpy.data.images.load(BAND) if BAND else None
iw, ih = img.size
px = np.array(img.pixels[:], dtype=np.float32).reshape(ih, iw, 4)
if BAND:   # baked arm texture (bake_arms.py), resized to the gun skin's width
    _band_img.scale(iw, BAND_H)
    band = np.array(_band_img.pixels[:], dtype=np.float32).reshape(BAND_H, iw, 4); band[..., :3] *= BAND_GAIN; band[..., 3] = 1
    print('band from', BAND)
else:
    band = np.zeros((BAND_H, iw, 4), dtype=np.float32); band[..., :3] = (0.78, 0.58, 0.46); band[..., 3] = 1
oimg = bpy.data.images.new('combined', iw, ih + BAND_H, alpha=True)
oimg.pixels = np.concatenate([band, px], axis=0).ravel().tolist()   # Blender rows run bottom-up: band = lower part
oimg.filepath_raw = out_skin; oimg.file_format = 'PNG'; oimg.save()
print('skin written', out_skin, iw, ih + BAND_H)

# ---- diagnostic renders ----
if RENDER:
    os.makedirs(RENDER, exist_ok=True)
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'; scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'OBJECT'
    scene.render.resolution_x, scene.render.resolution_y = 960, 640
    cam_data = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_data); bpy.context.collection.objects.link(cam)
    cam_data.clip_start = 0.5; cam_data.clip_end = 2000
    scene.camera = cam
    def add(name, tris, verts, color):
        me = bpy.data.meshes.new(name); me.from_pydata([tuple(v) for v in verts], [], tris); me.update()
        ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob); ob.color = color
        for p in me.polygons: p.use_smooth = True
        return ob
    for f in (REF, 60):
        for mode in ('old', 'new', 'both'):
            obs = [add('gun', [(t[0], t[1], t[2]) for t in gun_tris], frames_np[f], (0.6, 0.6, 0.6, 1))]
            if mode in ('old', 'both'):
                for oa, col in zip(old_arms, ((1, 0.2, 0.2, 1), (0.2, 0.4, 1, 1))):
                    obs.append(add('old_' + oa['side'], [(t[0], t[1], t[2]) for t in oa['tris']], frames_np[f], col))
            if mode in ('new', 'both'):
                for side, col in (('l', (1, 0.7, 0.6, 1)), ('r', (0.7, 0.8, 1, 1))):
                    na, fr = fitted[side]['arm'], fitted[side]['frames']
                    obs.append(add('new_' + side, [tuple(t) for t in na['tris']], fr[f][na['src']], col))
            allv = np.array([tuple(x.co) for ob in obs for x in ob.data.vertices])
            c = allv.mean(axis=0); size = np.linalg.norm(allv - c, axis=1).max()
            views = [('side', c + np.array([0, -size * 3, 0]), (math.radians(90), 0, 0), 40),
                     ('top', c + np.array([0, 0, size * 3]), (0, 0, 0), 40),
                     ('eye', np.zeros(3), (math.radians(90), 0, math.radians(-90)), 90)]
            if mode == 'new':
                for side in ('l', 'r'):
                    na, fr = fitted[side]['arm'], fitted[side]['frames']
                    hc = fr[f][na['hand_mask']].mean(axis=0)
                    views.append(('hand_' + side, hc + np.array([0, -14, 6]), (math.radians(68), 0, 0), 45))
            for vname, loc, rot, ang in views:
                cam.location = tuple(loc); cam.rotation_euler = rot; cam_data.angle = math.radians(ang)
                scene.render.filepath = os.path.join(RENDER, 'f%02d_%s_%s.png' % (f, mode, vname))
                bpy.ops.render.render(write_still=True)
            for ob in obs: bpy.data.objects.remove(ob)
    print('renders in', RENDER)
