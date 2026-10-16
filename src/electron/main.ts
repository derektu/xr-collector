import { stat } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from 'electron';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { YtDlpChannelSource } from '../capture/ytdlp-channel-source.js';
import { agentConnectionFile } from '../runtime/agent-discovery.js';
import { CollectorRuntime } from '../runtime/collector-runtime.js';
import { FileThemePreference, isStoredTheme } from './theme-preference.js';

let mainWindow: BrowserWindow | null = null;
let runtime: CollectorRuntime | null = null;
let themePreference: FileThemePreference | null = null;
let isQuitting = false;

const explicitProfile = process.env.XR_COLLECTOR_PROFILE;
const hasExplicitProfile = Boolean(explicitProfile);
if (explicitProfile) app.setPath('userData', path.resolve(explicitProfile));

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

/**
 * Returns the closest existing directory at or above the given path. The
 * Windows folder dialog asks to create a missing default path as soon as it
 * opens, so the dialog starts in a folder that already exists.
 */
async function existingDirectory(start: string): Promise<string> {
  let current = start;
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch { /* keep walking up */ }
    const parent = path.dirname(current);
    if (parent === current) return app.getPath('documents');
    current = parent;
  }
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
  // The app has no menu commands of its own; macOS keeps the default menu for
  // standard Edit and Quit shortcuts.
  if (process.platform !== 'darwin') window.removeMenu();
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
  ipcMain.handle('xrCollector:theme:write', (_event, theme: unknown) => {
    if (!isStoredTheme(theme)) throw new Error('Unsupported theme preference');
    return themePreference!.write(theme).catch((error: unknown) => { console.warn('Unable to save theme preference', error); });
  });
  const suggestedVaultPath = path.join(app.getPath('documents'), 'XR Collector');
  ipcMain.handle('xrCollector:desktop:chooseDirectory', async (event, defaultPath: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: '選擇知識庫目錄',
      buttonLabel: '選擇',
      defaultPath: await existingDirectory(
        typeof defaultPath === 'string' && path.isAbsolute(defaultPath) ? defaultPath : app.getPath('documents'),
      ),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  const backupFilters: Electron.FileFilter[] = [{ name: 'XR Collector 備份', extensions: ['xr-vault'] }];
  ipcMain.handle('xrCollector:desktop:chooseBackupToSave', async (event, defaultPath: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const fallback = path.join(app.getPath('documents'), 'XR Collector 備份.xr-vault');
    const requested = typeof defaultPath === 'string' && path.isAbsolute(defaultPath) ? defaultPath : fallback;
    const options: Electron.SaveDialogOptions = {
      title: '匯出備份',
      buttonLabel: '匯出',
      defaultPath: path.join(await existingDirectory(path.dirname(requested)), path.basename(requested)),
      filters: backupFilters,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    // The dialog confirmed replacing the file it showed. A name given the extension here was not
    // confirmed, so the export dialog asks before replacing a file of that name.
    return /\.xr-vault$/iu.test(result.filePath)
      ? { path: result.filePath, overwrite: true }
      : { path: `${result.filePath}.xr-vault`, overwrite: false };
  });
  ipcMain.handle('xrCollector:desktop:chooseBackupToOpen', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: '選擇備份檔案',
      buttonLabel: '選擇',
      defaultPath: app.getPath('documents'),
      filters: backupFilters,
      properties: ['openFile'],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  // The folder comes from the runtime, never from the page, so the page can only reveal the active Vault.
  ipcMain.handle('xrCollector:desktop:revealVault', () => {
    const vaultPath = runtime?.workspace?.status().vaultPath;
    if (vaultPath) shell.showItemInFolder(vaultPath);
  });
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
      capture, channelSource,
      searchBinary: runtimePath('meilisearch'),
      searchData: path.join(app.getPath('userData'), 'search'),
    },
    ...(process.env.XR_COLLECTOR_VAULT ? { explicitVaultPath: path.resolve(process.env.XR_COLLECTOR_VAULT) } : {}),
    suggestedVaultPath,
    createdBy: `XR Collector ${app.getVersion()}`,
    connectionFile: agentConnectionFile({
      platform: process.platform,
      isPackaged: app.isPackaged,
      profilePath: app.getPath('userData'),
      appDataPath: app.getPath('appData'),
      ...(process.env.LOCALAPPDATA ? { localAppDataPath: process.env.LOCALAPPDATA } : {}),
      hasExplicitProfile,
    }),
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
