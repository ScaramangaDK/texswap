"""blender -b -P make_scene.py -- model.md3 skin.png frame out.blend
Starter scene for hand posing: MD3 frame as textured meshes (gun / arm_l / arm_r),
camera at the player's eye (fov 90, looking +x), a light, metric grid in Quake units."""
import sys, os, math, struct
import numpy as np, bpy
from mathutils import Vector
argv = sys.argv[sys.argv.index('--') + 1:]
path, skin, fr, out = argv[0], argv[1], int(argv[2]), argv[3]
f = open(path, 'rb').read()
(ident, ver, name, flags, nfr, ntag, nsurf, nskin, ofr, otag, osurf, oend) = struct.unpack('<4si64siiiiiiiii', f[:108])
for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
img = bpy.data.images.load(os.path.abspath(skin))
mat = bpy.data.materials.new('m4_skin'); mat.use_nodes = True
bsdf = mat.node_tree.nodes['Principled BSDF']; bsdf.inputs['Roughness'].default_value = 0.7
tex = mat.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = img
mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
GUN_F = 400 / 1040
o = osurf; parts = {'gun': ([], [], []), 'arm_l': ([], [], []), 'arm_r': ([], [], [])}
for si in range(nsurf):
    (sid, sname, sflags, snfr, snsh, snv, snt, otri, osh, ost, oxyz, osend) = struct.unpack('<4s64s' + 'i' * 10, f[o:o + 108])
    tris = np.frombuffer(f[o + otri:o + otri + snt * 12], dtype='<i4').reshape(-1, 3)
    st = np.frombuffer(f[o + ost:o + ost + snv * 8], dtype='<f4').reshape(-1, 2)
    xyz = np.frombuffer(f[o + oxyz + fr * snv * 8:o + oxyz + (fr + 1) * snv * 8], dtype='<i2').reshape(-1, 4)[:, :3] / 64.
    for t in tris:
        u, v = st[t[0]]
        key = 'gun' if v < GUN_F + 0.005 else ('arm_l' if u < 0.5 else 'arm_r')
        V, T, UV = parts[key]
        base = len(V)
        for i in t:
            V.append(tuple(xyz[i])); UV.append((float(st[i][0]), 1 - float(st[i][1])))   # MD3 v top-down -> Blender bottom-up
        T.append((base, base + 1, base + 2))
    o += osend
for key, (V, T, UV) in parts.items():
    if not T: continue
    me = bpy.data.meshes.new(key); me.from_pydata(V, [], T); me.update()
    uvl = me.uv_layers.new(name='uv')
    for pi, poly in enumerate(me.polygons):
        for li, loop_idx in enumerate(poly.loop_indices):
            uvl.data[loop_idx].uv = UV[T[pi][li]]
    # merge the per-triangle vertices so the mesh is editable, keep sharp gun edges
    ob = bpy.data.objects.new(key, me); bpy.context.collection.objects.link(ob)
    me.materials.append(mat)
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.01); bpy.ops.object.mode_set(mode='OBJECT')
    for p in me.polygons: p.use_smooth = key != 'gun'
    ob.select_set(False)
cam_data = bpy.data.cameras.new('eye'); cam = bpy.data.objects.new('eye (spillerens oeje)', cam_data); bpy.context.collection.objects.link(cam)
cam_data.sensor_fit = 'HORIZONTAL'; cam_data.angle = math.radians(106)   # 90 fov widened for 16:9 like q2pro's cl_adjustfov
cam_data.clip_start = 0.5; cam_data.clip_end = 4000
cam.location = (0, 0, 0); cam.rotation_euler = (math.radians(90), 0, math.radians(-90))
bpy.context.scene.camera = cam
bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y = 1920, 1080
light_data = bpy.data.lights.new('sun', 'SUN'); light_data.energy = 3
light = bpy.data.objects.new('sun', light_data); bpy.context.collection.objects.link(light)
light.rotation_euler = (math.radians(50), math.radians(-20), math.radians(30))
# viewport defaults: look through the camera, textured shading
for area in bpy.context.screen.areas if bpy.context.screen else []:
    if area.type == 'VIEW_3D':
        for sp in area.spaces:
            if sp.type == 'VIEW_3D':
                sp.region_3d.view_perspective = 'CAMERA'; sp.shading.type = 'MATERIAL'; sp.clip_end = 4000
bpy.context.scene.unit_settings.system = 'NONE'
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(out))
print('scene saved', out, {k: len(v[1]) for k, v in parts.items()})
