import bpy, bmesh, sys, math
from mathutils import Vector
blend, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=blend)
obj = bpy.data.objects['Human']
me = obj.data
def centroid(group):
    gi = obj.vertex_groups[group].index
    pts = [v.co for v in me.vertices if any(g.group == gi for g in v.groups)]
    return sum(pts, Vector()) / len(pts)
body_gi = obj.vertex_groups['body'].index
helper_gi = obj.vertex_groups['HelperGeometry'].index
result = {}
import json
joints = {}
for side in ('l', 'r'):
    wrist, elbow = centroid('joint-%s-hand' % side), centroid('joint-%s-elbow' % side)
    axis = (wrist - elbow).normalized()
    # keep from a bit above the elbow to the fingertips
    cut = elbow + axis * ((wrist - elbow).length * 0.15)
    keep = set()
    arm_len = (wrist - elbow).length
    for v in me.vertices:
        if not any(g.group == body_gi for g in v.groups): continue
        if any(g.group == helper_gi for g in v.groups): continue
        d = (v.co - cut).dot(axis)                      # along the forearm, from the cut
        perp = ((v.co - cut) - axis * d).length          # distance from the forearm axis
        if 0 < d < arm_len * 2.2 and perp < arm_len * 0.55: keep.add(v.index)
    bm = bmesh.new(); bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    faces = [f for f in bm.faces if all(v.index in keep for v in f.verts)]
    # build a new mesh from those faces
    vmap, verts, polys, uvs = {}, [], [], []
    uv_layer = bm.loops.layers.uv.active
    for f in faces:
        idx = []
        for l in f.loops:
            k = vmap.get(l.vert.index)
            if k is None:
                k = len(verts); vmap[l.vert.index] = k; verts.append(l.vert.co.copy())
            idx.append(k)
        polys.append(idx); uvs.append([tuple(l[uv_layer].uv) for l in f.loops])
    bm.free()
    nm = bpy.data.meshes.new('arm_%s' % side)
    nm.from_pydata(verts, [], polys); nm.update()
    uvl = nm.uv_layers.new(name='UVMap')
    for pi, poly in enumerate(nm.polygons):
        for li, loop_idx in enumerate(poly.loop_indices):
            uvl.data[loop_idx].uv = uvs[pi][li]
    no = bpy.data.objects.new('arm_%s' % side, nm)
    bpy.context.collection.objects.link(no)
    tris = sum(len(p.vertices) - 2 for p in nm.polygons)
    bb = [min(v.co[i] for v in nm.vertices) for i in range(3)], [max(v.co[i] for v in nm.vertices) for i in range(3)]
    fingertip = max((v for v in verts), key=lambda v: (v - wrist).dot(axis))
    fingers = {}
    for fi in range(1, 6):
        chain = []
        for ji in range(1, 5):
            try: chain.append(list(centroid('joint-%s-finger-%d-%d' % (side, fi, ji))))
            except Exception: pass
        fingers[str(fi)] = chain
    joints[side] = dict(wrist=list(wrist), elbow=list(elbow), cut=list(cut), tip=list(fingertip), fingers=fingers,
                        hand=list(centroid('joint-%s-hand' % side)), hand2=list(centroid('joint-%s-hand-2' % side)), hand3=list(centroid('joint-%s-hand-3' % side)))
    print('arm', side, 'verts', len(verts), 'polys', len(polys), 'tris', tris, 'wrist', [round(c, 3) for c in wrist], 'elbow', [round(c, 3) for c in elbow], 'bbox', [[round(c,3) for c in b] for b in bb])
# hide the full body, render the arms from the front with workbench
obj.hide_render = True; obj.hide_viewport = True
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'SINGLE'
scene.render.resolution_x, scene.render.resolution_y = 1000, 700
cam_data = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_data); bpy.context.collection.objects.link(cam)
scene.camera = cam
arms = [o for o in bpy.data.objects if o.name.startswith('arm_')]
allv = [o.matrix_world @ v.co for o in arms for v in o.data.vertices]
c = sum(allv, Vector()) / len(allv)
size = max((v - c).length for v in allv)
cam.location = c + Vector((0, -size * 2.6, 0)); cam.rotation_euler = (math.radians(90), 0, 0)
cam_data.clip_end = 1000
json.dump(joints, open(out.replace('.blend', '_joints.json'), 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=out)
scene.render.filepath = out.replace('.blend', '_front.png')
bpy.ops.render.render(write_still=True)
print('rendered', scene.render.filepath)
