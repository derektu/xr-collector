import { readFileSync } from 'node:fs';
import type { EventType } from '../../shared/activity/event-catalog.js';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, Notification, powerMonitor, shell } from 'electron';
import { CollectionPause } from '../../shared/jobs/collection-pause.js';
import { internetProbe } from '../../domain/jobs/index.js';
import { createSourcePlugins } from '../../app/plugins/index.js';
import { DESKTOP_AGENT_PORT, bundledResources } from '../../app/runtime/index.js';
import { loadBuildInfo, UpdateService } from '../../domain/updates/index.js';
import { startCollectorServer, type CollectorServer } from '../../transport/server/index.js';
import { backupFolder, exportFolder } from '../../domain/vault/index.js';
import { CloseHintRecord, hintStillRunning } from './close-hint.js';
import { FileThemePreference } from './theme-preference.js';
import { AppTray } from './tray.js';
import { DesktopLoginStartup, type LoginItemAdapter } from './login-startup.js';
import { desktopUpdater, type DesktopUpdater } from './app-updater.js';
import { startUpdateCheckScheduler } from './update-check-scheduler.js';
import { ElectronSystemNotifications } from './system-notifications.js';
import { claimLaunch } from './desktop-launch.js';
import { registerDesktopDialogs } from './desktop-dialogs.js';
import { appIdOf, windowSize } from './desktop-environment.js';
import { MainWindow } from './main-window.js';
import { registerPageChannels } from './page-channels.js';
import { exposeValidationControl } from './validation-control.js';
import { watchSleep } from './sleep-watch.js';

let runtime: CollectorServer | null = null;
let tray: AppTray | null = null;
let closeHint: CloseHintRecord | null = null;
let updateService: UpdateService | null = null;
let updateCheckScheduler: ReturnType<typeof startUpdateCheckScheduler> | null = null;
let updater: DesktopUpdater | null = null;
let installAfterQuit = false;
let isQuitting = false;
const collectionPause = new CollectionPause();
let stopSleepWatch: (() => void) | null = null;

const explicitProfile = process.env.XR_COLLECTOR_PROFILE;
if (explicitProfile) app.setPath('userData', path.resolve(explicitProfile));
const appId = appIdOf(JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')));

const validationHidden = process.env.XR_COLLECTOR_VALIDATION_HIDDEN === '1';
if (validationHidden) app.dock?.hide();
const validationControl = process.env.XR_COLLECTOR_VALIDATION_CONTROL === '1';
const validationNotifications: { id?: string; title: string; content: string }[] = [];

// External: Windows shows an app's notifications only when its Start menu shortcut carries the same AppUserModelID.
// https://www.electronjs.org/docs/latest/tutorial/notifications#windows
if (process.platform === 'win32') app.setAppUserModelId(appId);

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
  const loginStartup = new DesktopLoginStartup(loginItemAdapter, appId);
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
  // External: Electron's powerMonitor suspend and resume follow macOS's sleep and wake notifications, which
  // macOS does not post for dark wakes (Power Nap, maintenance wakes).
  stopSleepWatch = watchSleep(powerMonitor, { asleep: pauseForSleep, awake: continueAfterSleep });
  const sources = await createSourcePlugins({
    profilePath: app.getPath('userData'),
    env: process.env,
    program: resources.program,
  });
  const buildInfo = await loadBuildInfo({ packaged: app.isPackaged });
  updater = desktopUpdater({
    packaged: app.isPackaged,
    platform: process.platform,
    feedUrl: process.env.XR_COLLECTOR_UPDATE_BASE_URL,
    installFailed: (error) => { void reopenAfterFailedInstall(error); },
  });
  const startupUpdateEvents: Array<{ severity: 'info' | 'warning' | 'error'; type: EventType; message: string; code?: string }> = [];
  updateService = await UpdateService.open({
    updater,
    currentVersion: app.getVersion(),
    target: buildInfo.target,
    directory: path.join(app.getPath('userData'), 'updates'),
    event: (severity, type, message, code) => {
      if (runtime) runtime.recordDeviceEvent(severity, type, message, code);
      else startupUpdateEvents.push({ severity, type, message, ...(code ? { code } : {}) });
    },
    restartToInstall: () => {
      installAfterQuit = true;
      app.quit();
    },
  });
  runtime = await startCollectorServer({
    buildInfo,
    profilePath: app.getPath('userData'),
    sources: sources.registry,
    pause: collectionPause,
    // External: Electron's net module follows the system proxy configuration, including WPAD and PAC files.
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
    systemNotifications: new ElectronSystemNotifications((notification) => mainWindow.show({ notification }),
      validationControl ? (notification) => validationNotifications.push(notification) : undefined),
  });
  for (const event of startupUpdateEvents) runtime.recordDeviceEvent(event.severity, event.type, event.message, event.code);
  mainWindow.runtimeStarted();
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
  if (updater.available) {
    updateCheckScheduler = startUpdateCheckScheduler({
      check: () => updateService?.check() ?? Promise.resolve(),
      lastAttemptAt: () => updateService?.status().lastCheckAttemptAt ?? null,
      available: () => updateService?.status().installerAvailable === true,
    });
  }
}).catch(async (error) => {
  console.error(error);
  try {
    await updateService?.close();
    await runtime?.close();
    runtime = null;
  } catch (cleanupError) {
    console.error('Unable to stop the failed startup', cleanupError);
  }
  app.quit();
});

// External: Electron quits the app once every window has closed unless something listens for window-all-closed.
// https://www.electronjs.org/docs/latest/api/app#event-window-all-closed
app.on('window-all-closed', () => undefined);

function pauseForSleep(): void {
  collectionPause.set('sleep', true);
}

function continueAfterSleep(): void {
  collectionPause.set('sleep', false);
  void updateCheckScheduler?.wake().catch((error: unknown) => console.error('Unable to check for updates after wake', error));
}

async function reopenAfterFailedInstall(error: unknown): Promise<void> {
  await updateService?.recordInstallFailure(error).catch((error: unknown) => console.error('Unable to record the failed update install', error));
  app.relaunch();
  app.exit(0);
}

app.on('before-quit', (event) => {
  const activeRuntime = runtime;
  if (!activeRuntime) return;
  event.preventDefault();
  isQuitting = true;
  stopSleepWatch?.();
  stopSleepWatch = null;
  updateCheckScheduler?.stop();
  updateCheckScheduler = null;
  tray?.destroy();
  tray = null;
  mainWindow.destroy();
  runtime = null;
  void (async () => {
    try {
      await updateService?.close();
      await activeRuntime.close();
    } catch (error) {
      console.error('Unable to safely close before quitting', error);
      if (installAfterQuit) {
        await reopenAfterFailedInstall(error);
        return;
      }
    }
    // External: The NSIS installer that quitAndInstall starts ends every process running from the install folder, forcibly after about two seconds.
    // https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh
    if (installAfterQuit && updater) updater.quitAndInstall();
    else app.quit();
  })();
});
