import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { YtDlpChannelSource } from '../capture/ytdlp-channel-source.js';
import { ChannelCollector } from '../channels/channel-collector.js';
import { JsonChannelStore } from '../channels/json-channel-store.js';
import { Collector } from '../core/collector.js';
import type { RunningServer } from '../server/start.js';
import { startServer } from '../server/start.js';
import { startSearchRuntime, type SearchRuntime } from '../search/runtime.js';
import { MarkdownVault } from '../vault/markdown-vault.js';

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | null = null;
let searchRuntime: SearchRuntime | null = null;
let isQuitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

function runtimePath(name: 'yt-dlp' | 'deno' | 'meilisearch'): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', name);
  const environmentName = name === 'yt-dlp'
    ? 'XR_COLLECTOR_YTDLP'
    : name === 'deno'
      ? 'XR_COLLECTOR_DENO'
      : 'XR_COLLECTOR_MEILISEARCH';
  return process.env[environmentName]
    ?? (name === 'meilisearch'
      ? path.join(app.getAppPath(), 'resources', 'bin', 'mac', name)
      : name);
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
  const channelSource = new YtDlpChannelSource({
    binaryPath: runtimePath('yt-dlp'),
    javaScriptRuntimePath: runtimePath('deno'),
  });
  const vault = new MarkdownVault(vaultRoot);
  searchRuntime = await startSearchRuntime({
    vault,
    binaryPath: runtimePath('meilisearch'),
    databasePath: path.join(app.getPath('userData'), 'search'),
  });
  const collector = new Collector(capture, vault, searchRuntime.search);
  const channels = new ChannelCollector(channelSource, new JsonChannelStore(vaultRoot), collector);
  server = await startServer({
    collector,
    channels,
    search: searchRuntime.search,
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
  const activeSearchRuntime = searchRuntime;
  server = null;
  searchRuntime = null;
  void activeServer.close()
    .then(() => activeSearchRuntime?.close())
    .finally(() => app.quit());
});
