"""MD2 -> MD3 through Blender (headless).

    blender -b -P tools/md2_to_md3.py -- in.md2 out.md3 [--subdiv N] [--smooth] [--skin path]
                                            [--region u0,v0,u1,v1 ...]

--region limits the subdivision to faces whose skin UVs fall inside the given
rectangle(s) (0..1). q2pro keeps a whole model under ~4 MB, so a 72-frame
weapon cannot be subdivided everywhere; the hands are where it pays off.

Reads a Quake 2 MD2 (all frames), rebuilds it as a Blender mesh with UVs,
optionally applies a Catmull-Clark subdivision (with smooth shading) per
frame, and writes a Quake 3 MD3 with one surface. Coordinates stay in Quake
space (x forward, y left, z up); MD3 stores them as 1/64 units, which removes
the 8-bit vertex wobble MD2 is known for. The frame list and timing are
preserved 1:1, so AQ2's animation frame numbers still line up.
"""
import struct, sys, math, os

import bpy
import bmesh

# ---------- MD2 reader ----------

def read_md2(path):
    with open(path, 'rb') as f:
        d = f.read()
    (ident, ver, skinw, skinh, framesize, nskins, nverts, nst, ntris, ngl, nframes,
     ofs_skins, ofs_st, ofs_tris, ofs_frames, ofs_gl, ofs_end) = struct.unpack_from('<17i', d, 0)
    if ident != 0x32504449 or ver != 8:
        raise SystemExit('not an md2')
    skins = [d[ofs_skins + i*64: ofs_skins + i*64 + 64].split(b'\0')[0].decode('latin1') for i in range(nskins)]
    st = [struct.unpack_from('<hh', d, ofs_st + i*4) for i in range(nst)]
    tris = [struct.unpack_from('<6h', d, ofs_tris + i*12) for i in range(ntris)]
    frames = []
    for fi in range(nframes):
        b = ofs_frames + fi*framesize
        sx, sy, sz, tx, ty, tz = struct.unpack_from('<6f', d, b)
        name = d[b+24:b+40].split(b'\0')[0].decode('latin1')
        verts = []
        for v in range(nverts):
            x, y, z = d[b+40+v*4], d[b+41+v*4], d[b+42+v*4]
            verts.append((x*sx+tx, y*sy+ty, z*sz+tz))
        frames.append((name, verts))
    return dict(skinw=skinw, skinh=skinh, skins=skins, st=st, tris=tris, frames=frames, nverts=nverts)

# ---------- MD3 writer ----------

def encode_normal(n):
    x, y, z = n
    l = math.sqrt(x*x + y*y + z*z) or 1.0
    x, y, z = x/l, y/l, z/l
    # Quake 3 byte order, which q2pro decodes too (checked in game 2026-09-04;
    # the other order lights models inside-out):
    #   high byte = azimuth atan2(y, x), low byte = zenith acos(z), 255 = 2*pi
    #   x = cos(hi) * sin(lo), y = sin(hi) * sin(lo), z = cos(lo)
    hi = int(round(math.atan2(y, x) * 255 / (2*math.pi))) & 255
    lo = int(round(math.acos(max(-1.0, min(1.0, z))) * 255 / (2*math.pi))) & 255
    return (hi << 8) | lo

MAX_TRIS_PER_SURFACE = 4000   # q2pro 2023 builds: 4096 tris / 4096 verts per mesh (newer: 6144)

def split_surfaces(tris, uvs, frame_verts, frame_normals, max_tris=MAX_TRIS_PER_SURFACE):
    """Cut one big surface into chunks the engine accepts; vertices are remapped per chunk."""
    chunks = []
    for start in range(0, len(tris), max_tris):
        part = tris[start:start + max_tris]
        remap, sub_uvs = {}, []
        sub_tris = []
        for t in part:
            idx = []
            for v in t:
                k = remap.get(v)
                if k is None:
                    k = len(sub_uvs)
                    remap[v] = k
                    sub_uvs.append(uvs[v])
                idx.append(k)
            sub_tris.append(tuple(idx))
        order = sorted(remap, key=remap.get)
        chunks.append(dict(tris=sub_tris, uvs=sub_uvs,
                           verts=[[fv[i] for i in order] for fv in frame_verts],
                           normals=[[fn[i] for i in order] for fn in frame_normals]))
    return chunks

