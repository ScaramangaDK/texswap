"""blender -b -P render_md2.py -- tris.md2 outdir [frames...]  -- workbench renders: eye/side/top/bottom/front views of an MD2 frame"""
import sys, os, math
import numpy as np, bpy
sys.path.insert(0, 'C:/AI/AIprojects/AQ2textureswapper/tools')
from md2_to_md3 import read_md2
argv = sys.argv[sys.argv.index('--') + 1:]
md2 = read_md2(argv[0]); out = argv[1]; frames = [int(x) for x in argv[2:]] or [30]
os.makedirs(out, exist_ok=True)
for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'; scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'OBJECT'
scene.render.resolution_x, scene.render.resolution_y = 960, 640
cam_data = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_data); bpy.context.collection.objects.link(cam)
cam_data.clip_start = 0.5; cam_data.clip_end = 2000; scene.camera = cam
W, H = md2['skinw'], md2['skinh']
for f in frames:
    V = np.array(md2['frames'][f][1])
    tris = [(t[0], t[1], t[2]) for t in md2['tris']]
    me = bpy.data.meshes.new('m'); me.from_pydata([tuple(v) for v in V], [], tris); me.update()
    ob = bpy.data.objects.new('m', me); bpy.context.collection.objects.link(ob)
    # colour by skin u: arm strips guessed by the same rule as the M4 (u in the right-hand 1/3 of each half) -> tint red
    ob.color = (0.7, 0.7, 0.7, 1)
    for p in me.polygons: p.use_smooth = False
    c = V.mean(axis=0); size = np.linalg.norm(V - c, axis=1).max()
    views = [('eye', np.zeros(3), (math.radians(90), 0, math.radians(-90)), 90),
             ('side', c + np.array([0, -size * 2.5, 0]), (math.radians(90), 0, 0), 40),
             ('top', c + np.array([0, 0, size * 2.5]), (0, 0, 0), 40),
             ('bottom', c + np.array([0, 0, -size * 2.5]), (math.radians(180), 0, 0), 40),
             ('front', c + np.array([size * 2.5, 0, 0]), (math.radians(90), 0, math.radians(90)), 40)]
    for vname, loc, rot, ang in views:
        cam.location = tuple(loc); cam.rotation_euler = rot; cam_data.angle = math.radians(ang)
        scene.render.filepath = os.path.join(out, 'f%02d_%s.png' % (f, vname)); bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(ob)
    print('frame', f, md2['frames'][f][0], 'bbox', V.min(0).round(1), V.max(0).round(1))
