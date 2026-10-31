import { readFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, Notification, powerMonitor, shell } from 'electron';
import { CollectionPause } from '../core/collection-pause.js';
import { internetProbe } from '../core/connectivity.js';
import type { BuildInfo } from '../core/types.js';
import { createSourcePlugins } from '../plugins/index.js';
import { DESKTOP_AGENT_PORT } from '../runtime/agent-connection-defaults.js';
import { loadBuildInfo } from '../runtime/build-info.js';
import { CollectorRuntime } from '../runtime/collector-runtime.js';
import { backupFolder, exportFileName, exportFolder } from '../vault/transfer-files.js';
import { CloseHintRecord } from './close-hint.js';
import { FileThemePreference, isStoredTheme } from './theme-preference.js';
import { AppTray } from './tray.js';
import type { TrayAction } from './tray-menu.js';
import { DesktopLoginStartup, isLoginStartupLaunch, shouldShowForActivation, type LoginItemAdapter } from './login-startup.js';
import { WindowCreationGate } from './window-creation.js';
import { UpdateService } from '../updates/update-service.js';
import { GenericIndexSource, GitHubReleasesSource } from '../updates/sources.js';
import { UnavailableInstaller } from '../updates/installer.js';
import { acknowledgeMacUpdateLaunch, acknowledgeMacUpdateShutdown, MacNativeInstaller, prepareMacUpdateRollback } from '../updates/mac-installer.js';
import { WindowsNativeInstaller } from '../updates/windows-installer.js';
import type { NativeInstaller, UpdateApplyRequest } from '../updates/types.js';
import { runUpdateCoordinator } from './update-coordinator.js';
import { recoverNativeInstallations } from './update-recovery.js';
import { startUpdateCheckScheduler } from './update-check-scheduler.js';
import { appIdFromPackageMetadata, updateRepositoryFromPackageMetadata } from '../updates/config.js';
import { ElectronSystemNotifications } from './system-notifications.js';
import { notificationNavigation } from './notification-navigation.js';

let mainWindow: BrowserWindow | null = null;
let runtime: CollectorRuntime | null = null;
let themePreference: FileThemePreference | null = null;
let tray: AppTray | null = null;
let closeHint: CloseHintRecord | null = null;
let updateService: UpdateService | null = null;
let updateCheckScheduler: ReturnType<typeof startUpdateCheckScheduler> | null = null;
let updateShutdownOwned = false;
let startupBuildInfo: BuildInfo | null = null;
let isQuitting = false;
const collectionPause = new CollectionPause();
let networkWatch: ReturnType<typeof setInterval> | null = null;
let pendingManualShow = false;
type DesktopTarget = 'jobs' | 'activity' | 'settings' | 'update'
  | { kind: 'source'; type: string; id: string } | { kind: 'message'; message: string };
let pendingNavigation: DesktopTarget | undefined;
let pendingNotificationId: string | undefined;
let rendererReady = false;
const windowCreation = new WindowCreationGate();
let startupWindowState: { startedAtLogin: boolean; finished: boolean } | null = null;
/** How often the system's own view of the network is read; reading it sends nothing. */
const NETWORK_WATCH_MS = 5_000;

const explicitProfile = process.env.XR_COLLECTOR_PROFILE;
if (explicitProfile) app.setPath('userData', path.resolve(explicitProfile));
const packageMetadata = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as Record<string, unknown>;

// Background validation mode, for native acceptance runs only: the window is never shown or
// focused and macOS shows no Dock icon, so a developer keeps working on the same machine while
// Playwright drives and screenshots the page. The Dock icon is hidden at program start so it
// never appears during launch.
const validationHidden = process.env.XR_COLLECTOR_VALIDATION_HIDDEN === '1';
if (validationHidden) app.dock?.hide();
// Validation control channel, for native acceptance runs only: Playwright reads and drives the tray
// and the window through globalThis.__xrCollectorValidation in this process.
const validationControl = process.env.XR_COLLECTOR_VALIDATION_CONTROL === '1';
const validationNotifications: { id?: string; title: string; content: string }[] = [];

