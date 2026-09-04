import bpy, sys, os, math
from mathutils import Vector
argv = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=argv[0]); out = argv[1]; os.makedirs(out, exist_ok=True)
sc = bpy.context.scene
# 2.79 internal material -> rebuild a node material with the hand texture
img = None
for i in bpy.data.images:
    if 'Hand_TEX' in i.name: img = i
mat = bpy.data.materials['HAND_Mat']; mat.use_nodes = True
nt = mat.node_tree; bsdf = nt.nodes.get('Principled BSDF')
if img and bsdf:
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img; nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
for o in bpy.data.objects:
    if o.type == 'LIGHT': o.hide_render = True
w = bpy.data.worlds[0] if bpy.data.worlds else bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs[1].default_value = 1.5
sc.render.engine = 'BLENDER_EEVEE_NEXT' if bpy.app.version >= (4, 2) else 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 960, 540
cam = sc.camera
print('scene camera', cam.name if cam else None, cam.location[:] if cam else None, cam.data.angle if cam else None)
side = bpy.data.objects.new('sidecam', bpy.data.cameras.new('sidecam')); sc.collection.objects.link(side)
side.data.type = 'ORTHO'; side.data.ortho_scale = 1.6
gun = bpy.data.objects['weapon']; c = sum((gun.matrix_world @ v.co for v in gun.data.vertices), Vector()) / len(gun.data.vertices)
side.location = c + Vector((3, 0, 0)); side.rotation_euler = (Vector(c) - side.location).to_track_quat('-Z', 'Y').to_euler()
for f in [int(x) for x in argv[2:]]:
    sc.frame_set(f)
    for name, camo in (('eye', cam), ('side', side)):
        if camo is None: continue
        sc.camera = camo; sc.render.filepath = os.path.join(out, 'f%03d_%s.png' % (f, name)); bpy.ops.render.render(write_still=True)
print('done')
