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
- `devserver.js` â€” local HTTP server: serves `ui/` + JSON API
- `ui/` â€” the app frontend (vanilla HTML/CSS/JS)
- `tools/smoke.js` â€” CLI smoke test: `node tools/smoke.js <gameDir> [thumbOutDir] [mapName]`

The upcoming Electron shell will reuse `core/` and `ui/` unchanged; the dev
server remains the development harness.