// Windows shows the app's notifications only for an app identity that matches the installer's Start
// menu shortcut (electron-builder's appId).
if (process.platform === 'win32') {
  const validationAppId = process.env.XR_COLLECTOR_VALIDATION_APP_ID;
  app.setAppUserModelId(validationAppId && /^com\.xrcollector\.verify[\w.-]+$/u.test(validationAppId)
    ? validationAppId : appIdFromPackageMetadata(packageMetadata));
}

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

function createWindow(showInitially = true): Promise<void> {
  return windowCreation.run(() => createWindowOnce(showInitially));
}

async function createWindowOnce(showInitially: boolean): Promise<void> {
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
  rendererReady = false;
  // Publish the window before loading so an early second-instance request cannot create another.
  mainWindow = window;
  // The app has no menu commands of its own; macOS keeps the default menu for
  // standard Edit and Quit shortcuts.
  if (process.platform !== 'darwin') window.removeMenu();
  if (!validationHidden && showInitially) window.once('ready-to-show', () => window.show());
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
    rendererReady = false;
  });
  try {
    await window.loadURL(serverUrl);
  } catch (error) {
    if (mainWindow === window) mainWindow = null;
    window.destroy();
    throw error;
  }
}

/** Shows the window, on a page of the app when given; a hidden validation run only navigates. */
function showWindow(page?: DesktopTarget | { notificationId: string }): void {
  pendingManualShow = true;
  if (typeof page === 'object' && 'notificationId' in page) {
    if (!runtime) { pendingNotificationId = page.notificationId; return; }
    const notificationId = page.notificationId;
    void runtime.resolveNotification(notificationId).then((event) => {
      pendingNavigation = notificationNavigation(event, runtime?.workspace?.activeVaultId() ?? null);
      showWindow();
    }).catch((error: unknown) => console.warn('Unable to resolve notification target', error));
    return;
  } else if (page) pendingNavigation = page;
  if (windowCreation.current) {
    // The caller that began creation performs the one pending show after loading completes.
    return;
  }
  if (!mainWindow) {
    if (runtime && !isQuitting) void createWindow(false).then(() => showWindow()).catch((error) => console.error(error));
    return;
  }
  deliverPendingNavigation();
  if (validationHidden) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  mainWindow.focus();
}

