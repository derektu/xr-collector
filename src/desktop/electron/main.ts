import { readFileSync } from 'node:fs';
import type { EventType } from '../../shared/activity/event-catalog.js';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, Notification, powerMonitor, shell } from 'electron';
import { CollectionPause } from '../../shared/jobs/collection-pause.js';
import { internetProbe } from '../../domain/jobs/index.js';
import type { BuildInfo } from '../../shared/api/update-types.js';
import { createSourcePlugins } from '../../app/plugins/index.js';
import { DESKTOP_AGENT_PORT, bundledResources } from '../../app/runtime/index.js';
import {
  loadBuildInfo,
  UpdateService,
  UnavailableInstaller,
  acknowledgeMacUpdateShutdown,
  MacNativeInstaller,
  rollBackFailedMacLaunch,
  WindowsNativeInstaller,
  type NativeInstaller,
  type UpdateApplyRequest,
} from '../../domain/updates/index.js';
import { startCollectorServer, type CollectorServer } from '../../transport/server/index.js';
import { backupFolder, exportFolder } from '../../domain/vault/index.js';
import { CloseHintRecord, hintStillRunning } from './close-hint.js';
import { FileThemePreference } from './theme-preference.js';
import { AppTray } from './tray.js';
import { DesktopLoginStartup, type LoginItemAdapter } from './login-startup.js';
import { runUpdateCoordinator } from './update-coordinator.js';
import { startUpdateCheckScheduler } from './update-check-scheduler.js';
import { ElectronSystemNotifications } from './system-notifications.js';
import { claimLaunch } from './desktop-launch.js';
import { registerDesktopDialogs } from './desktop-dialogs.js';
import { updateSourceFor, windowsAppId, windowSize } from './desktop-environment.js';
import { MainWindow } from './main-window.js';
import { registerPageChannels } from './page-channels.js';
import { exposeValidationControl } from './validation-control.js';
import { watchSleep } from './sleep-watch.js';
import { watchNetwork } from './network-watch.js';
import { beforeQuitAction, type ShutdownOwner } from './shutdown-owner.js';

let runtime: CollectorServer | null = null;
let tray: AppTray | null = null;
let closeHint: CloseHintRecord | null = null;
let updateService: UpdateService | null = null;
let updateCheckScheduler: ReturnType<typeof startUpdateCheckScheduler> | null = null;
let shutdownOwner: ShutdownOwner = 'none';
let startupBuildInfo: BuildInfo | null = null;
let isQuitting = false;
const collectionPause = new CollectionPause();
let stopNetworkWatch: (() => void) | null = null;
let stopSleepWatch: (() => void) | null = null;

const explicitProfile = process.env.XR_COLLECTOR_PROFILE;
if (explicitProfile) app.setPath('userData', path.resolve(explicitProfile));
const packageMetadata: unknown = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));

const validationHidden = process.env.XR_COLLECTOR_VALIDATION_HIDDEN === '1';
if (validationHidden) app.dock?.hide();
const validationControl = process.env.XR_COLLECTOR_VALIDATION_CONTROL === '1';
const validationNotifications: { id?: string; title: string; content: string }[] = [];

// Windows shows an app's notifications only when its Start menu shortcut carries the same AppUserModelID.
// https://www.electronjs.org/docs/latest/tutorial/notifications#windows
if (process.platform === 'win32') app.setAppUserModelId(windowsAppId(packageMetadata));

const resources = bundledResources(app.isPackaged
  ? { packaged: true, resourcesPath: process.resourcesPath }
  : { packaged: false, checkout: app.getAppPath() });

