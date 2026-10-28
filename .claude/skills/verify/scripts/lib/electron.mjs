// Native Desktop runs through Playwright's Electron mode, for scenarios that need Electron or the
// platform: native dialogs, preload bridge, window behaviour, shell.openExternal, restarts with the
// same profile, and the packaged app itself. The app starts in background validation mode
// (XR_COLLECTOR_VALIDATION_HIDDEN=1): no window, no focus, no Dock icon, while Playwright drives and
// screenshots the page.
//
// The target is the checkout's development Electron on its build (npm run build), or with `app` a
// packaged app (the .app of npm run package:mac, the .exe npm run package:win leaves in
// release/win-unpacked/). Playwright starts either one the same way on both platforms, so a packaged
// run keeps the app's Electron fuses as shipped. On Windows this works over SSH as well, in session 0
// with no desktop: the window is never shown, and Playwright renders and screenshots the page. The Electron main process assembles the product's real
// plugins, so YouTube here is real yt-dlp; synthetic YouTube exists only in Web mode. Synthetic feeds
// work when a Web instance of the same flow serves them, or any local HTTP server does.
//
// Electron runs only inside the flow process that launched it: Playwright closes it when that
// process exits.
//
// Two Windows behaviours, seen in session 0, shape how a run screenshots and quits there:
// - Playwright's page screenshot of a window that is never shown times out on every other call, so
//   on Windows the window's screenshot comes from Electron's own webContents.capturePage(). A window
//   that is never shown draws no new frames, and capturePage then returns whatever it drew last, so
//   the run subscribes to the window's frames (beginFrameSubscription), which keeps it drawing.
// - When the app quits, Node keeps the process alive while the inspector Playwright attached is
//   still connected and prints "Debugger ending on …"; on Windows Playwright's close() never
//   disconnects it, so the app has finished its own shutdown but the process stays. That line is
//   the signal to end the process tree. Meilisearch of the run must be gone by then, which shows
//   that the app stopped it itself.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { checkoutRoot, claimEvidence, cleanEnv, commitOf, processStart, runMarker } from './paths.mjs';
import { LOADED } from './drive.mjs';
import { writeFailureResult } from './failure.mjs';
import { createRun, releaseSlot, terminateRun, writeJsonAtomic } from './instance.mjs';
import { endWindowsTree, processTable, programName, WINDOWS } from './platform.mjs';
import { desktopTarget, requireTarget } from './target.mjs';
import { sleep } from './wait.mjs';

/** Node's output once the app has quit and only an attached inspector keeps the process alive. */
const DEBUGGER_WAIT = /Debugger ending on|Waiting for the debugger to disconnect/u;
/** How long an app may take to quit through its own shutdown before the run reports it. */
const QUIT_TIMEOUT = 60_000;

/**
 * Replaces the page's screenshot with Electron's capturePage of the app's window (see the top of
 * this file). Each screenshot waits two animation frames, so the image shows the page as the flow
 * left it. It writes `path` when given and returns the PNG, as Playwright does; the image is the
 * window's content area, so clip and fullPage do not apply.
 */
async function captureThroughElectron(app, window) {
  await app.evaluate(({ BrowserWindow }) => {
    for (const each of BrowserWindow.getAllWindows()) each.webContents.beginFrameSubscription(() => undefined);
  });
  window.screenshot = async ({ path: file } = {}) => {
    await window.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      setTimeout(resolve, 1_000);
    }));
    const png = Buffer.from(await app.evaluate(async ({ BrowserWindow }) => {
      const [each] = BrowserWindow.getAllWindows();
      if (!each) throw new Error('the app has no window to capture');
      return (await each.webContents.capturePage()).toPNG().toString('base64');
    }), 'base64');
    if (file) await writeFile(file, png);
    return png;
  };
}

/**
 * Quits the app through Playwright's close(), which runs the app's own shutdown with its window
 * still open. On Windows, once the app reports that only the inspector keeps it alive, its process
 * tree is ended (see the top of this file). An app that neither quits nor reaches that point
 * within QUIT_TIMEOUT, or reaches it with the run's Meilisearch still running, is an error marked
 * `quitFailure`.
 */