function deliverPendingNavigation(): void {
  if (!pendingNavigation || !rendererReady || !mainWindow) return;
  mainWindow.webContents.send('xrCollector:navigate', pendingNavigation);
  pendingNavigation = undefined;
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

app.on('activate', () => {
  const state = startupWindowState;
  if (state && shouldShowForActivation(state.startedAtLogin, state.finished) && !isQuitting) showWindow();
});

app.whenReady().then(async () => {
  // Electron only publishes macOS wasOpenedAtLogin while finishing launch, immediately before
  // ready. Each process then sends its own reason through the single-instance lock; a losing
  // process exits here and never creates a runtime.
  const startedAtLogin = isLoginStartupLaunch(process.platform, process.argv,
    process.platform === 'darwin' ? app.getLoginItemSettings({ type: 'mainAppService' }).wasOpenedAtLogin : false);
  const gotSingleInstanceLock = app.requestSingleInstanceLock({ xrCollectorStartedAtLogin: startedAtLogin });
  if (!gotSingleInstanceLock) {
    app.quit();
    return;
  }
  app.on('second-instance', (_event, commandLine, _workingDirectory, additionalData) => {
    const launchData = additionalData as { xrCollectorStartedAtLogin?: unknown };
    const secondStartedAtLogin = typeof launchData.xrCollectorStartedAtLogin === 'boolean'
      ? launchData.xrCollectorStartedAtLogin
      : isLoginStartupLaunch(process.platform, commandLine);
    if (!secondStartedAtLogin) showWindow();
  });
  startupWindowState = { startedAtLogin, finished: false };
  const loginItemAdapter: LoginItemAdapter = {
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    get: (options) => app.getLoginItemSettings(options),
    set: (options) => app.setLoginItemSettings(options),
  };
  const loginStartup = new DesktopLoginStartup(loginItemAdapter, path.join(app.getPath('userData'), 'login-startup.json'));
  themePreference = new FileThemePreference(path.join(app.getPath('userData'), 'appearance.json'));
  ipcMain.handle('xrCollector:theme:read', () => themePreference!.read());
  ipcMain.on('xrCollector:renderer:ready', (event) => {
    if (mainWindow?.webContents !== event.sender) return;
    rendererReady = true;
    deliverPendingNavigation();
  });
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
  const buildInfo = await loadBuildInfo({ packaged: app.isPackaged });
  startupBuildInfo = buildInfo;
  const updateRequest: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
  const updateRepository = updateRepositoryFromPackageMetadata(packageMetadata);
  const updateSource = process.env.XR_COLLECTOR_UPDATE_BASE_URL
    ? new GenericIndexSource(process.env.XR_COLLECTOR_UPDATE_BASE_URL, updateRequest)
    : new GitHubReleasesSource(updateRepository, updateRequest);
  // Platform adapters replace this unavailable boundary only when the installed package has a
  // verified native handoff path. Discovery remains useful in development without pretending it can install.
  const nativeInstaller: NativeInstaller = process.platform === 'darwin'
    ? new MacNativeInstaller({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, executablePath: process.execPath, current: buildInfo })
    : process.platform === 'win32' ? new WindowsNativeInstaller(app.isPackaged) : new UnavailableInstaller();
  const startupUpdateEvents: Array<{ severity: 'info' | 'warning' | 'error'; type: string; message: string; code?: string }> = [];
  updateService = await UpdateService.open({
    identity: { version: buildInfo.version, target: buildInfo.target },
    currentBuildId: buildInfo.buildId,
    source: updateSource, installer: nativeInstaller, directory: path.join(app.getPath('userData'), 'updates'), request: updateRequest,
    event: (severity, type, message, code) => {
      if (runtime) runtime.recordDeviceEvent(severity, type, message, code);
      else startupUpdateEvents.push({ severity, type, message, ...(code ? { code } : {}) });
    },
    apply: (request) => { void coordinateUpdate(request, nativeInstaller); },
  });
  runtime = await CollectorRuntime.start({
    buildInfo,
    profilePath: app.getPath('userData'),
    pause: collectionPause,
    // Electron's client follows the system's proxy settings, as the person's other apps do.
    connectivity: { probe: internetProbe((input, init) => net.fetch(input instanceof URL ? input.href : input, init)) },
    workspace: {
      plugins: sources.plugins, pacing: sources.pacing,
      searchBinary: runtimePath('meilisearch', 'XR_COLLECTOR_MEILISEARCH'),
      searchLexicon: path.resolve(process.env.XR_COLLECTOR_SEARCH_LEXICON
        ?? (app.isPackaged
          ? path.join(process.resourcesPath, 'search', 'coct-main.txt')
          : path.join(app.getAppPath(), 'resources', 'search', 'coct-main.txt'))),
      searchData: path.join(app.getPath('userData'), 'search'),
      exportFolder: exports,
      backupFolder: backupFolder(app.getPath('documents')),
    },
    ...(process.env.XR_COLLECTOR_VAULT ? { explicitVaultPath: path.resolve(process.env.XR_COLLECTOR_VAULT) } : {}),
    suggestedVaultPath,
    createdBy: `XR Collector ${app.getVersion()}`,
    agentSettingsFile: path.join(app.getPath('userData'), 'agent-settings.json'),
    skillPath: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'skills', 'xr-collector-agent'),
    agentPort: process.env.XR_COLLECTOR_AGENT_PORT ? Number.parseInt(process.env.XR_COLLECTOR_AGENT_PORT, 10) : DESKTOP_AGENT_PORT,
    uiPort: 0,
    webRoot: path.join(app.getAppPath(), 'dist', 'web'),
    loginStartup,
    startedAtLogin,
    updates: updateService,
    systemNotifications: new ElectronSystemNotifications((id) => showWindow({ notificationId: id }),
      validationControl ? (notification) => validationNotifications.push(notification) : undefined),
  });
  for (const event of startupUpdateEvents) runtime.recordDeviceEvent(event.severity, event.type, event.message, event.code);
  if (pendingNotificationId) {
    const id = pendingNotificationId;
    pendingNotificationId = undefined;
    showWindow({ notificationId: id });
  }
  if (!startedAtLogin) {
    try {
      const repair = await loginStartup.repairMovedRegistration();
      if (repair.repaired) runtime.recordDeviceEvent('info', 'device.login_startup_repaired', 'App 位置改變後，已把登入自啟更新到目前位置。');
    } catch (error) {
      runtime.recordDeviceEvent('error', 'device.login_startup_repair_failed', error instanceof Error ? error.message : '無法修復登入自啟。',
        'login_startup_failed');
    }
  }
  watchNetwork();
  const showInitially = !startedAtLogin || pendingManualShow;
  await createWindow(showInitially);
  // A tray request can arrive while the window is loading. Replay its latest page as
  // well as the show request after load; otherwise a device-level update click can land on the
  // default page (especially before a Vault exists).
  if (pendingNavigation || startedAtLogin && pendingManualShow && !showInitially) showWindow();
  closeHint = new CloseHintRecord(path.join(app.getPath('userData'), 'tray.json'));
  tray = new AppTray({
    serverUrl: runtime.server.url,
    iconFolder: path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'tray'),
    show: showWindow,
    quit: () => app.quit(),
  });
  if (validationControl) exposeValidationControl(tray);
  startupWindowState.finished = true;
  const lastAttempt = updateService.status().lastAttempt;
  const currentNeedsConfirmation = Boolean(lastAttempt && ['pending', 'unknown'].includes(lastAttempt.outcome)
    && lastAttempt.version === buildInfo.version && lastAttempt.buildId === buildInfo.buildId);
  let updateLaunchReady = true;
  if (process.platform === 'darwin') {
    const acknowledged = !currentNeedsConfirmation || await acknowledgeMacUpdateLaunch(buildInfo)
      .catch((error) => { console.error('Unable to acknowledge macOS update launch', error); return false; });
    const recovered = await recoverNativeInstallations(nativeInstaller, updateService,
      (error) => console.error('Unable to preserve or clean up macOS update result', error))
      .catch((error) => { console.error('Unable to recover macOS update launch', error); return false; });
    updateLaunchReady = !currentNeedsConfirmation || acknowledged && recovered;
  }
  if (updateLaunchReady) await updateService.confirmRunningBuild();
  if (nativeInstaller.available) {
    updateCheckScheduler = startUpdateCheckScheduler({
      check: () => updateService?.check() ?? Promise.resolve(),
      lastAttemptAt: () => updateService?.status().lastCheckAttemptAt ?? null,
      available: () => updateService?.status().installerAvailable === true,
    });
  }
}).catch(async (error) => {
  console.error(error);
  let safelyStopped = true;
  try {
    await updateService?.close();
    await runtime?.close();
    runtime = null;
  } catch (cleanupError) {
    safelyStopped = false;
    console.error('Unable to safely stop failed startup before update rollback', cleanupError);
  }
  const shutdownAcknowledged = safelyStopped && app.isPackaged && process.platform === 'darwin' && startupBuildInfo
    ? await acknowledgeMacUpdateShutdown(startupBuildInfo).catch((shutdownError) => {
      console.error('Unable to acknowledge safe macOS update shutdown', shutdownError); return false;
    })
    : false;
  if (safelyStopped && shutdownAcknowledged && app.isPackaged && process.platform === 'darwin' && startupBuildInfo
    && await prepareMacUpdateRollback(process.resourcesPath, startupBuildInfo).catch((rollbackError) => {
      console.error('Unable to prepare macOS startup rollback', rollbackError); return null;
    })) {
    isQuitting = true;
    app.exit(1);
    return;
  }
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
  void updateCheckScheduler?.wake().catch((error: unknown) => console.error('Unable to check for updates after wake', error));
}

/** Applies one user-confirmed ready package; the two-minute signal spans every Vault drain stage. */
async function coordinateUpdate(request: UpdateApplyRequest, installer: NativeInstaller): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime) return request.failed('update_apply_failed', 'Collector 服務尚未就緒。');
  await runUpdateCoordinator(request, installer, activeRuntime, {
    shutdownOwned: () => { updateShutdownOwned = true; },
    completed: () => { updateCheckScheduler?.stop(); updateCheckScheduler = null; runtime = null; isQuitting = true; app.quit(); },
    terminalFailure: async (error) => {
      // A transferred runtime can be partly closed and cannot safely resume collection. The
      // installer has been cancelled and the durable attempt is failed before this native notice.
      updateShutdownOwned = false; runtime = null; isQuitting = true;
      if (networkWatch) clearInterval(networkWatch);
      updateCheckScheduler?.stop();
      networkWatch = null; updateCheckScheduler = null;
      tray?.destroy(); tray = null;
      const notice: Electron.MessageBoxOptions = {
        type: 'error', title: 'App 更新未安裝', message: 'App 更新沒有安裝。',
        detail: `Collector 無法安全完成本次停止，將結束程式。請重新開啟 XR Collector 後再試。\n\n${error.message}`,
        buttons: ['結束 XR Collector'], defaultId: 0, noLink: true,
      };
      await (mainWindow ? dialog.showMessageBox(mainWindow, notice) : dialog.showMessageBox(notice)).catch(() => undefined);
      mainWindow?.destroy(); mainWindow = null;
      app.exit(1);
    },
  });
}