def pack_surface(surf_name, shader, tris, uvs, frame_verts, frame_normals):
    nframes, nverts, ntris = len(frame_verts), len(uvs), len(tris)
    tri_bytes = b''.join(struct.pack('<3i', *t) for t in tris)
    shader_bytes = struct.pack('<64si', shader.encode('latin1')[:63], 0)
    st_bytes = b''.join(struct.pack('<2f', u, v) for (u, v) in uvs)
    xyz = bytearray()
    for fi in range(nframes):
        for v, n in zip(frame_verts[fi], frame_normals[fi]):
            xyz += struct.pack('<3hH', *(max(-32768, min(32767, int(round(c*64)))) for c in v), encode_normal(n))
    ofs_tris = 108
    ofs_shaders = ofs_tris + len(tri_bytes)
    ofs_st = ofs_shaders + len(shader_bytes)
    ofs_xyz = ofs_st + len(st_bytes)
    ofs_end = ofs_xyz + len(xyz)
    hdr = struct.pack('<i64siiiiiiiiii', 0x33504449, surf_name.encode('latin1')[:63], 0,
                      nframes, 1, nverts, ntris, ofs_tris, ofs_shaders, ofs_st, ofs_xyz, ofs_end)
    return hdr + tri_bytes + shader_bytes + st_bytes + bytes(xyz)

def write_md3(path, name, frames, surf_name, shader, tris, uvs, frame_verts, frame_normals):
    """frames: frame names; tris: (a,b,c) list; uvs: (u,v) per vertex;
    frame_verts / frame_normals: [frame][vertex] -> (x,y,z). Splits into
    several surfaces when the engine's per-mesh limits demand it."""
    nframes = len(frames)
    frame_bytes = b''
    for fi, fname in enumerate(frames):
        vs = frame_verts[fi]
        mn = [min(v[k] for v in vs) for k in range(3)]
        mx = [max(v[k] for v in vs) for k in range(3)]
        origin = [(mn[k]+mx[k])/2 for k in range(3)]
        radius = max(math.dist(origin, v) for v in vs) if vs else 0.0
        frame_bytes += struct.pack('<3f3f3ff16s', *mn, *mx, *origin, radius, fname.encode('latin1')[:15])
    chunks = split_surfaces(tris, uvs, frame_verts, frame_normals)
    surfs = b''.join(pack_surface('%s%d' % (surf_name, i), shader, c['tris'], c['uvs'], c['verts'], c['normals'])
                     for i, c in enumerate(chunks))
    ofs_frames = 108
    ofs_tags = ofs_frames + len(frame_bytes)
    ofs_surfaces = ofs_tags
    ofs_eof = ofs_surfaces + len(surfs)
    hdr = struct.pack('<ii64siiiiiiiii', 0x33504449, 15, name.encode('latin1')[:63], 0,
                      nframes, 0, len(chunks), 0, ofs_frames, ofs_tags, ofs_surfaces, ofs_eof)
    with open(path, 'wb') as f:
        f.write(hdr + frame_bytes + surfs)
    return len(chunks)

# ---------- conversion ----------

