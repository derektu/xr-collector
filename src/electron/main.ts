import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Notification, powerMonitor, shell } from 'electron';
import { CollectionPause } from '../core/collection-pause.js';
import { createSourcePlugins } from '../plugins/index.js';
import { agentConnectionFile, DESKTOP_AGENT_PORT } from '../runtime/agent-discovery.js';
import { CollectorRuntime } from '../runtime/collector-runtime.js';
import { backupFolder, exportFileName, exportFolder } from '../vault/transfer-files.js';
import { CloseHintRecord } from './close-hint.js';
import { FileThemePreference, isStoredTheme } from './theme-preference.js';
import { AppTray } from './tray.js';
import type { TrayAction } from './tray-menu.js';

let mainWindow: BrowserWindow | null = null;
let runtime: CollectorRuntime | null = null;
let themePreference: FileThemePreference | null = null;
let tray: AppTray | null = null;
let closeHint: CloseHintRecord | null = null;
let isQuitting = false;
const collectionPause = new CollectionPause();

const explicitProfile = process.env.XR_COLLECTOR_PROFILE;
const hasExplicitProfile = Boolean(explicitProfile);
if (explicitProfile) app.setPath('userData', path.resolve(explicitProfile));

// Background validation mode, for native acceptance runs only: the window is never shown or
// focused and macOS shows no Dock icon, so a developer keeps working on the same machine while
// Playwright drives and screenshots the page. The Dock icon is hidden at program start so it
// never appears during launch.
const validationHidden = process.env.XR_COLLECTOR_VALIDATION_HIDDEN === '1';
if (validationHidden) app.dock?.hide();
// Validation control channel, for native acceptance runs only: Playwright reads and drives the tray
// and the window through globalThis.__xrCollectorValidation in this process.
const validationControl = process.env.XR_COLLECTOR_VALIDATION_CONTROL === '1';
const validationNotifications: { title: string; content: string }[] = [];

// Windows shows the app's notifications only for an app identity that matches the installer's Start
// menu shortcut (electron-builder's appId).
if (process.platform === 'win32') app.setAppUserModelId('com.moneydj.xrcollector');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

/** An external program's path, by its path under the runtime folder without extension; outside a package an environment variable may name it instead. */
function runtimePath(name: string, environmentName: string): string {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', executable);
  return process.env[environmentName]
    ?? path.join(app.getAppPath(), 'resources', 'bin', process.platform === 'win32' ? 'win' : 'mac', executable);
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
      // A hidden window keeps painting and running timers, so screenshots show the live page.
      backgroundThrottling: !validationHidden,
    },
  });
  // The app has no menu commands of its own; macOS keeps the default menu for
  // standard Edit and Quit shortcuts.
  if (process.platform !== 'darwin') window.removeMenu();
  if (!validationHidden) window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) event.preventDefault();
  });
  // Closing the window hides it and collection goes on; quitting is the tray menu's (or ⌘Q on macOS).
  window.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
    void hintStillRunning();
  });
  // Windows ending the session (shut down, sign out) closes the window without a quit request.
  window.on('session-end', () => { isQuitting = true; });
  window.on('closed', () => {
    mainWindow = null;
  });
  await window.loadURL(serverUrl);
  mainWindow = window;
}

/** Shows the window, on a page of the app when given; a hidden validation run only navigates. */
function showWindow(page?: 'jobs' | 'activity'): void {
  if (!mainWindow) {
    if (runtime && !isQuitting) void createWindow().then(() => showWindow(page)).catch((error) => console.error(error));
    return;
  }
  if (page) mainWindow.webContents.send('xrCollector:navigate', page);
  if (validationHidden) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  mainWindow.focus();
}

/**
 * The first time the window closes on Windows, says the app keeps running in the notification area;
 * a window closing there otherwise looks like the app quitting. macOS keeps the Dock icon, so it
 * needs no hint.
 */
async function hintStillRunning(): Promise<void> {
  if (process.platform !== 'win32' || !closeHint || await closeHint.shown()) return;
  const hint = { title: 'XR Collector 仍在系統匣執行', content: '收集會繼續。要結束，在系統匣圖示按右鍵選「結束」。' };
  new Notification({ title: hint.title, body: hint.content }).show();
  if (validationControl) validationNotifications.push(hint);
  await closeHint.markShown().catch((error: unknown) => console.warn('Unable to save the close hint record', error));
}

