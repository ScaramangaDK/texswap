"""blender -b -P render_md3.py -- model.md3 out.png frame camx,camy,camz aimx,aimy,aimz [fov]
Workbench render of one MD3 frame; surfaces coloured by band (gun grey, arms skin)."""
import sys, os, math, struct
import numpy as np, bpy
from mathutils import Vector
argv = sys.argv[sys.argv.index('--') + 1:]
path, out, fr = argv[0], argv[1], int(argv[2])
cam_p = Vector([float(x) for x in argv[3].split(',')]); aim = Vector([float(x) for x in argv[4].split(',')])
fov = float(argv[5]) if len(argv) > 5 else 50
f = open(path, 'rb').read()
(ident, ver, name, flags, nfr, ntag, nsurf, nskin, ofr, otag, osurf, oend) = struct.unpack('<4si64siiiiiiiii', f[:108])
for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'; scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'OBJECT'
scene.render.resolution_x, scene.render.resolution_y = 960, 640
o = osurf
for si in range(nsurf):
    (sid, sname, sflags, snfr, snsh, snv, snt, otri, osh, ost, oxyz, osend) = struct.unpack('<4s64s' + 'i' * 10, f[o:o + 108])
    tris = np.frombuffer(f[o + otri:o + otri + snt * 12], dtype='<i4').reshape(-1, 3)
    st = np.frombuffer(f[o + ost:o + ost + snv * 8], dtype='<f4').reshape(-1, 2)
    xyz = np.frombuffer(f[o + oxyz + fr * snv * 8:o + oxyz + (fr + 1) * snv * 8], dtype='<i2').reshape(-1, 4)[:, :3] / 64.
    # split the surface's triangles by band so the arms get a skin colour
    for label, mask, col in (('gun', st[:, 1] < 0.39, (0.5, 0.5, 0.5, 1)), ('arm', st[:, 1] >= 0.39, (0.85, 0.6, 0.5, 1))):
        tsel = [tuple(t) for t in tris if mask[t[0]]]
        if not tsel: continue
        me = bpy.data.meshes.new(label); me.from_pydata([tuple(v) for v in xyz], [], tsel); me.update()
        for p in me.polygons: p.use_smooth = (label == 'arm')
        ob = bpy.data.objects.new(label, me); bpy.context.collection.objects.link(ob); ob.color = col
    o += osend
cam_data = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_data); bpy.context.collection.objects.link(cam)
cam_data.clip_start = 0.5; cam_data.clip_end = 2000; cam_data.angle = math.radians(fov); scene.camera = cam
cam.location = cam_p; cam.rotation_euler = (aim - cam_p).to_track_quat('-Z', 'Y').to_euler()
scene.render.filepath = os.path.abspath(out); bpy.ops.render.render(write_still=True); print('rendered', out)