async function quit({ app, child, debuggerWait }, runDir) {
  // An app that already quit on its own (the tray menu's 結束) has nothing left to close; Playwright
  // has released its handle by then, so the process is the one kept from the launch.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!WINDOWS) return app.close();
  const closing = app.close();
  const outcome = await Promise.race([
    closing.then(() => 'closed'), debuggerWait.then(() => 'debugger'), sleep(QUIT_TIMEOUT).then(() => 'timeout'),
  ]);
  if (outcome === 'timeout') throw Object.assign(new Error(`The app did not quit within ${QUIT_TIMEOUT / 1000} seconds`), { quitFailure: true });
  if (outcome === 'debugger') {
    const search = processTable().filter((entry) => programName(entry.executable ?? '') === 'meilisearch' && entry.command.includes(runDir));
    endWindowsTree(app.process().pid);
    await closing.catch(() => undefined);
    if (search.length) {
      throw Object.assign(new Error(`The app exited with Meilisearch still running (PID ${search.map((entry) => entry.pid).join(', ')})`), { quitFailure: true });
    }
  }
}

/** How a Desktop run's page and main process are reached; recorded in results.json as target.connection. */
const CONNECTION = 'playwright-electron';

/** Records only the current UI origin; credentials are exported from that UI when they are needed. */
export function recordElectronUiOrigin(record, window) {
  record.uiUrl = new URL(window.url()).origin;
  writeJsonAtomic(path.join(record.runDir, 'run.json'), record);
}

/**
 * Prepares an isolated profile and launches the Desktop app hidden. Options: issue (required), label,
 * evidence (an explicit evidence folder, missing or empty; see claimEvidence), app (a packaged app;
 * the development Electron otherwise), checkout, vault ('selected' creates a Vault and selects it in
 * the profile, so moving and opening another Vault stay available, and needs the checkout's
 * dist/node; 'none' starts at Onboarding), size, hidden. Returns { app, window, ...record, relaunch(),
 * close() }; record.target names the program under test. relaunch() quits and starts again with the
 * same profile; close({ keep }) quits, copies the app's output into the evidence folder, releases the
 * slot and removes the scratch folder unless `keep`.
 */
