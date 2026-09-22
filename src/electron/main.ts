import path from 'node:path';
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { YtDlpChannelSource } from '../capture/ytdlp-channel-source.js';
import { CollectorRuntime } from '../runtime/collector-runtime.js';
import { FileThemePreference, type StoredTheme } from './theme-preference.js';

let mainWindow: BrowserWindow | null = null;
let runtime: CollectorRuntime | null = null;
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
  if (!runtime) throw new Error('Runtime must start before the window');
  const serverUrl = runtime.server.url;
  const validationSize = /^([0-9]+)x([0-9]+)$/.exec(process.env.XR_COLLECTOR_VALIDATION_WINDOW_SIZE ?? '');
  const width = validationSize ? Number(validationSize[1]!) : 1240;
  const height = validationSize ? Number(validationSize[2]!) : 820;
  const window = new BrowserWindow({
    width,
    height,
    minWidth: 880,
    minHeight: 620,
    show: false,
    title: 'XR Collector',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(app.getAppPath(), 'dist', 'node', 'electron', 'preload.cjs'),
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
    return themePreference!.write(theme).catch((error: unknown) => { console.warn('Unable to save theme preference', error); });
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
  runtime = await CollectorRuntime.start({
    profilePath: app.getPath('userData'),
    workspace: {
      defaultRoot: vaultRoot, capture, channelSource,
      searchBinary: runtimePath('meilisearch'),
      searchData: path.join(app.getPath('userData'), 'search'),
    },
    connectionFile: path.join(app.getPath('userData'), 'agent-connection.json'),
    skillPath: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'skills', 'xr-collector-agent'),
    uiPort: 0,
    webRoot: path.join(app.getAppPath(), 'dist', 'web'),
  });
  await createWindow();

  powerMonitor.on('resume', checkScheduleAfterResume);

  app.on('activate', () => {
    if (!mainWindow && runtime && !isQuitting) {
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
  void runtime?.workspace?.schedule.checkNow().catch((error) => console.error(error));
}

app.on('before-quit', (event) => {
  if (!runtime) return;
  event.preventDefault();
  isQuitting = true;
  powerMonitor.removeListener('resume', checkScheduleAfterResume);
  mainWindow?.destroy();
  mainWindow = null;
  const activeRuntime = runtime;
  runtime = null;
  void activeRuntime.close()
    .finally(() => app.quit());
});