def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if len(argv) < 2:
        raise SystemExit(__doc__)
    src, dst = argv[0], argv[1]
    subdiv = int(argv[argv.index('--subdiv') + 1]) if '--subdiv' in argv else 0
    smooth = '--smooth' in argv
    skin_override = argv[argv.index('--skin') + 1] if '--skin' in argv else None
    regions = []
    for i, a in enumerate(argv):
        if a == '--region':
            regions.append(tuple(float(x) for x in argv[i + 1].split(',')))

    md2 = read_md2(src)
    skin = skin_override or (md2['skins'][0] if md2['skins'] else 'skin.pcx')

    # fresh scene
    bpy.ops.wm.read_factory_settings(use_empty=True)
    W, H = md2['skinw'], md2['skinh']

    def face_in_region(t):
        if not regions:
            return True
        for k in range(3):
            sv, tv = md2['st'][t[3 + k]]
            u, v = sv / W, tv / H
            if not any(u0 <= u <= u1 and v0 <= v <= v1 for (u0, v0, u1, v1) in regions):
                return False
        return True

    # faces to subdivide vs faces kept as they are, each as its own object
    groups = []
    if subdiv > 0:
        sub = [t for t in md2['tris'] if face_in_region(t)]
        keep = [t for t in md2['tris'] if not face_in_region(t)]
        if sub: groups.append((sub, subdiv))
        if keep: groups.append((keep, 0))
    else:
        groups.append((list(md2['tris']), 0))

    depsgraph = bpy.context.evaluated_depsgraph_get()
    frame_names = [f[0] for f in md2['frames']]
    all_tris, all_uvs = [], []
    all_fv = [[] for _ in frame_names]
    all_fn = [[] for _ in frame_names]

    for gi, (gtris, glev) in enumerate(groups):
        used = sorted({t[k] for t in gtris for k in range(3)})
        remap = {v: i for i, v in enumerate(used)}
        gmesh = bpy.data.meshes.new('g%d' % gi)
        gobj = bpy.data.objects.new('g%d' % gi, gmesh)
        bpy.context.collection.objects.link(gobj)
        gmesh.from_pydata([md2['frames'][0][1][v] for v in used], [],
                          [(remap[t[0]], remap[t[1]], remap[t[2]]) for t in gtris])
        gmesh.update()
        uv_layer = gmesh.uv_layers.new(name='uv')
        for pi, poly in enumerate(gmesh.polygons):
            t = gtris[pi]
            for li, loop_idx in enumerate(poly.loop_indices):
                sv, tv = md2['st'][t[3 + li]]
                uv_layer.data[loop_idx].uv = (sv / W, tv / H)
        if smooth:
            for poly in gmesh.polygons:
                poly.use_smooth = True
        if glev > 0:
            mod = gobj.modifiers.new('subsurf', 'SUBSURF')
            mod.levels = glev
            mod.render_levels = glev
            mod.uv_smooth = 'PRESERVE_BOUNDARIES'
            tri = gobj.modifiers.new('tri', 'TRIANGULATE')
            tri.quad_method = 'SHORTEST_DIAGONAL'

        def evaluated(o=gobj):
            depsgraph.update()
            eo = o.evaluated_get(depsgraph)
            return eo.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph), eo

        em, eo = evaluated()
        em.calc_loop_triangles()
        uvl = em.uv_layers.active.data
        key_to_index, g_uvs, g_srcvert, g_tris = {}, [], [], []
        base = len(all_uvs)
        for lt in em.loop_triangles:
            idx = []
            for li in lt.loops:
                vi = em.loops[li].vertex_index
                u, v = uvl[li].uv
                key = (vi, round(u, 5), round(v, 5))
                k = key_to_index.get(key)
                if k is None:
                    k = len(g_uvs)
                    key_to_index[key] = k
                    g_uvs.append((u, v))
                    g_srcvert.append(vi)
                idx.append(base + k)
            g_tris.append(tuple(idx))
        eo.to_mesh_clear()
        all_tris.extend(g_tris)
        all_uvs.extend(g_uvs)
        for fi, (fname, verts) in enumerate(md2['frames']):
            for i, v in enumerate(used):
                gmesh.vertices[i].co = verts[v]
            gmesh.update()
            em, eo = evaluated()
            vn = [tuple(v.normal) for v in em.vertices]
            co = [tuple(v.co) for v in em.vertices]
            all_fv[fi].extend(co[i] for i in g_srcvert)
            all_fn[fi].extend(vn[i] for i in g_srcvert)
            eo.to_mesh_clear()
        print('group %d: %d faces in, level %d -> %d tris, %d verts' % (gi, len(gtris), glev, len(g_tris), len(g_uvs)))

    md3_tris, md3_uvs, frame_verts, frame_normals = all_tris, all_uvs, all_fv, all_fn
    n = write_md3(dst, os.path.basename(dst), frame_names, 'mesh', skin, md3_tris, md3_uvs, frame_verts, frame_normals)
    print('MD3 written: %s  frames=%d verts=%d tris=%d surfaces=%d subdiv=%d smooth=%s skin=%s' % (
        dst, len(frame_names), len(md3_uvs), len(md3_tris), n, subdiv, smooth, skin))

if __name__ == '__main__':
    main()
