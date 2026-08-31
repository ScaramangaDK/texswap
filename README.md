# AQ2 Texture Swapper

Restyle AQ2/AQtion map textures for gameplay: browse every texture a map uses,
swap them via q2pro's `softlink` command, preview the result, and save per-map
presets you can share with friends.

**Status: milestone 2** — swapping works end-to-end (engine-verified).
See [BRAINSTORM.md](BRAINSTORM.md) for the full plan, roadmap and verified
engine facts.

## Run (dev)

```
npm install
npm run dev
```

Open http://127.0.0.1:5892 and point it at your AQ2 install root (e.g.
`C:\AQ2mapping\AQ2` — it auto-detects `action` layered over `baseaq`).

1. Click **Install game hook** once (adds one `exec texswap/hook.cfg` line to
   your `autoexec.cfg`; hook sets `cl_beginmapcmd` and binds **F9**).
2. Pick a map, click any texture → choose a stock replacement or a flat
   visibility texture; click the skybox card to change the sky.
3. Play. Presets auto-apply on every map load; press **F9** to re-apply after
   changing things mid-map.

Everything the app writes lives in `<modDir>/texswap/` (per-map cfgs with hard
`link` commands, generated textures in `gen/`, `presets.json`) plus that one
autoexec line. Shipped game files are never touched; "Reset map" reverts a map
to stock.

## Layout

- `core/` — engine-agnostic logic, plain Node ESM:
  - `vfs.js` — engine-accurate virtual FS: game-dir layering (action over baseaq), archive priority, loose files, shipped soft-link fallbacks
  - `bsp.js` — Quake 2 BSP parser (IBSP v38 + QBSP extended): worldspawn, per-texture face counts & areas
  - `decoders.js` — WAL / PCX / TGA decoders (+ PNG/JPG via pngjs & jpeg-js)
  - `thumbs.js` — hi-res-first texture resolution, downscale, PNG thumbnails
  - `gen.js` — encoders (PNG/JPG/TGA/WAL with palette quantization + mips), flat-texture generator, transcoder
  - `swaps.js` — SwapStore: presets.json, per-map link-cfg generation, hook install
  - `scanner.js` — cached `Install` objects tying it all together
- `devserver.js` — local HTTP server: serves `ui/` + JSON API
- `ui/` — the app frontend (vanilla HTML/CSS/JS)
- `tools/smoke.js` — CLI smoke test: `node tools/smoke.js <gameDir> [thumbOutDir] [mapName]`

The upcoming Electron shell will reuse `core/` and `ui/` unchanged; the dev
server remains the development harness.
