import path from 'node:path';
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { YtDlpChannelSource } from '../capture/ytdlp-channel-source.js';
import { ChannelScheduler } from '../channels/channel-scheduler.js';
import type { RunningServer } from '../server/start.js';
import { startServer } from '../server/start.js';
import { startAgentAccess } from '../server/agent-access.js';
import { VaultWorkspace } from '../vault/workspace.js';
import { FileThemePreference, type StoredTheme } from './theme-preference.js';

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | null = null;
let agentAccess: Awaited<ReturnType<typeof startAgentAccess>> | null = null;
let workspace: VaultWorkspace | null = null;
let channelScheduler: ChannelScheduler | null = null;
let themePreference: FileThemePreference | null = null;
let isQuitting = false;

if (process.env.XR_COLLECTOR_PROFILE) app.setPath('userData', path.resolve(process.env.XR_COLLECTOR_PROFILE));

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

function runtimePath(name: 'yt-dlp' | 'deno' | 'meilisearch'): string {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', executable);
  const environmentName = name === 'yt-dlp'
    ? 'XR_COLLECTOR_YTDLP'
    : name === 'deno'
      ? 'XR_COLLECTOR_DENO'
      : 'XR_COLLECTOR_MEILISEARCH';
  return process.env[environmentName]
    ?? (name === 'meilisearch'
      ? path.join(app.getAppPath(), 'resources', 'bin', process.platform === 'win32' ? 'win' : 'mac', executable)
      : executable);
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
      preload: path.join(app.getAppPath(), 'dist', 'node', 'electron', 'preload.js'),
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
  themePreference = new FileThemePreference(path.join(app.getPath('userData'), 'appearance.json'));
  ipcMain.handle('xrCollector:theme:read', () => themePreference!.read());
  ipcMain.handle('xrCollector:theme:write', (_event, theme: StoredTheme) => {
    if (theme !== 'dark' && theme !== 'light') throw new Error('Unsupported theme preference');
    if (process.env.XR_COLLECTOR_THEME_CONFIG_FAILURE === '1') throw new Error('Theme preference write is unavailable');
    return themePreference!.write(theme);
  });
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
  workspace = await VaultWorkspace.open({
    defaultRoot: vaultRoot, capture, channelSource,
    searchBinary: runtimePath('meilisearch'),
    searchData: path.join(app.getPath('userData'), 'search'),
  });
  const { collector, channels, schedule, search } = workspace;
  channelScheduler = schedule;
  agentAccess = await startAgentAccess({
    transfer: workspace,
    collector,
    search,
    connectionFile: path.join(app.getPath('userData'), 'agent-connection.json'),
    skillPath: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'skills', 'xr-collector-agent'),
  });
  server = await startServer({
    collector,
    transfer: workspace,
    channels,
    schedule: channelScheduler,
    search,
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
  if (!server && !workspace && !channelScheduler && !agentAccess) return;
  event.preventDefault();
  isQuitting = true;
  powerMonitor.removeListener('resume', checkScheduleAfterResume);
  mainWindow?.destroy();
  mainWindow = null;
  const activeServer = server;
  const activeAgentAccess = agentAccess;
  agentAccess = null;
  const activeWorkspace = workspace;
  const activeChannelScheduler = channelScheduler;
  server = null;
  workspace = null;
  channelScheduler = null;
  void Promise.resolve()
    .then(() => activeChannelScheduler?.close())
    .then(() => activeServer?.close())
    .then(() => activeAgentAccess?.close())
    .then(() => activeWorkspace?.close())
    .finally(() => app.quit());
});
