# Real hands for AQ2 view weapons (Blender pipeline)

Replaces the blocky MD2 hands of a view weapon with MakeHuman forearms + hands
(CC0 base mesh from the MPFB extension), fitted frame by frame onto the
original hand animation, and writes an MD3 + 2-band skin the Skin studio can
upload (`link tris.md2 -> tris.md3` in game). Ralle's own project, not an app
feature. Blender 4.5 LTS portable, headless:

    B=C:/AI/tools/blender-4.5.13-windows-x64/blender.exe
    # 1. once: MPFB human -> forearm+hand meshes (arm_l / arm_r) + joint positions
    $B -b -P tools/hands/extract_arms.py -- human.blend arms.blend arms_joints.json
    # 2. once: repack the arm UVs into two square halves and bake a skin texture
    $B -b -P tools/hands/bake_arms.py -- arms.blend arms_uv.blend arm_band.png 1280 640
    # 3. per weapon: fit onto the MD2's arm animation, write MD3 + skin
    $B -b -P tools/hands/fit_hands.py -- v_m4/tris.md2 v_m4/skin.png arms_uv.blend arms_joints.json          out.md3 out_skin.png --band arm_band.png --bandgain 0.35 --scale 1.25 --curl_l 0.6          --palmdir_l 0,-0.15,1 --hand_l 62,-20,-14.5 --thumb_l along --palmdir_r 0,1,0 --hand_r 22.5,-26,-20.5
    # check the pose without the game: exact wireframe plots + workbench renders of the MD3
    $B -b -P tools/hands/render_md3.py -- out.md3 view.png 30 50,-75,-45 22,-24,-22 35   # cam x,y,z  aim x,y,z  fov

Then upload out.md3 and out_skin.png in the Skin studio (model first, then skin),
or through the API (`/api/skins/upload` with `dir` = the install).

## rig_pose.py (the way that works)
fit_hands.py tried to inherit the pose from the old blob hands; that was a dead
end. rig_pose.py builds an armature on the MakeHuman arms (forearm, hand, 3 bones
per finger, automatic weights) and poses each hand from an explicit frame in
pose_m4.json: wrist position, finger direction, palm direction, elbow direction,
per-joint curl angles, optional thumb-along. Both hands then follow the gun's own
per-frame rigid motion. Check with `--render dir` (7 views) and
`python plot_md3.py out.md3 plot.png 30` (exact x-z / x-y wireframes with a grid).

    $B -b -P tools/hands/rig_pose.py -- arms_uv.blend arms_joints.json pose_m4.json rig_m4.blend          --md2 v_m4/tris.md2 --skin v_m4/skin.png --band arm_band.png --md3 out.md3 --outskin out_skin.png --render dir

Notes: `curl_sign` is -1 (bone local X points so that +angle hyperextends);
`scale` 152 = MakeHuman metres -> gun units for a hand a bit bigger than life.

## How fit_hands.py works (superseded)
* Old arm triangles are found by their skin-UV strips (`REGIONS`), clustered
  into two arms (single-linkage on shared vertices), reference frame `REF=30`
  (frame 0 is a draw pose).
* New arms: fingers curled toward the palm (`GRIP` angles per joint and side;
  MakeHuman finger 1 = thumb, 2 = index), then a rigid ICP (Kabsch, size from
  the old arm length x --scale, hand-weighted samples) started from 2 axis
  signs x 8 rolls gives position + forearm axis. The old blob hands carry no
  usable orientation, so the roll comes from anatomy: `--palmdir_<side>` rolls
  the hand about its forearm axis until the palm faces that direction, then the
  palm slides along its normal into contact with the gun (`--gap`) or is put at
  `--hand_<side>`. Every animation frame reuses the old arm's per-frame rigid
  motion (Kabsch of the old arm verts REF -> frame).
* `--thumb_<side> along` lays the thumb parallel to the index finger (resting
  along the barrel); `--gunmove x,y,z` shifts gun + hands in every frame (the M4
  sits so low/right that a correct grip hand is below the screen edge; 0,3,6
  brings it into view at the cost of a slightly different gun position).
* Finding the numbers: the script prints each hand's bbox / palm centre /
  knuckles at the reference frame; `render_md3.py` renders the MD3, and a
  wireframe x-z / x-y plot with a unit grid (see the session notes) shows where
  the grip and handguard really are. On the M4 the pistol grip is at
  x 20-25, z -18..-30, right face y -24; the handguard at x 50-70.
* MD3: gun surface keeps its UVs squeezed into the top band, arms map into the
  lower band; surfaces split at 4000 tris (see md2_to_md3.py).

## Engine facts learned the hard way (2026-09-04)
* MD3 normals use the Quake 3 byte order: high byte = azimuth atan2(y,x), low
  byte = zenith acos(z). The other order lights the model inside-out (white or
  black arms depending on the light).
* Blender UV v runs bottom-up, MD3 v top-down: flip before writing (`1 - v`).
* q2pro lights view models about 2.5x: a tan skin (200,150,118) turns white.
  Stock hand skins are stored around (75,45,30) - hence `--bandgain 0.35`.
* Cycles bake: `COMBINED` with direct/indirect off bakes black; use `DIFFUSE`
  with DIRECT+INDIRECT+COLOR under a uniform world light (= albedo + soft AO).
* Blender's `open_mainfile` drops every image handle - reload after it.
* The exe's API acts on the app's LAST-USED install unless `dir` is passed.
* MD3 frame header: keep the local origin at 0,0,0. q2pro adds it as a
  translation; a bbox-centre origin pushed the M4 45 units away (25% smaller,
  gap at the screen edge).
* Palm normal = SVD plane through knuckles 2-5 + wrist, sign taken from the
  finger-curl displacement. The raw curl displacement is tilted ~45 deg toward
  the wrist and must not be used as the normal.

Assets (blends, joints, band, finished M4) live in `C:\AI\AIprojectsq2models\hands\`.
