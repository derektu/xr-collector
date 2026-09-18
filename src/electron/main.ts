import path from 'node:path';
import { app, BrowserWindow, powerMonitor, shell } from 'electron';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { YtDlpChannelSource } from '../capture/ytdlp-channel-source.js';
import { ChannelCollector } from '../channels/channel-collector.js';
import { ChannelScheduler } from '../channels/channel-scheduler.js';
import { JsonChannelScheduleStore } from '../channels/json-channel-schedule-store.js';
import { JsonChannelStore } from '../channels/json-channel-store.js';
import { Collector } from '../core/collector.js';
import type { RunningServer } from '../server/start.js';
import { startServer } from '../server/start.js';
import { startAgentAccess } from '../server/agent-access.js';
import { startSearchRuntime, type SearchRuntime } from '../search/runtime.js';
import { MarkdownVault } from '../vault/markdown-vault.js';

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | null = null;
let agentAccess: Awaited<ReturnType<typeof startAgentAccess>> | null = null;
let searchRuntime: SearchRuntime | null = null;
let channelScheduler: ChannelScheduler | null = null;
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
  agentAccess = await startAgentAccess({
    collector,
    search: searchRuntime.search,
    connectionFile: path.join(app.getPath('userData'), 'agent-connection.json'),
    skillPath: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'skills', 'xr-collector-agent'),
  });
  const channels = new ChannelCollector(channelSource, new JsonChannelStore(vaultRoot), collector);
  channelScheduler = new ChannelScheduler(channels, new JsonChannelScheduleStore(vaultRoot));
  await channelScheduler.start();
  server = await startServer({
    collector,
    channels,
    schedule: channelScheduler,
    search: searchRuntime.search,
    port: 0,
    agentInfo: agentAccess.info,
    webRoot: path.join(app.getAppPath(), 'dist', 'web'),
  });
  await createWindow();

  powerMonitor.on('resume', checkScheduleAfterResume);

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

function checkScheduleAfterResume(): void {
  void channelScheduler?.checkNow().catch((error) => console.error(error));
}

app.on('before-quit', (event) => {
  if (!server && !searchRuntime && !channelScheduler && !agentAccess) return;
  event.preventDefault();
  isQuitting = true;
  powerMonitor.removeListener('resume', checkScheduleAfterResume);
  mainWindow?.destroy();
  mainWindow = null;
  const activeServer = server;
  const activeAgentAccess = agentAccess;
  agentAccess = null;
  const activeSearchRuntime = searchRuntime;
  const activeChannelScheduler = channelScheduler;
  server = null;
  searchRuntime = null;
  channelScheduler = null;
  void Promise.resolve()
    .then(() => activeChannelScheduler?.close())
    .then(() => activeServer?.close())
    .then(() => activeAgentAccess?.close())
    .then(() => activeSearchRuntime?.close())
    .finally(() => app.quit());
});