/**
 * The system's view of the network changing (Wi-Fi lost or joined) has the runtime confirm the
 * network at once. The system's view alone decides nothing: it still reports a connection on a
 * hotel network before sign-in or behind a router that lost its uplink.
 */
function watchNetwork(): void {
  let online = net.isOnline();
  networkWatch = setInterval(() => {
    const now = net.isOnline();
    if (now === online) return;
    online = now;
    void runtime?.connectivity.check();
  }, NETWORK_WATCH_MS);
}

app.on('before-quit', (event) => {
  if (!runtime) return;
  event.preventDefault();
  // Once the update lease transfers to shutdown, only its prepared native handoff may terminate
  // this process. A concurrent menu/OS quit must not win the race and skip installation.
  if (updateShutdownOwned) return;
  isQuitting = true;
  powerMonitor.removeListener('suspend', pauseForSleep);
  powerMonitor.removeListener('resume', continueAfterSleep);
  powerMonitor.removeListener('unlock-screen', continueAfterSleep);
  powerMonitor.removeListener('user-did-become-active', continueAfterSleep);
  if (networkWatch) clearInterval(networkWatch);
  updateCheckScheduler?.stop();
  updateCheckScheduler = null;
  networkWatch = null;
  tray?.destroy();
  tray = null;
  mainWindow?.destroy();
  mainWindow = null;
  const activeRuntime = runtime;
  runtime = null;
  void (async () => {
    try {
      await updateService?.close();
      await activeRuntime.close();
      if (app.isPackaged && process.platform === 'darwin' && startupBuildInfo) {
        await acknowledgeMacUpdateShutdown(startupBuildInfo);
      }
    } catch (error) {
      // Preserve the existing explicit-quit outcome, but without a receipt the helper refuses to
      // restore A. That prevents a partially closed B and relaunched A from sharing one profile.
      console.error('Unable to safely close before quitting', error);
    } finally {
      app.quit();
    }
  })();
});

function exposeValidationControl(appTray: AppTray): void {
  (globalThis as { __xrCollectorValidation?: unknown }).__xrCollectorValidation = {
    tray: async () => { await appTray.refresh(); return appTray.current(); },
    click: (action: TrayAction) => appTray.run(action),
    notifications: () => [...validationNotifications],
    activateNotification: (id: string) => showWindow({ notificationId: id }),
    window: () => ({
      exists: Boolean(mainWindow),
      visible: mainWindow?.isVisible() ?? false,
      focused: mainWindow?.isFocused() ?? false,
      url: mainWindow?.webContents.getURL() ?? null,
    }),
    closeWindow: () => mainWindow?.close(),
    update: () => updateService?.status() ?? null,
  };
}
