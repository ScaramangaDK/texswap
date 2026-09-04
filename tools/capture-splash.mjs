// Renders ui/splash.html offscreen at its real window size and writes
// build/splash.bmp (24-bit) - the image the portable exe's unpack stub
// shows instantly on launch, before Electron itself can start.
// Run: npx electron tools/capture-splash.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 560,
    height: 390,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#0e1116',
  });
  await win.loadFile(path.join(ROOT, 'ui', 'splash.html'));
  await new Promise(r => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  const { width: w, height: h } = img.getSize();
  const bgra = img.toBitmap();

  // 24-bit bottom-up BMP
  const rowSize = Math.ceil(w * 3 / 4) * 4;
  const dataSize = rowSize * h;
  const bmp = Buffer.alloc(54 + dataSize);
  bmp.write('BM', 0, 'latin1');
  bmp.writeUInt32LE(54 + dataSize, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(w, 18);
  bmp.writeInt32LE(h, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < h; y++) {
    const src = y * w * 4;
    const dst = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      bmp[dst + x * 3] = bgra[src + x * 4];         // B
      bmp[dst + x * 3 + 1] = bgra[src + x * 4 + 1]; // G
      bmp[dst + x * 3 + 2] = bgra[src + x * 4 + 2]; // R
    }
  }
  fs.writeFileSync(path.join(ROOT, 'build', 'splash.bmp'), bmp);
  console.log(`build/splash.bmp written: ${w}x${h}, ${bmp.length} bytes`);
  app.exit(0);
});
