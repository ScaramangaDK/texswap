// Smoke test: scan a real install from the CLI, print maps + one map's top textures,
// and dump a few thumbnails as PNG files for visual inspection.
import fs from 'node:fs';
import path from 'node:path';
import { getInstall } from '../core/scanner.js';

const dir = process.argv[2] || 'C:\\AQ2mapping\\AQ2\\baseaq';
const outDir = process.argv[3] || null;

const t0 = Date.now();
const inst = getInstall(dir);
console.log('game dir :', inst.gameDir);
console.log('archives :', inst.fs.describeSources().join(', '));
console.log('palette  :', inst.palette ? 'loaded (colormap.pcx)' : 'MISSING');
for (const w of inst.fs.warnings) console.log('warning  :', w);

const maps = inst.listMaps();
console.log(`\nmaps: ${maps.length} (scan took ${Date.now() - t0} ms)`);
for (const m of maps) {
  const err = m.error ? `  ERROR: ${m.error}` : '';
  const ext = m.extended ? ' [QBSP]' : '';
  console.log(`  ${m.name.padEnd(20)} ${String(m.textureCount ?? '-').padStart(3)} tex  sky=${String(m.sky).padEnd(12)} ${m.source}${ext}  ${m.title || ''}${err}`);
}

const pick = process.argv[4] || (maps.find(m => !m.error) || {}).name;
if (pick) {
  console.log(`\n--- detail: ${pick} ---`);
  const d = inst.mapDetail(pick);
  console.log(`title="${d.title}" sky=${d.sky} textures=${d.textures.length}`);
  for (const t of d.textures.slice(0, 15)) {
    const flags = t.flags.length ? ` [${t.flags.join(',')}]` : '';
    const dims = t.missing ? 'MISSING ' : `${t.w}x${t.h} ${t.ext}`;
    console.log(`  ${t.areaPct.toFixed(1).padStart(5)}%  ${String(t.faces).padStart(4)} faces  ${t.name.padEnd(28)} ${dims}${flags}`);
  }
  const missing = d.textures.filter(t => t.missing);
  if (missing.length) console.log(`  (${missing.length} textures have no image file)`);

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    let dumped = 0;
    for (const t of d.textures) {
      if (t.missing || dumped >= 6) continue;
      const png = inst.thumbPng('textures/' + t.name);
      if (png) {
        fs.writeFileSync(path.join(outDir, t.name.replaceAll('/', '_') + '.png'), png);
        dumped++;
      }
    }
    if (d.sky) {
      const sky = inst.skyThumbPng(d.sky);
      if (sky) fs.writeFileSync(path.join(outDir, 'SKY_' + d.sky + '.png'), sky);
    }
    console.log(`dumped ${dumped} thumbs + sky to ${outDir}`);
  }
}
