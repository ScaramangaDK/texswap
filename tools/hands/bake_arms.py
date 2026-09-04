"""Bake a skin texture for the extracted arms into a band image.

    blender -b -P bake_arms.py -- arms.blend arms_uv.blend out_band.png [width height]

1. The two arm meshes' UV islands (MakeHuman layout, tiny) are re-packed so
   each arm fills one half of the band (left arm = left half). The re-mapped
   meshes are saved to arms_uv.blend, which fit2.py must then use, so the
   model and the bake share the same UVs.
2. Both arms get a procedural skin material and are baked with Cycles
   (diffuse colour + light from a uniform world = albedo with soft AO).
The band becomes the lower half of the weapon's 2-band skin (fit2.py --band).
"""
import sys, os
import bpy
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
blend, blend_out, out = [os.path.abspath(a) for a in argv[:3]]
Wd, Ht = (int(argv[3]), int(argv[4])) if len(argv) > 4 else (1280, 640)
SAMPLES = int(argv[argv.index('--samples') + 1]) if '--samples' in argv else 256

bpy.ops.wm.open_mainfile(filepath=blend)
scene = bpy.context.scene
arms = sorted([o for o in bpy.data.objects if o.name.startswith('arm_')], key=lambda o: o.name)  # arm_l, arm_r

# ---- repack UVs: Blender packs each arm's islands into a unit square (rotation allowed),
# then the square is placed in that arm's half of the band (band halves are square: 640x640).
assert Wd == 2 * Ht, 'band must be two squares wide (e.g. 1280x640)'
for o in bpy.data.objects: o.select_set(False)
for i, o in enumerate(arms):
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method='FRACTION', margin=0.03)
    bpy.ops.object.mode_set(mode='OBJECT')
    o.select_set(False)
    uvl = o.data.uv_layers.active.data
    uv = np.array([tuple(l.uv) for l in uvl], dtype=np.float64)
    uv[:, 0] = uv[:, 0] * 0.5 + (0.0 if i == 0 else 0.5)
    for l, (u, v) in zip(uvl, uv): l.uv = (u, v)
    print('%s: packed, u %.3f..%.3f v %.3f..%.3f' % (o.name, uv[:, 0].min(), uv[:, 0].max(), uv[:, 1].min(), uv[:, 1].max()))

# ---- material ----
scene.render.engine = 'CYCLES'
scene.cycles.samples = SAMPLES
scene.cycles.device = 'CPU'
scene.cycles.bake_type = 'DIFFUSE'
scene.render.bake.use_pass_direct = True
scene.render.bake.use_pass_indirect = True
scene.render.bake.use_pass_color = True
scene.render.bake.margin = 12
world = bpy.data.worlds.new('w'); scene.world = world; world.use_nodes = True
bg = world.node_tree.nodes['Background']; bg.inputs[0].default_value = (1, 0.97, 0.93, 1); bg.inputs[1].default_value = 1.0

img = bpy.data.images.new('armband', Wd, Ht, alpha=False)
mat = bpy.data.materials.new('skin'); mat.use_nodes = True
nt = mat.node_tree; nodes, links = nt.nodes, nt.links
for n in list(nodes): nodes.remove(n)
outn = nodes.new('ShaderNodeOutputMaterial')
bsdf = nodes.new('ShaderNodeBsdfPrincipled')
bsdf.inputs['Roughness'].default_value = 0.6
bsdf.inputs['Specular IOR Level'].default_value = 0.2
tex = nodes.new('ShaderNodeTexCoord')
# large-scale tone variation (linear colours: warm tan, darker on knuckles/creases comes from AO)
big = nodes.new('ShaderNodeTexNoise'); big.inputs['Scale'].default_value = 12; big.inputs['Detail'].default_value = 2
ramp = nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].position = 0.38; ramp.color_ramp.elements[0].color = (0.30, 0.16, 0.10, 1)
ramp.color_ramp.elements[1].position = 0.62; ramp.color_ramp.elements[1].color = (0.42, 0.25, 0.16, 1)
# fine pores: multiply by a subtle high-frequency noise
pores = nodes.new('ShaderNodeTexNoise'); pores.inputs['Scale'].default_value = 400; pores.inputs['Detail'].default_value = 4
pr = nodes.new('ShaderNodeMapRange'); pr.inputs['From Min'].default_value = 0.3; pr.inputs['From Max'].default_value = 0.7
pr.inputs['To Min'].default_value = 0.85; pr.inputs['To Max'].default_value = 1.08
mul = nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
links.new(tex.outputs['Object'], big.inputs['Vector'])
links.new(tex.outputs['Object'], pores.inputs['Vector'])
links.new(big.outputs['Fac'], ramp.inputs['Fac'])
links.new(pores.outputs['Fac'], pr.inputs['Value'])
links.new(ramp.outputs['Color'], mul.inputs[6])
links.new(pr.outputs['Result'], mul.inputs[7])
links.new(mul.outputs[2], bsdf.inputs['Base Color'])
links.new(bsdf.outputs['BSDF'], outn.inputs['Surface'])
texnode = nodes.new('ShaderNodeTexImage'); texnode.image = img
nt.nodes.active = texnode

for o in bpy.data.objects:
    o.hide_render = o not in arms
    o.select_set(o in arms)
for o in arms:
    o.data.materials.clear(); o.data.materials.append(mat)
    for p in o.data.polygons: p.use_smooth = True
bpy.context.view_layer.objects.active = arms[0]
bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT', 'COLOR'}, margin=12, use_clear=True)
img.filepath_raw = out; img.file_format = 'PNG'; img.save()
print('baked arm band ->', out, Wd, 'x', Ht)

# save the re-mapped meshes (material stripped so the blend stays small and neutral)
for o in arms: o.data.materials.clear()
bpy.data.images.remove(img)
bpy.ops.wm.save_as_mainfile(filepath=blend_out)
print('re-mapped arms ->', blend_out)
