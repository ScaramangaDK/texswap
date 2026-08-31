// Electron shell: runs the local server in-process and opens the app window.
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.AQ2TS_ELECTRON = '1';
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

app.whenReady().then(async () => {
  await import('./devserver.js');
  await serverReady();

  const win = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 900,
    minHeight: 600,
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
  win.loadURL(URL_);
});

app.on('window-all-closed', () => app.quit());