const mainWindow = new MainWindow({
  platform: process.platform,
  hidden: validationHidden,
  size: windowSize(process.env),
  preload: path.join(app.getAppPath(), 'dist', 'node', 'desktop', 'electron', 'preload.cjs'),
  createWindow: (options) => new BrowserWindow(options),
  focusApp: () => app.focus({ steal: true }),
  openExternal: (url) => { void shell.openExternal(url); },
  runtime: () => runtime && {
    url: runtime.listeners.ui.url,
    resolveNotification: (id) => runtime ? runtime.resolveNotification(id) : Promise.resolve(null),
    activeVaultId: () => runtime?.activeVaultId() ?? null,
  },
  quitting: () => isQuitting,
  sessionEnded: () => { isQuitting = true; },
  closedByPerson: () => {
    if (!closeHint) return;
    void hintStillRunning({
      platform: process.platform,
      record: closeHint,
      notify: (hint) => {
        new Notification({ title: hint.title, body: hint.content }).show();
        if (validationControl) validationNotifications.push(hint);
      },
    });
  },
});

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
    navigationReady: (sender) => mainWindow.navigationReady(sender),
  });
  const exports = exportFolder(app.getPath('documents'));
  registerDesktopDialogs({
    ipc: ipcMain,
    dialog,
    windowOf: (sender) => BrowserWindow.fromWebContents(sender),
    showItemInFolder: (file) => shell.showItemInFolder(file),
    documents: app.getPath('documents'),
    exports,
    vaultStatus: () => runtime?.transferStatus() ?? undefined,
  });
  // Electron's powerMonitor suspend and resume follow macOS's sleep and wake notifications, which
  // macOS does not post for dark wakes (Power Nap, maintenance wakes).
  stopSleepWatch = watchSleep(powerMonitor, { asleep: pauseForSleep, awake: continueAfterSleep });
  const sources = await createSourcePlugins({
    profilePath: app.getPath('userData'),
    env: process.env,
    program: resources.program,
  });
  const buildInfo = await loadBuildInfo({ packaged: app.isPackaged });
  startupBuildInfo = buildInfo;
  const updateRequest: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
  const updateSource = updateSourceFor(process.env, packageMetadata, updateRequest);
  const nativeInstaller: NativeInstaller = process.platform === 'darwin'
    ? new MacNativeInstaller({ packaged: app.isPackaged, helper: resources.macUpdateHelper, executablePath: process.execPath, current: buildInfo })
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
    // Electron's net module follows the system proxy configuration, including WPAD and PAC files.
    // https://www.electronjs.org/docs/latest/api/net
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
  // Electron's net.isOnline() returning true is inconclusive: a link can be up while remote sites stay unreachable.
  // https://www.electronjs.org/docs/latest/api/net#netisonline
  stopNetworkWatch = watchNetwork({ isOnline: () => net.isOnline(), check: () => { void runtime?.connectivity.check(); } });
  await mainWindow.open(startedAtLogin);
  closeHint = new CloseHintRecord(path.join(app.getPath('userData'), 'tray.json'));
  tray = new AppTray({
    serverUrl: runtime.listeners.ui.url,
    changes: runtime.changes,
    iconFolder: resources.trayIcons,
    show: (page) => mainWindow.show(page),
    quit: () => app.quit(),
    platform: process.platform,
  });
  if (validationControl) {
    exposeValidationControl({
      tray, window: mainWindow,
      notifications: () => validationNotifications,
      update: () => updateService?.status() ?? null,
    });
  }
  launch.startupFinished();
  await updateService.confirmLaunch((error) => console.error('Unable to confirm update launch', error));
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
  const rolledBack = safelyStopped && app.isPackaged && process.platform === 'darwin' && startupBuildInfo
    ? await rollBackFailedMacLaunch(resources.macUpdateHelper, startupBuildInfo, () => { isQuitting = true; app.exit(1); })
      .catch((rollbackError) => { console.error('Unable to roll back failed macOS startup', rollbackError); return false; })
    : false;
  if (!rolledBack) app.quit();
});

// Electron quits the app once every window has closed unless something listens for window-all-closed.
// https://www.electronjs.org/docs/latest/api/app#event-window-all-closed
app.on('window-all-closed', () => undefined);

function pauseForSleep(): void {
  collectionPause.set('sleep', true);
}

function continueAfterSleep(): void {
  collectionPause.set('sleep', false);
  void updateCheckScheduler?.wake().catch((error: unknown) => console.error('Unable to check for updates after wake', error));
}

async function coordinateUpdate(request: UpdateApplyRequest, installer: NativeInstaller): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime) return request.failed('update_apply_failed', 'Collector 服務尚未就緒。');
  await runUpdateCoordinator(request, installer, activeRuntime, {
    shutdownOwned: () => { shutdownOwner = 'update'; },
    completed: () => { updateCheckScheduler?.stop(); updateCheckScheduler = null; runtime = null; isQuitting = true; app.quit(); },
    terminalFailure: async (error) => {
      shutdownOwner = 'none'; runtime = null; isQuitting = true;
      stopNetworkWatch?.();
      updateCheckScheduler?.stop();
      stopNetworkWatch = null; updateCheckScheduler = null;
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

app.on('before-quit', (event) => {
  const action = beforeQuitAction(shutdownOwner, runtime);
  if (action.kind === 'quit') return;
  event.preventDefault();
  if (action.kind === 'wait-for-update') return;
  shutdownOwner = 'person';
  isQuitting = true;
  stopSleepWatch?.();
  stopSleepWatch = null;
  stopNetworkWatch?.();
  stopNetworkWatch = null;
  updateCheckScheduler?.stop();
  updateCheckScheduler = null;
  tray?.destroy();
  tray = null;
  mainWindow.destroy();
  const activeRuntime = action.runtime;
  runtime = null;
  void (async () => {
    try {
      await updateService?.close();
      await activeRuntime.close();
      if (app.isPackaged && process.platform === 'darwin' && startupBuildInfo) {
        await acknowledgeMacUpdateShutdown(startupBuildInfo);
      }
    } catch (error) {
      console.error('Unable to safely close before quitting', error);
    } finally {
      app.quit();
    }
  })();
});
