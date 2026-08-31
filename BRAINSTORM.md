# AQ2 Texture Swapper — Brainstorm & Plan

*Started 2026-08-31. This is the living planning doc for the project.*

## The idea

A program for AQ2/AQtion players that lets you restyle any map's textures for gameplay purposes:

- See all textures used on a map, ranked by how much they're used
- Swap any of them for another texture and preview the result
- Swap the map's skybox too
- Save your setup as a per-map preset, reset to defaults anytime
- Share presets with friends as small files
- Later: also save lighting settings (gl_modulate etc.) into presets
- Long term: grow into an **AQ2 hub** — nick/player setup, server browser, connect & launch the game from the app

## Facts learned from the install (verified 2026-08-31)

Install inspected: `C:\AQ2mapping\AQ2` — this is **AQtion** (q2pro-based engine: `aqtion.exe`, `q2pro.exe`), game data in `baseaq\`.

- `baseaq\pak0.pkz` (344 MB, a renamed zip): main content. 3386 texture files (2404 `.wal`, 636 `.png`, 515 `.tga`, 103 `.jpg`), 18 `.bsp` maps, plus `env/` skyboxes.
- `baseaq\2023_25thAnniversary_mapjam.pkz` (102 MB): extra maps. The app must scan **all** pkz/pak files plus loose files.
- `baseaq\pak1.pkz`: default configs — **contains the softlink system**:
  - `softlink <virtual-path> <target-path>` is a console command that remaps one file path to another at runtime, e.g. `softlink textures/e1u2/box1_3.wal textures/e1u1/box1_3.wal`
  - AQtion ships `tex-e1u2.cfg` … `tex-e3u3.cfg` full of these, chained from `textures-action.cfg` via `exec`
  - Links are applied per file (`.wal`, `.pcx`, `.tga` linked separately); community docs also show directory-level links (`softlink textures textures-hd`)
  - Softlinks are runtime state, applied by exec'ing cfg files → **per-map presets = exec a different cfg per map**
- `baseaq\README.md` says: never modify shipped pkz files; add your own files alongside. The app will follow this — everything it writes is additive and reversible.

## Decisions (interview 2026-08-31)

| Topic | Decision |
|---|---|
| Installs | User has **several installs** → app has folder picker + install profiles |
| Preview | **Game path first**: V1 applies swaps to the real game with instant reload; V2 adds a built-in 3D map viewer |
| Swap sources | **Stock AQ2 textures** + **generated flat/clean textures** (visibility mode). Custom image import = maybe later |
| Distribution | **Single portable .exe** (no installer) |
| Applying presets | **Automatic on map load** (game hook), keybind as fallback |
| Sharing | **Export/import preset files** (Discord-friendly) |
| Skyboxes | **Yes, in V1** — swap a map's skybox like any texture |
| Sounds | Not now; maybe later (same softlink mechanism works for `.wav`) |
| Long-term vision | Grow into an **AQ2 hub**: nick/player setup, server browser, connect from the app |

## How V1 works (architecture)

Stack: **Electron** (Node backend + web UI) → portable .exe (~90 MB), and the web UI later becomes the 3D viewer (three.js) in V2.
*(Originally planned as Tauri for a ~10 MB exe, but this machine has Node 24 and no Rust/MSVC toolchain — Electron avoids a multi-GB compiler install and all core logic is plain JS either way. Decided 2026-08-31.)*

1. **Read game data** (read-only): open all pkz/pak in the chosen install's `baseaq`.
   - Parse `.bsp`: texinfo lump lists texture names; faces lump gives usage counts → "most used" ranking
   - Decode `.wal` (8-bit + Q2 palette from `pics/colormap.pcx`), `.pcx`, `.tga`, `.png`, `.jpg` → thumbnails
2. **UI**: pick install profile → pick map → texture grid sorted by usage → click texture → choose replacement (browse/search stock textures, or generate flat/clean texture with color + brightness choice) → before/after thumbnails.
   - **Skybox panel**: the map's current sky is read from the BSP's worldspawn `sky` key; show all available `env/` skyboxes as previews and swap (via `sky <name>` command in the map cfg if supported, else 12 `env/` softlinks like AQtion's own configs do).
3. **Apply**: write `baseaq/texswap/<mapname>.cfg` with softlink lines. One-time setup adds a hook (e.g. `cl_beginmapcmd "exec texswap/$mapname.cfg"`) so the game auto-applies on every map load. Keybind (e.g. F9: exec + texture flush) for applying while in a map.
4. **Reset**: per-map or global — remove/empty our cfg files, plus in-session unlink or reload. Shipped game files are never touched.
5. **Presets**: stored as JSON per map per profile; export/import as a single small file.

## Progress

- **2026-08-31 — Milestone 1 done**: scanner + browser working against the real install. Reads loose files + `.pak` + `.pkz`; parses all 26 maps (pak0 + mapjam) with titles, skyboxes, per-texture face counts and visible-area ranking; decodes WAL (palette), PCX, TGA, PNG, JPG thumbnails; dark UI with map list, search, sort, utility-surface toggle, skybox card. Run with `npm run dev`. Next: milestone 2 = swap UI + softlink cfg writer + in-game verification.

## Roadmap

- **V1 (core)**: everything above, including skybox swapping. Test in-game on user's machine, then beta with one friend.
- **V2 (wow)**: built-in 3D map viewer — renders the actual BSP with lightmaps in the app, click a wall to select its texture, swaps preview instantly without the game running.
- **V3 (presets+)**: lighting presets (`gl_modulate`, `gl_modulate_world`, `gl_brightness`, `intensity`, …) saved alongside texture presets; custom image import; sound swaps; "team pack" bundle sharing.
- **V4 (the hub)**: the app becomes the everyday AQ2 launcher:
  - **Player setup**: edit nick, skin/model, and common client settings from a friendly UI (writes cvars like `name`/`skin` to cfg)
  - **Server browser**: query master servers / aq2world list + UDP `status` pings → live list of Action servers with map, players, ping; see who's playing where
  - **Connect from app**: click a server → launches `aqtion.exe +connect ip:port` with your chosen install profile, nick, and texture presets already hooked in

## To verify while building V1 (against AQtion/q2pro source + live game)

1. Does `cl_beginmapcmd` (or similar q2pro hook) expand a `$mapname`-style macro so auto-per-map exec works? Fallback: keybind.
2. How to *remove* a softlink in-session (is there an unlink command, or does re-linking/`fs_restart`/restart handle reset)?
3. Best texture-flush command after changing links mid-map (`r_reload`? `vid_restart`? `fs_restart`?).
4. Do cross-extension links work (`.wal` → `.tga`), or should generated flat textures be written as real `.wal` files? (Shipped examples only link same-extension; writing `.wal` is the safe route.)
5. Is there a `sky <name>` console command for per-map skybox override (simpler than 12 env softlinks)?
6. Engine source: https://github.com/actionquake

## Notes

- Portable unsigned .exe will trigger Windows SmartScreen once ("More info → Run anyway") — tell friends this is expected.
- User is new to git; set up a GitHub repo for this project when coding starts (like the AQF backup).

## References

- AQ2 Pro addon / softlink usage: https://aq2world.com/pro and https://actionquakenet.wordpress.com/aq2_pro/
- AQtion project source: https://github.com/actionquake
- AQ2World wiki: https://wiki.aq2world.com/wiki/How_to