export async function launchElectron({
  issue, label, evidence: explicitEvidence, app: appPath, checkout = checkoutRoot(), vault = 'selected', size = '1280x900', hidden = true,
  prepareVault,
} = {}) {
  if (!issue) throw new Error('launchElectron needs an issue (number or label) for the evidence folder');
  if (!['selected', 'none'].includes(vault)) throw new Error(`vault must be selected or none, not ${vault}`);
  checkout = path.resolve(checkout);
  // A label already used gets the next free <label>-N folder; the record carries the one used.
  const claimed = claimEvidence(issue, label, { evidence: explicitEvidence });
  const evidence = claimed.evidence;
  label = claimed.label ?? undefined;
  const startupFailure = (error, target = { kind: appPath ? 'packaged' : 'development', app: appPath ? path.resolve(appPath) : null }) =>
    writeFailureResult({ evidence, error, phase: 'startup', record: {
      issue: String(issue), label, checkout, ...commitOf(checkout), data: prepareVault ? 'fixture' : 'real',
      layer: '原生 Desktop（Playwright _electron）', target,
    } });
  let target;
  try {
    target = desktopTarget({ checkout, app: appPath });
    requireTarget(target);
    if (vault === 'selected' && !existsSync(path.join(checkout, 'dist', 'node', 'vault', 'vault-selection.js'))) {
      throw new Error(`vault: 'selected' writes the Vault with ${checkout}/dist/node; run npm run build there, or use vault: 'none' and choose the Vault through Onboarding`);
    }
  } catch (error) {
    await startupFailure(error);
    throw error;
  }
  let run;
  try {
    run = await createRun(issue, checkout, { label, suffix: '-electron' });
  } catch (error) {
    await startupFailure(error, { kind: target.kind, app: target.app, executable: target.executable });
    throw error;
  }
  const { runDir, ports } = run;
  const profile = path.join(runDir, 'profile');
  const vaultPath = path.join(runDir, 'vault');
  const documents = path.join(runDir, 'documents');
  await mkdir(profile, { recursive: true });
  await mkdir(documents, { recursive: true });

  // The shell's own XR_COLLECTOR_* settings (a fixed Vault, ports) would break isolation.
  const env = {
    ...cleanEnv(),
    XR_COLLECTOR_PROFILE: profile,
    XR_COLLECTOR_AGENT_PORT: String(ports.agent),
    // Exports and backups keep the product's folder names, inside the run.
    XR_COLLECTOR_EXPORT_DIR: path.join(documents, 'XR Collector 匯出'),
    XR_COLLECTOR_BACKUP_DIR: path.join(documents, 'XR Collector 備份'),
    XR_COLLECTOR_VALIDATION_WINDOW_SIZE: size,
    XR_COLLECTOR_VALIDATION_CONTROL: '1',
    ...(hidden ? { XR_COLLECTOR_VALIDATION_HIDDEN: '1' } : {}),
  };
  // run.json names this flow process as the holder, so sweep and stop leave a live run alone. The
  // run marker on the app's command line lets them find an app the flow left behind.
  const record = {
    kind: 'electron', issue: String(issue), ...(label ? { label: String(label) } : {}), runDir, evidence, checkout, ...commitOf(checkout),
    profile, vault: vault === 'selected' ? vaultPath : null, documents, ports,
    pid: process.pid, start: processStart(process.pid), data: prepareVault ? 'fixture' : 'real', layer: '原生 Desktop（Playwright _electron）',
    target: { kind: target.kind, app: target.app, executable: target.executable, version: null, platform: process.platform, arch: null, connection: CONNECTION },
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(runDir, 'run.json'), record);
  const log = path.join(runDir, 'server.log');

  const start = async () => {
    const app = await electron.launch({
      executablePath: target.executable, args: [...target.args, runMarker(runDir)], cwd: target.cwd, env, timeout: 90_000,
    });
    // The runtime runs in the main process, so its output is the run's server log.
    const output = createWriteStream(log, { flags: 'a' });
    app.process().stdout?.pipe(output);
    app.process().stderr?.pipe(output);
    let tail = '';
    const debuggerWait = new Promise((resolve) => {
      const watch = (chunk) => {
        tail = (tail + chunk).slice(-400);
        if (DEBUGGER_WAIT.test(tail)) resolve();
      };
      app.process().stdout?.on('data', watch);
      app.process().stderr?.on('data', watch);
    });
    const window = await app.firstWindow({ timeout: 90_000 });
    if (WINDOWS) await captureThroughElectron(app, window);
    await window.locator(LOADED).first().waitFor({ timeout: 90_000 });
    return { app, child: app.process(), window, debuggerWait };
  };
  let current;
  try {
    if (vault === 'selected') {
      const load = (relative) => import(pathToFileURL(path.join(checkout, 'dist', 'node', relative)).href);
      const { createVaultDirectory } = await load('vault/vault-directory.js');
      const { VaultSelection } = await load('vault/vault-selection.js');
      await createVaultDirectory(vaultPath, 'XR Collector (verify skill, Electron)');
      await new VaultSelection(path.join(profile, 'vault-selection.json')).write(vaultPath);
      if (prepareVault) await prepareVault({ vault: vaultPath, profile });
    }
    current = await start();
    // The program reports its own version and architecture, the same way for both kinds of target.
    Object.assign(record.target, await current.app.evaluate(({ app }) => ({ version: app.getVersion(), arch: process.arch })));
    // The UI origin identifies this isolated profile without persisting an Agent key. Doctor asks
    // that UI for a fresh active connection, so a key reset or port change cannot leave a snapshot.
    recordElectronUiOrigin(record, current.window);
  } catch (error) {
    try { if (current) await quit(current, runDir); } catch { /* already closed */ }
    await terminateRun(runDir);
    if (existsSync(log)) await copyFile(log, path.join(evidence, 'server.log')).catch(() => undefined);
    releaseSlot(ports.slot, runDir);
    await writeFailureResult({ evidence, record, error, phase: 'startup' });
    throw error;
  }
  const handle = {
    ...record,
    get app() { return current.app; },
    get window() { return current.window; },
    /** The app's own UI origin, which serves the same API the page uses. */
    get url() { return new URL(current.window.url()).origin; },
    async api(pathname, init = {}) {
      const response = await fetch(`${handle.url}${pathname}`, {
        ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${pathname} answered ${response.status}: ${JSON.stringify(body)}`);
      return body;
    },
    /**
     * Starts the same program again with the same profile, as a person opening the app a second
     * time would; the single-instance lock makes it hand over to the running app and exit. Resolves
     * with its exit code.
     */
    async launchAgain() {
      const second = spawn(target.executable, [...target.args, runMarker(runDir)], { cwd: target.cwd, env, stdio: 'ignore' });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { second.kill(); reject(new Error('The second launch did not exit within 30 seconds')); }, 30_000);
        second.once('exit', (code) => { clearTimeout(timer); resolve(code); });
        second.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
    },
    /**
     * Resolves once the app has quit on its own. On Windows an app that finished its shutdown can
     * stay alive only for Playwright's inspector (see the top of this file); its process tree is
     * then ended, as quit() does.
     */
    async exited(timeout = QUIT_TIMEOUT) {
      const { child, debuggerWait } = current;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = new Promise((resolve) => child.once('exit', resolve));
      const outcome = await Promise.race([
        exit.then(() => 'exited'), debuggerWait.then(() => 'debugger'), sleep(timeout).then(() => 'timeout'),
      ]);
      if (outcome === 'timeout') throw new Error(`The app did not exit within ${timeout / 1000} seconds`);
      if (outcome === 'debugger') {
        if (WINDOWS) endWindowsTree(child.pid);
        await exit;
      }
    },
    /** Quits through the app's own shutdown path and starts again with the same profile. */
    async relaunch() {
      await quit(current, runDir); await terminateRun(runDir); current = await start();
      recordElectronUiOrigin(record, current.window);
      return current;
    },
    /**
     * Quits, ends whatever the app left running (a Meilisearch after an Electron crash), copies the
     * app's output into the evidence folder, releases the slot. An app that did not quit in time is
     * ended all the same, and close then throws, so the flow reports it.
     */
    async close({ keep = false } = {}) {
      let failure = null;
      try { await quit(current, runDir); } catch (error) { if (error.quitFailure) failure = error; }
      await terminateRun(runDir);
      if (existsSync(log)) await copyFile(log, path.join(evidence, `${path.basename(runDir)}-server.log`));
      releaseSlot(ports.slot, runDir);
      if (!keep) await rm(runDir, { recursive: true, force: true });
      if (failure) throw failure;
    },
  };
  return handle;
}

/**
 * Answers the native open/save dialogs in the main process with `answers.open` / `answers.save`
 * (paths inside the run folder) and records each call's options in globalThis.__dialogCalls.
 */
export async function stubDialogs(app, answers) {
  await app.evaluate(({ dialog }, { open, save }) => {
    globalThis.__dialogCalls = [];
    dialog.showOpenDialog = async (...args) => {
      globalThis.__dialogCalls.push({ kind: 'open', options: args.at(-1) });
      return open ? { canceled: false, filePaths: [open] } : { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => {
      globalThis.__dialogCalls.push({ kind: 'save', options: args.at(-1) });
      return save ? { canceled: false, filePath: save } : { canceled: true };
    };
  }, answers);
}

/** Replaces shell.openExternal with a recorder; returns a reader of the recorded URLs. */
export async function recordOpenExternal(app) {
  await app.evaluate(({ shell }) => {
    globalThis.__openedExternal = [];
    shell.openExternal = async (url) => { globalThis.__openedExternal.push(url); };
  });
  return () => app.evaluate(() => globalThis.__openedExternal);
}

// The app's validation control channel (XR_COLLECTOR_VALIDATION_CONTROL=1, set by launchElectron):
// the main process exposes the tray and the window on globalThis.__xrCollectorValidation.

/** The tray as last drawn after a fresh read: { icon, tooltip, items: [{ kind, label, action?, checked? }] }. */
export function trayMenu(app) {
  return app.evaluate(() => globalThis.__xrCollectorValidation.tray());
}

/** Runs a tray menu item by its action: open, check_now, toggle_auto_check, jobs, activity, quit. */
export function clickTray(app, action) {
  return app.evaluate((_electron, name) => { void globalThis.__xrCollectorValidation.click(name); }, action);
}

/** The main window: { exists, visible, focused, url }. */
export function windowState(app) {
  return app.evaluate(() => globalThis.__xrCollectorValidation.window());
}

/** Closes the main window as its close button does. */
export function closeWindow(app) {
  return app.evaluate(() => globalThis.__xrCollectorValidation.closeWindow());
}

/** The notifications the app has shown in this run: [{ title, content }]. */
export function notifications(app) {
  return app.evaluate(() => globalThis.__xrCollectorValidation.notifications());
}

/** Activates one delivered notification by its durable id, through the same routing as an OS click. */
export function activateNotification(app, id) {
  return app.evaluate((_electron, notificationId) => globalThis.__xrCollectorValidation.activateNotification(notificationId), id);
}
