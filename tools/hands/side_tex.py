import bpy, sys, math, os
from mathutils import Vector
argv = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=argv[0])
sc = bpy.context.scene
if '--noarms' in argv:
    for n in ('arm_l', 'arm_r'):
        if n in bpy.data.objects: bpy.data.objects[n].hide_render = True
cam = bpy.data.objects['eye (spillerens oeje)']; cd = cam.data
cd.type = 'ORTHO'; cd.ortho_scale = 60
cam.location = (35, -200, -20); cam.rotation_euler = (Vector((35, -20, -20)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
sc.render.engine = 'BLENDER_EEVEE_NEXT' if bpy.app.version >= (4, 2) else 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 1200, 800; sc.render.filepath = os.path.abspath(argv[1])
w = sc.world.node_tree.nodes['Background']; w.inputs[1].default_value = 2.0
bpy.ops.render.render(write_still=True); print('ok')