app.on('second-instance', () => {
  showWindow();
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
  // Exports go to this folder unless the person picks another place; the import dialog opens here too.
  const exports = exportFolder(app.getPath('documents'));
  const exportFilters: Electron.FileFilter[] = [{ name: 'XR Collector 匯出檔', extensions: ['zip'] }];
  ipcMain.handle('xrCollector:desktop:chooseExportFile', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    await mkdir(exports, { recursive: true });
    const options: Electron.SaveDialogOptions = {
      title: '匯出知識庫',
      buttonLabel: '匯出',
      defaultPath: path.join(exports, exportFileName(new Date())),
      filters: exportFilters,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    // The dialog confirmed replacing the file it showed. A name given the extension here was not
    // confirmed, so the export dialog asks before replacing a file of that name.
    return /\.zip$/iu.test(result.filePath)
      ? { path: result.filePath, overwrite: true }
      : { path: `${result.filePath}.zip`, overwrite: false };
  });
  ipcMain.handle('xrCollector:desktop:chooseImportFile', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    await mkdir(exports, { recursive: true });
    const options: Electron.OpenDialogOptions = {
      title: '選擇匯出檔',
      buttonLabel: '選擇',
      defaultPath: exports,
      filters: exportFilters,
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
  // Likewise the export file is the one the last finished export wrote, as the runtime reports it.
  ipcMain.handle('xrCollector:desktop:revealExport', () => {
    const status = runtime?.workspace?.status();
    const exportPath = status?.operation === 'export' && status.state === 'completed' ? status.result?.exportPath : undefined;
    if (exportPath) shell.showItemInFolder(exportPath);
  });
  // Collection pauses from suspend to resume. macOS sends neither event during the dark wakes of a
  // sleeping Mac (Power Nap, maintenance), so nothing is checked until the person wakes it. The
  // person unlocking or returning to the session also ends the pause, so a resume the system never
  // sends cannot hold collection back.
  powerMonitor.on('suspend', pauseForSleep);
  powerMonitor.on('resume', continueAfterSleep);
  powerMonitor.on('unlock-screen', continueAfterSleep);
  powerMonitor.on('user-did-become-active', continueAfterSleep);
  // One request channel per pacing group for every source request this process makes.
  const sources = await createSourcePlugins({
    profilePath: app.getPath('userData'),
    env: process.env,
    program: runtimePath,
  });
  runtime = await CollectorRuntime.start({
    profilePath: app.getPath('userData'),
    workspace: {
      plugins: sources.plugins, pacing: sources.pacing, pause: collectionPause,
      searchBinary: runtimePath('meilisearch', 'XR_COLLECTOR_MEILISEARCH'),
      searchData: path.join(app.getPath('userData'), 'search'),
      exportFolder: exports,
      backupFolder: backupFolder(app.getPath('documents')),
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
    agentPort: process.env.XR_COLLECTOR_AGENT_PORT ? Number.parseInt(process.env.XR_COLLECTOR_AGENT_PORT, 10) : DESKTOP_AGENT_PORT,
    uiPort: 0,
    webRoot: path.join(app.getAppPath(), 'dist', 'web'),
  });
  await createWindow();
  closeHint = new CloseHintRecord(path.join(app.getPath('userData'), 'tray.json'));
  tray = new AppTray({
    serverUrl: runtime.server.url,
    iconFolder: path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'tray'),
    show: showWindow,
    quit: () => app.quit(),
  });
  if (validationControl) exposeValidationControl(tray);

  app.on('activate', () => {
    if (!isQuitting) showWindow();
  });
}).catch((error) => {
  console.error(error);
  app.quit();
});

// Closing the window only hides it, so the window goes away only while quitting, and before-quit
// finishes that quit itself once the runtime has closed. Quitting again here, inside that quit,
// leaves the app hanging on Windows. The listener stays so Electron does not quit on its own.
app.on('window-all-closed', () => undefined);

function pauseForSleep(): void {
  collectionPause.set('sleep', true);
}

function continueAfterSleep(): void {
  collectionPause.set('sleep', false);
}

app.on('before-quit', (event) => {
  if (!runtime) return;
  event.preventDefault();
  isQuitting = true;
  powerMonitor.removeListener('suspend', pauseForSleep);
  powerMonitor.removeListener('resume', continueAfterSleep);
  powerMonitor.removeListener('unlock-screen', continueAfterSleep);
  powerMonitor.removeListener('user-did-become-active', continueAfterSleep);
  tray?.destroy();
  tray = null;
  mainWindow?.destroy();
  mainWindow = null;
  const activeRuntime = runtime;
  runtime = null;
  void activeRuntime.close()
    .finally(() => app.quit());
});

function exposeValidationControl(appTray: AppTray): void {
  (globalThis as { __xrCollectorValidation?: unknown }).__xrCollectorValidation = {
    tray: async () => { await appTray.refresh(); return appTray.current(); },
    click: (action: TrayAction) => appTray.run(action),
    window: () => ({
      exists: Boolean(mainWindow),
      visible: mainWindow?.isVisible() ?? false,
      focused: mainWindow?.isFocused() ?? false,
      url: mainWindow?.webContents.getURL() ?? null,
    }),
    closeWindow: () => mainWindow?.close(),
    notifications: () => [...validationNotifications],
  };
}
