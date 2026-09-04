import bpy, sys
argv = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=argv[0])
print('== objects')
for o in bpy.data.objects:
    extra = ''
    if o.type == 'MESH':
        me = o.data; extra = 'verts %d polys %d tris~%d mats %s uv %s vgroups %d' % (len(me.vertices), len(me.polygons), sum(len(p.vertices) - 2 for p in me.polygons), [m.name for m in me.materials], [u.name for u in me.uv_layers], len(o.vertex_groups))
        if o.parent: extra += ' parent %s' % o.parent.name
        extra += ' mods %s' % [m.type for m in o.modifiers]
    if o.type == 'ARMATURE':
        extra = 'bones %d: %s' % (len(o.data.bones), ', '.join(b.name for b in list(o.data.bones)[:60]))
    print(' %-28s %-9s %s' % (o.name, o.type, extra))
    if o.type == 'MESH':
        bb = [o.matrix_world @ v.co for v in o.data.vertices]
        if bb: print('     bbox', [round(min(v[i] for v in bb), 2) for i in range(3)], [round(max(v[i] for v in bb), 2) for i in range(3)], 'dims', o.dimensions[:])
print('== actions'); [print(' ', a.name, 'frames', a.frame_range[:], 'fcurves', len(a.fcurves)) for a in bpy.data.actions]
print('== images'); [print(' ', i.name, i.size[:], i.filepath) for i in bpy.data.images]
print('== materials'); [print(' ', m.name, [n.type for n in m.node_tree.nodes] if m.use_nodes else 'no nodes') for m in bpy.data.materials]
print('== scene frames', bpy.context.scene.frame_start, bpy.context.scene.frame_end, 'fps', bpy.context.scene.render.fps, 'blender', bpy.data.version)
