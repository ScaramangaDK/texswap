# AQ2 Texture Swapper

Restyle AQ2/AQtion map textures for gameplay: browse every texture a map uses,
swap them via q2pro's `softlink` command, preview the result, and save per-map
presets you can share with friends.

**Status: milestone 1** — install scanner + map/texture browser.
Swapping, presets and softlink export are next. See [BRAINSTORM.md](BRAINSTORM.md)
for the full plan and roadmap.

## Run (dev)

```
npm install
npm run dev
```

Then open http://127.0.0.1:5892 and point it at your game dir (e.g.
`C:\AQ2mapping\AQ2\baseaq`). Reads are 100% read-only in this milestone.

## Layout

- `core/` — engine-agnostic logic, plain Node ESM:
  - `vfs.js` — case-insensitive virtual FS over loose files + `.pak` + `.pkz`
  - `bsp.js` — Quake 2 BSP parser (IBSP v38 + QBSP extended): worldspawn, per-texture face counts & areas
  - `decoders.js` — WAL / PCX / TGA decoders (+ PNG/JPG via pngjs & jpeg-js)
  - `thumbs.js` — hi-res-first texture resolution, downscale, PNG thumbnails
  - `scanner.js` — cached `Install` objects tying it all together
- `devserver.js` — local HTTP server: serves `ui/` + JSON API (`/api/scan`, `/api/map`, `/api/thumb`)
- `ui/` — the app frontend (vanilla HTML/CSS/JS)
- `tools/smoke.js` — CLI smoke test: `node tools/smoke.js <gameDir> [thumbOutDir] [mapName]`

The upcoming Electron shell will reuse `core/` and `ui/` unchanged; the dev
server remains the development harness.
