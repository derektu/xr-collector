import { readFileSync } from 'node:fs';
import type { EventType } from '../core/event-catalog.js';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, Notification, powerMonitor, shell } from 'electron';
import { CollectionPause } from '../core/collection-pause.js';
import { internetProbe } from '../core/connectivity.js';
import type { BuildInfo } from '../core/update-types.js';
import { createSourcePlugins } from '../plugins/index.js';
import { DESKTOP_AGENT_PORT } from '../runtime/agent-connection-defaults.js';
import { loadBuildInfo } from '../updates/build-info.js';
import { bundledResources } from '../runtime/bundled-resources.js';
import { startCollectorServer, type CollectorServer } from '../server/collector-server.js';
import { backupFolder, exportFolder } from '../vault/transfer-files.js';
import { CloseHintRecord } from './close-hint.js';
import { FileThemePreference } from './theme-preference.js';
import { AppTray } from './tray.js';
import { DesktopLoginStartup, type LoginItemAdapter } from './login-startup.js';
import { UpdateService } from '../updates/update-service.js';
import { UnavailableInstaller } from '../updates/installer.js';
import { acknowledgeMacUpdateLaunch, acknowledgeMacUpdateShutdown, MacNativeInstaller, prepareMacUpdateRollback } from '../updates/mac-installer.js';
import { WindowsNativeInstaller } from '../updates/windows-installer.js';
import type { NativeInstaller, UpdateApplyRequest } from '../updates/types.js';
import { runUpdateCoordinator } from './update-coordinator.js';
import { recoverNativeInstallations } from './update-recovery.js';
import { startUpdateCheckScheduler } from './update-check-scheduler.js';
import { ElectronSystemNotifications } from './system-notifications.js';
import { claimLaunch } from './desktop-launch.js';
import { registerDesktopDialogs } from './desktop-dialogs.js';
import { updateSourceFor, windowsAppId, windowSize } from './desktop-environment.js';
import { MainWindow } from './main-window.js';
import { registerPageChannels } from './page-channels.js';
import { exposeValidationControl } from './validation-control.js';

let runtime: CollectorServer | null = null;
let tray: AppTray | null = null;
let closeHint: CloseHintRecord | null = null;
let updateService: UpdateService | null = null;
let updateCheckScheduler: ReturnType<typeof startUpdateCheckScheduler> | null = null;
let updateShutdownOwned = false;
let startupBuildInfo: BuildInfo | null = null;
let isQuitting = false;
const collectionPause = new CollectionPause();
let networkWatch: ReturnType<typeof setInterval> | null = null;
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
// Validation control channel, for native acceptance runs only (see validation-control.ts).
const validationControl = process.env.XR_COLLECTOR_VALIDATION_CONTROL === '1';
const validationNotifications: { id?: string; title: string; content: string }[] = [];

// Windows shows the app's notifications only for an app identity that matches the installer's Start
// menu shortcut (electron-builder's appId).
if (process.platform === 'win32') app.setAppUserModelId(windowsAppId(process.env, packageMetadata));

/** The files the App ships beside its code, from the package's resources or the checkout. */
const resources = bundledResources(app.isPackaged
  ? { packaged: true, resourcesPath: process.resourcesPath }
  : { packaged: false, checkout: app.getAppPath() });

const mainWindow = new MainWindow({
  platform: process.platform,
  hidden: validationHidden,
  size: windowSize(process.env),
  preload: path.join(app.getAppPath(), 'dist', 'node', 'electron', 'preload.cjs'),
  createWindow: (options) => new BrowserWindow(options),
  focusApp: () => app.focus({ steal: true }),
  openExternal: (url) => { void shell.openExternal(url); },
  runtime: () => runtime && {
    url: runtime.listeners.ui.url,
    resolveNotification: (id) => runtime ? runtime.resolveNotification(id) : Promise.resolve(null),
    activeVaultId: () => runtime?.workspace?.activeVaultId() ?? null,
  },
  quitting: () => isQuitting,
  sessionEnded: () => { isQuitting = true; },
  closedByPerson: () => { void hintStillRunning(); },
});

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

