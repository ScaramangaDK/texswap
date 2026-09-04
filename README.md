# TexSwap

Restyle AQ2/AQtion map textures for gameplay: browse every texture a map uses,
swap them via q2pro's `softlink` command, preview the result, and save per-map
presets you can share with friends.

**Status: v1.0** â€” full app packaged as a single portable Windows exe.
See [BRAINSTORM.md](BRAINSTORM.md) for the full history, roadmap and verified
engine facts.

## For players (the easy way)

Get `AQ2TexSwap.exe`, put it anywhere, double-click it.
(Windows SmartScreen may warn once â€” "More info â†’ Run anyway"; normal for
unsigned hobby tools.) Then: point it at your AQ2/AQtion folder (Browseâ€¦),
click **Install game hook** in the orange banner, and start swapping.
Press **F9** in game to re-apply after changes; presets auto-apply on
every map load.

## AI upscale (map textures)

**✨ AI upscale…** on a map redraws its textures at 2x/3x/4x with Real-ESRGAN
and stores them as swaps: same art, just crisp. Only the hi-res override is
replaced (what `r_texture_overrides 31` samples); the `.wal` keeps its grid,
so tiling is untouched and low-res mode stays stock. Tick the textures you want (signs and
decals rarely suit it) or take them all; a single texture can also be upscaled
from its card. Textures already above a size you pick are skipped, and results
are cached per texture, so the next map
that shares them is instant. Presets carry the instruction, not the files -
a friend importing one runs the upscale on their own PC.

## Skin studio (weapon models)

**ðŸ”« Weapon skins** in the Swaps panel opens the studio: pick a weapon model
(the gun in your hands or on the ground), see it live in 3D with its skin and
animations, then **Upload skin** (png/jpg/tga/pcx drawn for that model's UV
layout), **AI upscale** it (Real-ESRGAN is downloaded once, 45 MB, into your
AppData folder), **Adjust colors**, or **Replace model** with another Quake 2
`.md2` (an AK-47 in the M4's place, say). **Save UV template** writes the skin
with the model's triangles drawn on top, to paint over in any image editor.
**Restyle** turns any skin into gold, chrome, gunmetal, camo and more (base
materials over the skin's own shading, pattern overlays, color sliders), with
protect boxes you drag on the skin image so the hands stay untouched.
The **Collection** panel lists skins that ship with TexSwap (`library/`) plus
the ones you save (**★ Save to collection…**) or import from friends; click one
to use it. **Export skin** makes one `.aq2skin.json` (skin + model) for friends;
they load it with **Import preset…** and it joins their collection. Skins apply
in game at startup and on every map; a model change needs a map restart, a skin
change shows after **F9**.

## Build the exe

```
npm run dist
```

Output lands in `dist\AQ2TexSwap.exe`. `npm run app` starts the
same app unpackaged (Electron).

## Run (dev)

```
npm install
npm run dev
```

Open http://127.0.0.1:5892 and point it at your AQ2 install root (e.g.
`C:\AQ2mapping\AQ2` â€” it auto-detects `action` layered over `baseaq`).

1. Click **Install game hook** once (adds one `exec texswap/hook.cfg` line to
   your `autoexec.cfg`; hook sets `cl_beginmapcmd` and binds **F9**).
2. Pick a map, click any texture â†’ choose a stock replacement or a flat
   visibility texture; click the skybox card to change the sky.
3. Play. Presets auto-apply on every map load; press **F9** to re-apply after
   changing things mid-map.

Presets: **Save as presetâ€¦** keeps named snapshots per map (chips to load or
delete), **Exportâ€¦** writes `texswap/exports/<map>.aq2swap.json` to send to
friends, **Import presetâ€¦** loads such a file. **Swaps: ON/OFF** in the header
parks everything at stock without losing presets.

Everything the app writes lives in `<modDir>/texswap/` (per-map cfgs with hard
`link` commands, generated textures in `gen/`, `presets.json`) plus that one
autoexec line. Shipped game files are never touched; "Reset map" reverts a map
to stock.

## Layout

- `core/` â€” engine-agnostic logic, plain Node ESM:
  - `vfs.js` â€” engine-accurate virtual FS: game-dir layering (action over baseaq), archive priority, loose files, shipped soft-link fallbacks
  - `bsp.js` â€” Quake 2 BSP parser (IBSP v38 + QBSP extended): worldspawn, per-texture face counts & areas
  - `decoders.js` â€” WAL / PCX / TGA decoders (+ PNG/JPG via pngjs & jpeg-js)
  - `thumbs.js` â€” hi-res-first texture resolution, downscale, PNG thumbnails
  - `gen.js` â€” encoders (PNG/JPG/TGA/WAL with palette quantization + mips), flat-texture generator, transcoder
  - `swaps.js` â€” SwapStore: presets.json, per-map link-cfg generation, hook install
  - `scanner.js` â€” cached `Install` objects tying it all together
  - `md2.js` â€” Quake 2 MD2 model reader (header, skins, UVs, per-frame vertices, UV wireframe)
  - `pcx.js` â€” 8-bit PCX encoder (Q2 palette) for model skins in low-res mode
  - `tools.js` â€” on-demand fetch + runner for Real-ESRGAN (AI upscaler) in `%APPDATA%\AQ2TextureSwapper	ools`
  - `skins.js` â€” SkinStore: weapon skins & replacement models, materialized as `texswap/skins/<weapon>/` + inline `link` lines in hook.cfg and map cfgs
  - `library.js` â€” LibraryStore: the skin collection (`library/**` shipped + per-install app-data `library/`)
  - `upscale.js` ` â TextureUpscaler: AI-upscaled map textures as the `upscale` swap type, content-hashed cache in app-data, background job
- `devserver.js` â€” local HTTP server: serves `ui/` + JSON API
- `ui/` â€” the app frontend (vanilla HTML/CSS/JS); `ui/skins.js` is the Skin studio (three.js md2 preview), `ui/restyle.js` its material/pattern engine
- `tools/smoke.js` â€” CLI smoke test: `node tools/smoke.js <gameDir> [thumbOutDir] [mapName]`

The upcoming Electron shell will reuse `core/` and `ui/` unchanged; the dev
server remains the development harness.
