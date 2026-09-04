// Electron shell: runs the local server in-process and opens the app window.
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.AQ2TS_ELECTRON = '1';
// Some launch contexts hand children a stripped environment; the settings
// store must never fall back to a relative path, so pin APPDATA here.
if (!process.env.APPDATA) process.env.APPDATA = app.getPath('appData');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const URL_ = 'http://127.0.0.1:5892';

async function serverReady(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(URL_ + '/api/defaults');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// The splash stays up at least this long, even when everything is cached -
// long enough to watch the bar fill all the way to 100%.
const SPLASH_MIN_MS = 4500;

app.whenReady().then(async () => {
  const t0 = Date.now();

  // compact frameless splash: the logo with a progress bar under it,
  // while the real window loads hidden behind it
  const splash = new BrowserWindow({
    width: 560,
    height: 390,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    backgroundColor: '#0e1116',
    icon: path.join(ROOT, 'build', 'icon.ico'),
    // keep the bar animating even if the window gets occluded
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  splash.loadFile(path.join(ROOT, 'ui', 'splash.html'));

  const win = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'build', 'icon.ico'),
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // external links (if any ever appear) go to the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(URL_)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const push = (phase, done = 0, total = 0) => {
    if (splash.isDestroyed()) return;
    splash.webContents
      .executeJavaScript(`window.setProgress && window.setProgress(${JSON.stringify(phase)}, ${done | 0}, ${total | 0})`)
      .catch(() => { /* splash already gone */ });
  };

  await import('./devserver.js');
  await serverReady();

  // Warm the last-used install behind the splash (live progress on the bar),
  // so the main page opens fully populated instead of showing its own scan.
  push('Indexing game files');
  try {
    const tScan = Date.now();
    const { dir } = await (await fetch(URL_ + '/api/defaults')).json();
    if (dir) {
      while (Date.now() - tScan < 90000) {
        const s = await (await fetch(URL_ + '/api/scan?dir=' + encodeURIComponent(dir))).json();
        if (!s.scanning) break;
        if (s.progress && s.progress.total) push('Scanning maps', s.progress.done, s.progress.total);
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch { /* open the app anyway - it has its own progress UI */ }
  push('Loading interface');
  try {
    await win.loadURL(URL_);
  } catch { /* show whatever we have */ }

  // run the bar to 100% over whatever splash time remains, then swap windows
  const left = Math.max(400, SPLASH_MIN_MS - (Date.now() - t0));
  if (!splash.isDestroyed()) {
    splash.webContents
      .executeJavaScript(`window.finishTo && window.finishTo(${Math.max(50, left - 150)})`)
      .catch(() => { /* splash already gone */ });
  }
  await new Promise(r => setTimeout(r, left));
  if (!win.isDestroyed()) win.show();
  if (!splash.isDestroyed()) splash.close();
});

app.on('window-all-closed', () => app.quit());
