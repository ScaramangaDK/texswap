# AQ2 Texture Swapper â€” Brainstorm & Plan

*Started 2026-08-31. This is the living planning doc for the project.*

## The idea

A program for AQ2/AQtion players that lets you restyle any map's textures for gameplay purposes:

- See all textures used on a map, ranked by how much they're used
- Swap any of them for another texture and preview the result
- Swap the map's skybox too
- Save your setup as a per-map preset, reset to defaults anytime
- Share presets with friends as small files
- Later: also save lighting settings (gl_modulate etc.) into presets
- Long term: grow into an **AQ2 hub** â€” nick/player setup, server browser, connect & launch the game from the app

## Facts learned from the install (verified 2026-08-31)

Install inspected: `C:\AQ2mapping\AQ2` â€” this is **AQtion** (q2pro-based engine: `aqtion.exe`, `q2pro.exe`), game data in `baseaq\`.

- `baseaq\pak0.pkz` (344 MB, a renamed zip): main content. 3386 texture files (2404 `.wal`, 636 `.png`, 515 `.tga`, 103 `.jpg`), 18 `.bsp` maps, plus `env/` skyboxes.
- `baseaq\2023_25thAnniversary_mapjam.pkz` (102 MB): extra maps. The app must scan **all** pkz/pak files plus loose files.
- `baseaq\pak1.pkz`: default configs â€” **contains the softlink system**:
  - `softlink <virtual-path> <target-path>` is a console command that remaps one file path to another at runtime, e.g. `softlink textures/e1u2/box1_3.wal textures/e1u1/box1_3.wal`
  - AQtion ships `tex-e1u2.cfg` â€¦ `tex-e3u3.cfg` full of these, chained from `textures-action.cfg` via `exec`
  - Links are applied per file (`.wal`, `.pcx`, `.tga` linked separately); community docs also show directory-level links (`softlink textures textures-hd`)
  - Softlinks are runtime state, applied by exec'ing cfg files â†’ **per-map presets = exec a different cfg per map**
- `baseaq\README.md` says: never modify shipped pkz files; add your own files alongside. The app will follow this â€” everything it writes is additive and reversible.

## Decisions (interview 2026-08-31)

| Topic | Decision |
|---|---|
| Installs | User has **several installs** â†’ app has folder picker + install profiles |
| Preview | **Game path first**: V1 applies swaps to the real game with instant reload; V2 adds a built-in 3D map viewer |
| Swap sources | **Stock AQ2 textures** + **generated flat/clean textures** (visibility mode). Custom image import = maybe later |
| Distribution | **Single portable .exe** (no installer) |
| Applying presets | **Automatic on map load** (game hook), keybind as fallback |
| Sharing | **Export/import preset files** (Discord-friendly) |
| Skyboxes | **Yes, in V1** â€” swap a map's skybox like any texture |
| Sounds | Not now; maybe later (same softlink mechanism works for `.wav`) |
| Long-term vision | Grow into an **AQ2 hub**: nick/player setup, server browser, connect from the app |

## How V1 works (architecture)

Stack: **Electron** (Node backend + web UI) â†’ portable .exe (~90 MB), and the web UI later becomes the 3D viewer (three.js) in V2.
*(Originally planned as Tauri for a ~10 MB exe, but this machine has Node 24 and no Rust/MSVC toolchain â€” Electron avoids a multi-GB compiler install and all core logic is plain JS either way. Decided 2026-08-31.)*

1. **Read game data** (read-only): open all pkz/pak in the chosen install's `baseaq`.
   - Parse `.bsp`: texinfo lump lists texture names; faces lump gives usage counts â†’ "most used" ranking
   - Decode `.wal` (8-bit + Q2 palette from `pics/colormap.pcx`), `.pcx`, `.tga`, `.png`, `.jpg` â†’ thumbnails
2. **UI**: pick install profile â†’ pick map â†’ texture grid sorted by usage â†’ click texture â†’ choose replacement (browse/search stock textures, or generate flat/clean texture with color + brightness choice) â†’ before/after thumbnails.
   - **Skybox panel**: the map's current sky is read from the BSP's worldspawn `sky` key; show all available `env/` skyboxes as previews and swap (via `sky <name>` command in the map cfg if supported, else 12 `env/` softlinks like AQtion's own configs do).
3. **Apply**: write `baseaq/texswap/<mapname>.cfg` with softlink lines. One-time setup adds a hook (e.g. `cl_beginmapcmd "exec texswap/$mapname.cfg"`) so the game auto-applies on every map load. Keybind (e.g. F9: exec + texture flush) for applying while in a map.
4. **Reset**: per-map or global â€” remove/empty our cfg files, plus in-session unlink or reload. Shipped game files are never touched.
5. **Presets**: stored as JSON per map per profile; export/import as a single small file.

## Progress

- **2026-08-31 â€” Milestone 1 done**: scanner + browser working against the real install. Reads loose files + `.pak` + `.pkz`; parses maps with titles, skyboxes, per-texture face counts and visible-area ranking; decodes WAL (palette), PCX, TGA, PNG, JPG thumbnails; dark UI with map list, search, sort, utility-surface toggle, skybox card. Run with `npm run dev`.
- **2026-08-31 â€” Milestone 2 done (engine-verified)**: full swap pipeline working.
  - Scanner now mirrors the engine's real search path: `action/` layered over `baseaq/`, non-numbered archives > numbered pakN > loose files, plus the shipped soft-link fallbacks â€” 1804 maps and 20,884 textures found on the mapping install.
  - Swap UI: click texture â†’ picker (stock textures with search, or generated flat/grid visibility textures), skybox picker, per-swap remove, per-map reset, per-map swap badges.
  - Writes `<modDir>/texswap/<map>.cfg` for every map (hard `link` lines + `unlink --all` + `r_reload`), generated textures in `texswap/gen/` (same-extension transcodes: PNG/JPG/TGA/WAL encoders incl. palette quantization + mipmaps), `presets.json`, `hook.cfg`, and one appended line in `autoexec.cfg`.
  - Proven headlessly with q2proded (exec chain autoexec â†’ hook â†’ map cfg; texture and sky links resolve to our generated files) and then **confirmed live in the user's q2pro client on urbanjungle**: flat-grid walls, stone ground, swapped sky, lightmaps intact. One fix was needed along the way: `${cl_mapname}` must be braced in the hook (plain `$cl_mapname.cfg` parses the dot into the macro name and expands empty).

- **2026-08-31 â€” Milestone 3 done**: named presets per map (save/load/delete chips), export to `texswap/exports/<map>.aq2swap.json` for Discord sharing, import with validation (missing replacement textures skipped with warnings, unknown maps stored for later), and a master "Swaps: ON/OFF" toggle that parks every map at stock while keeping all presets. Verified end-to-end incl. exportâ†’import roundtrip.

- **2026-08-31 â€” Feedback round 1** (user request): fixed grid pattern (lines now centered per tile â†’ true symmetric grid, previews and tiling both clean); added checker/stripes/diagonal patterns with visual style buttons; Flat tab now also offers the user's **ralle_colors** Quake-palette WALs (246 flats in `action/textures/ralle_colors`) as a clickable palette; folder **Browseâ€¦** dialog with "looks like an AQ2 install" detection plus a **?** help popup for the path; active preset chip is highlighted.

- **2026-08-31 â€” Lighting milestone**: opt-in managed lighting â€” global defaults + per-map overrides for `gl_modulate`, `gl_modulate_world/entities`, `gl_brightness`, `intensity`, `gl_saturation`, `gl_coloredlightmaps`, `gl_dynamic`, `gl_picmip`, `r_override_textures` + free-form extra cfg lines. (`r_texture_overrides` mask parked at user request until documentation is found â€” settable via extra lines meanwhile. `gl_brightness` default is ~0.1 per user.) Written into every map cfg when managed so nothing leaks between maps; included in saved presets and export/import. Also fixed user-reported bug: clearing a swap + F9 didn't revert visually (touched maps now always `r_reload`, and the F9 bind appends `r_reload` too).
- **Confirmed final scope before packaging** (user, 2026-08-31): 3D viewer, custom image import, sound swaps, team pack sharing, polish â€” THEN the portable .exe.

- **2026-08-31 â€” Custom images + invisible swaps** (user request, generalized to all textures): "Your image" tab in the picker uploads png/jpg/tga (stored as master PNG in `texswap/custom/`, transcoded per format like any swap; embedded base64 in export files so sharing works); "Make invisible" swaps to a fully transparent png/tga â€” hi-res-path only (WAL has no alpha; low-res mode keeps the original gracefully), flagged experimental pending in-game confirmation on opaque surfaces. Recents/favorites/low-res-preview shipped same day.

- **2026-08-31 â€” Favorite collections** (user request, aimed at mapmakers): named texture sets ("great bricks", "Makkons best metal", â€¦) on top of the â˜… All-favorites list. Any texture joins any number of collections via a ï¼‹ popup in the picker; a dropdown filters the picker to a collection; adding to a collection auto-stars (All favorites stays the superset); collections deletable. Future synergy: include collections in team-pack sharing.

- **2026-08-31 â€” UI design-system overhaul** (user request, done overnight): stylesheet rewritten as one coherent system â€” token set (4 layered surfaces, one orange accent + semantic good/bad/info, 6/10/14 radii, 2 shadows), exactly two typefaces (Segoe UI Variable + Cascadia Mono/Consolas), uppercase micro-labels, unified 32px controls & button variants (base/primary/danger/small), brand stripe + gradient logo, refined cards (hover lift, swap rings), chip rail for presets, underline tabs, consistent modal chrome with animations, styled scrollbars, toast slide-ins, glass viewer bars. All class names/IDs preserved â€” zero behavior changes.

- **2026-08-31 â€” Durable storage**: presets/collections/custom-image masters moved to `%APPDATA%\AQ2TextureSwapper\installs\<slug-hash>\` (per install), with silent migration from the old in-install location. Game-side files (per-map cfgs, gen/, exports) stay in the install and are fully regenerable â€” after a game reinstall, one click on Install game hook rebuilds everything. First-run UX: prominent setup banner with one-click hook install; in-app ðŸ“„ Readme dialog replaced the ?-help; hook chip removed (button only when missing).

## Verified engine facts (tested against AQtion q2proded + source, 2026-08-31)

- **`softlink` is fallback-only** â€” it fires only when the requested file does not exist. **`link` (hard) expands before the file search and overrides existing files â†’ the app uses `link`.** Same syntax; `unlink --all` clears only hard links (AQtion's shipped soft links live in a separate list â€” clean namespace separation).
- Links are prefix-matched (directory links work, used for skybox swaps: `link env/<from> env/<to>`), cleared on `fs_restart`, applied per exec.
- Cross-extension links resolve at FS level, but the image decoder is chosen by the *requested* extension â†’ the app transcodes replacements to matching extensions.
- `cl_beginmapcmd` + `$cl_mapname` macro exist (client), `r_reload` refreshes textures in-game, `whereis` resolves links (great for debugging).
- **Hi/low-res texture settings** (from user): `r_override_textures` enables truecolor override of WAL/PCX; `r_texture_overrides` is a bitmask choosing which categories (world textures, skins, HUD, console) use hi-res â€” user runs 15 (world low-res) and toggles 31 (world hi-res). The app links **all** relevant extensions (existing + canonical .png and .wal) so swaps work in both modes. A per-preset hi/low toggle is planned for V3.
- **Texture alpha on world surfaces** (in-game test by user, 2026-08-31): a transparent replacement makes the surface invisible **only on trans-flagged surfaces** (SURF_TRANS33/66 â€” signs, glass, overlays); on opaque surfaces the engine renders the transparent areas **solid black**.
- **Invisible feature REMOVED before v1.0 release** (user decision, 2026-08-31): see-through fences/grates are a cheat in a competitive shooter, so no obvious one-click button. Removed the UI option, the server rejects `type: invisible` (set + import), and stored invisible swaps/presets are purged on load. Deliberately NO transparency policing of custom uploads (user decision): determined cheaters can drop files in the texture folder by hand anyway, and legit alpha cutouts must stay easy.

## Roadmap

- **V1 (core)**: everything above, including skybox swapping. Test in-game on user's machine, then beta with one friend.
- **V2 (wow)**: âœ” **shipped 2026-08-31 (v1)** â€” built-in 3D map viewer: server extracts triangulated per-texture geometry with real texinfo UVs (`/api/mapgeo`, wal-based texel scaling), three.js renders it with the current swaps applied (flat/stock/custom/invisible all honored â€” invisible shows trans surfaces gone and opaque ones black, mirroring the engine); fly controls (drag-look + WASD/QE/Shift), camera starts at a player spawn, hover shows the texture name, click a surface â†’ "Swap this textureâ€¦" opens the picker, and every swap updates the viewer instantly. **Lightmaps added same day**: server unpacks the BSP lighting lump per face (16-texel luxel grid, style 0), shelf-packs a per-map RGB atlas (`/api/maplight` PNG) with 1px padding, emits `uv1` lightmap coords; viewer uses MeshBasicMaterial mapÃ—lightMap (texture.channel=1 â€” gotcha: three defaults to channel 0), intensity follows managed `gl_modulate`. Warp/unlit faces sample a white block. Remaining polish ideas: skybox rendering, warp-water animation.
- **V3 (presets+)**: ~~named presets + export/import files~~ âœ” done. Remaining: lighting presets (`gl_modulate`, `gl_modulate_world`, `gl_brightness`, `intensity`, â€¦) saved alongside texture presets; hi/low-res toggle (`r_texture_overrides` 15/31) per preset; custom image import; sound swaps; "team pack" bundle sharing.
- **V1.1 startup polish âœ” done 2026-08-31**: the Electron window now opens instantly with a branded splash (ui/splash.html, loaded via loadFile before the server import), and the first map scan runs async server-side (Install.scanMapsAsync yields every 20 maps) while /api/scan reports `{scanning, progress}` and the UI polls it, showing "Scanning maps… 460 / 1804" live. Only the portable exe's own self-extraction (~2-5s before any window) remains, inherent to the portable format.
- **Packaging: âœ” v1.0 SHIPPED 2026-08-31** â€” Electron shell (`electron-main.mjs` runs the server in-process, window at 127.0.0.1:5892) + electron-builder portable target â†’ `dist\AQ2TexSwap.exe` (~98 MB, one file, logo icon). First-run: friendly welcome/Browse prompt when no install found, orange setup banner for the hook. Verified end-to-end (boot, embedded server, 1804-map scan). Deferred to v1.1: ~~viewer skybox~~ âœ” done 2026-08-31 (cube backdrop from env faces via /api/skyface, honors sky swaps; Q2 faces mirrored horizontally for three.js cube sampling - SKY_XFORM in viewer.js, AQVskyRot for live recalibration), sound swaps, ~~team packs~~ done 2026-08-31 (texture swaps only - sky/lighting are personal; .aq2pack.json via Export pack button, Import preset auto-detects packs and never touches the receiver's sky/lighting).
- **V4 (the hub)**: the app becomes the everyday AQ2 launcher:
  *(note: user starts the game via `q2pro.exe`, not the `aqtion.exe` stub â€” make the launch exe configurable)*
  - **Player setup**: edit nick, skin/model, and common client settings from a friendly UI (writes cvars like `name`/`skin` to cfg)
  - **Server browser**: query master servers / aq2world list + UDP `status` pings â†’ live list of Action servers with map, players, ping; see who's playing where
  - **Connect from app**: click a server â†’ launches `aqtion.exe +connect ip:port` with your chosen install profile, nick, and texture presets already hooked in

## Still to verify in the live client

1. ~~Hook + apply flow~~ âœ” confirmed live 2026-08-31 (F9 path). Still nice to confirm: auto-apply on a map *change* without pressing anything.
2. Visual quality of generated WALs (palette quantization) in low-res mode (`r_texture_overrides 15`).
3. Engine source: https://github.com/actionquake (branch `aqtion`)

## Notes

- Portable unsigned .exe will trigger Windows SmartScreen once ("More info â†’ Run anyway") â€” tell friends this is expected.
- User is new to git; set up a GitHub repo for this project when coding starts (like the AQF backup).

## References

- AQ2 Pro addon / softlink usage: https://aq2world.com/pro and https://actionquakenet.wordpress.com/aq2_pro/
- AQtion project source: https://github.com/actionquake
- AQ2World wiki: https://wiki.aq2world.com/wiki/How_to
