import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { Collector } from '../core/collector.js';
import type { RunningServer } from '../server/start.js';
import { startServer } from '../server/start.js';
import { MarkdownVault } from '../vault/markdown-vault.js';

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | null = null;
let isQuitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

function runtimePath(name: 'yt-dlp' | 'deno'): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', name);
  return process.env[name === 'yt-dlp' ? 'XR_COLLECTOR_YTDLP' : 'XR_COLLECTOR_DENO'] ?? name;
}

async function createWindow(): Promise<void> {
  if (!server) throw new Error('Server must start before the window');
  const serverUrl = server.url;
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    show: false,
    title: 'XR Collector',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) event.preventDefault();
  });
  window.on('closed', () => {
    mainWindow = null;
  });
  await window.loadURL(serverUrl);
  mainWindow = window;
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  const vaultRoot = path.resolve(
    process.env.XR_COLLECTOR_VAULT ?? path.join(app.getPath('userData'), 'vault'),
  );
  const capture = new YtDlpCapture({
    binaryPath: runtimePath('yt-dlp'),
    javaScriptRuntimePath: runtimePath('deno'),
  });
  const collector = new Collector(capture, new MarkdownVault(vaultRoot));
  server = await startServer({
    collector,
    port: 0,
    webRoot: path.join(app.getAppPath(), 'dist', 'web'),
  });
  await createWindow();

  app.on('activate', () => {
    if (!mainWindow && server && !isQuitting) {
      void createWindow().catch((error) => console.error(error));
    }
  });
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (!server) return;
  event.preventDefault();
  isQuitting = true;
  mainWindow?.destroy();
  mainWindow = null;
  const activeServer = server;
  server = null;
  void activeServer.close().finally(() => app.quit());
});