app.whenReady().then(async () => {
  const launch = claimLaunch({
    platform: process.platform,
    argv: process.argv,
    openedAtLogin: () => app.getLoginItemSettings({ type: 'mainAppService' }).wasOpenedAtLogin,
    requestSingleInstanceLock: (data) => app.requestSingleInstanceLock(data),
    onSecondInstance: (listener) => app.on('second-instance', (_event, commandLine, _workingDirectory, data) => listener(commandLine, data)),
    onActivate: (listener) => app.on('activate', listener),
    quit: () => app.quit(),
  }, () => mainWindow.show(), () => isQuitting);
  if (!launch) return;
  const { startedAtLogin } = launch;
  const loginItemAdapter: LoginItemAdapter = {
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    get: (options) => app.getLoginItemSettings(options),
    set: (options) => app.setLoginItemSettings(options),
  };
  const loginStartup = new DesktopLoginStartup(loginItemAdapter, path.join(app.getPath('userData'), 'login-startup.json'));
  registerPageChannels({
    ipc: ipcMain,
    theme: new FileThemePreference(path.join(app.getPath('userData'), 'appearance.json')),
    pageReady: (sender) => mainWindow.pageReady(sender),
  });
  // Exports go to this folder unless the person picks another place; the import dialog opens here too.
  const exports = exportFolder(app.getPath('documents'));
  registerDesktopDialogs({
    ipc: ipcMain,
    dialog,
    windowOf: (sender) => BrowserWindow.fromWebContents(sender),
    showItemInFolder: (file) => shell.showItemInFolder(file),
    documents: app.getPath('documents'),
    exports,
    vaultStatus: () => runtime?.workspace?.status(),
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
    program: resources.program,
  });
  const buildInfo = await loadBuildInfo({ packaged: app.isPackaged });
  startupBuildInfo = buildInfo;
  const updateRequest: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
  const updateSource = updateSourceFor(process.env, packageMetadata, updateRequest);
  // Platform adapters replace this unavailable boundary only when the installed package has a
  // verified native handoff path. Discovery remains useful in development without pretending it can install.
  const nativeInstaller: NativeInstaller = process.platform === 'darwin'
    ? new MacNativeInstaller({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, executablePath: process.execPath, current: buildInfo })
    : process.platform === 'win32' ? new WindowsNativeInstaller(app.isPackaged) : new UnavailableInstaller();
  const startupUpdateEvents: Array<{ severity: 'info' | 'warning' | 'error'; type: EventType; message: string; code?: string }> = [];
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
  runtime = await startCollectorServer({
    buildInfo,
    profilePath: app.getPath('userData'),
    sources: sources.registry,
    pause: collectionPause,
    // Electron's client follows the system's proxy settings, as the person's other apps do.
    connectivity: { probe: internetProbe((input, init) => net.fetch(input instanceof URL ? input.href : input, init)) },
    workspace: {
      plugins: sources.plugins, pacing: sources.pacing,
      searchBinary: resources.searchBinary,
      searchLexicon: resources.searchLexicon,
      searchData: path.join(app.getPath('userData'), 'search'),
      exportFolder: exports,
      backupFolder: backupFolder(app.getPath('documents')),
    },
    ...(process.env.XR_COLLECTOR_VAULT ? { explicitVaultPath: path.resolve(process.env.XR_COLLECTOR_VAULT) } : {}),
    newVaultLocation: app.getPath('documents'),
    createdBy: `XR Collector ${app.getVersion()}`,
    agentSettingsFile: path.join(app.getPath('userData'), 'agent-settings.json'),
    skillPath: resources.skill,
    agentPort: process.env.XR_COLLECTOR_AGENT_PORT ? Number.parseInt(process.env.XR_COLLECTOR_AGENT_PORT, 10) : DESKTOP_AGENT_PORT,
    uiPort: 0,
    webRoot: path.join(app.getAppPath(), 'dist', 'web'),
    loginStartup,
    startedAtLogin,
    updates: updateService,
    systemNotifications: new ElectronSystemNotifications((id) => mainWindow.show({ notificationId: id }),
      validationControl ? (notification) => validationNotifications.push(notification) : undefined),
  });
  for (const event of startupUpdateEvents) runtime.recordDeviceEvent(event.severity, event.type, event.message, event.code);
  mainWindow.runtimeStarted();
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
  await mainWindow.open(startedAtLogin);
  closeHint = new CloseHintRecord(path.join(app.getPath('userData'), 'tray.json'));
  tray = new AppTray({
    serverUrl: runtime.listeners.ui.url,
    changes: runtime.changes,
    iconFolder: resources.trayIcons,
    show: (page) => mainWindow.show(page),
    quit: () => app.quit(),
  });
  if (validationControl) {
    exposeValidationControl({
      tray, window: mainWindow,
      notifications: () => validationNotifications,
      update: () => updateService?.status() ?? null,
    });
  }
  launch.finish();
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
      const window = mainWindow.current;
      await (window ? dialog.showMessageBox(window, notice) : dialog.showMessageBox(notice)).catch(() => undefined);
      mainWindow.destroy();
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
  mainWindow.destroy();
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
