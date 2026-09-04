import bpy, sys, os
from mathutils import Vector
argv = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=argv[0]); out = argv[1]
sc = bpy.context.scene; cam = bpy.data.objects['eye (spillerens oeje)']; cd = cam.data
sc.render.engine = 'BLENDER_EEVEE_NEXT' if bpy.app.version >= (4, 2) else 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 900, 600
sc.world.node_tree.nodes['Background'].inputs[1].default_value = 2.0
views = [('right', (35, -200, -20), (35, -20, -20), 55), ('left', (35, 180, -20), (35, -20, -20), 55), ('top', (35, -20, 200), (35, -20, -20), 55), ('front', (250, -20, -20), (35, -20, -20), 40), ('below', (35, -20, -200), (35, -20, -20), 55)]
for name, loc, aim, scale in views:
    cd.type = 'ORTHO'; cd.ortho_scale = scale
    cam.location = loc; cam.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = os.path.join(os.path.abspath(out), name + '.png'); bpy.ops.render.render(write_still=True)
print('views ok')
