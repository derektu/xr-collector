#!/usr/bin/env node
// End-to-end check of a Desktop target, packaged (--app) or the checkout's development Electron:
// start at Onboarding and create the Vault there, collect one real YouTube video through the screens,
// relaunch with the same profile and find the document again, quit. The runtime programs (Meilisearch,
// yt-dlp, Deno) must run from the target's own bin folder: the packaged app's resources/bin (inside
// the .app on macOS, beside the .exe on Windows), the checkout's resources/bin for development.
// Afterwards no process of the run is left, its slot is free, and the user's App is untouched: the
// listeners on 7222 and 7175, the per-user Agent discovery file and the app's per-user folders (on
// macOS everything under ~/Library for the app's bundle id: preferences, caches, saved state, which
// the installed App shares; on Windows the app's folders under %APPDATA% and %LOCALAPPDATA%) are the
// same before and after, and the run neither configures an update feed nor changes the login item.
// While another instance of the same program runs (the installed App), it writes to those folders
// itself, so those comparisons are skipped and results.json says so in `userAppRunning`. Needs the
// network.
//
// One command, no interaction; exit code 0 only when every check passed. Run from the worktree whose
// skill is under test:
//   node .claude/skills/verify/scripts/smoke-desktop.mjs [--app <path>] [--evidence <dir>] [--issue <N>] [--label <name>] [--video <url>]
// --app picks a packaged app (a .app on macOS, release/win-unpacked/XR Collector.exe on Windows);
// without it the target is the development Electron on the checkout's build. --evidence writes
// results.json, screenshots and the app's log to that folder (missing or empty); otherwise they go to
// .local/ticket-artifacts/<issue>/<label>[-N]/, label defaulting to the target kind.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { recorder } from './lib/drive.mjs';
import { launchElectron, stubDialogs } from './lib/electron.mjs';
import { slotHolders } from './lib/instance.mjs';
import { checkoutRoot, isUnmarkedAppInstance, SLOTS } from './lib/paths.mjs';
import { inside, listeners, processTable, processTableAsync, programName, samePath, watchWindowsStarts, WINDOWS } from './lib/platform.mjs';
import { REAL } from './lib/synthetic.mjs';
import { desktopTarget, requireTarget, runtimeBin } from './lib/target.mjs';
import { waitFor } from './lib/wait.mjs';

const { values: o } = parseArgs({ options: {
  app: { type: 'string' }, evidence: { type: 'string' }, issue: { type: 'string', default: 'verify-smoke' }, label: { type: 'string' },
  video: { type: 'string', default: REAL.video },
} });
const USER_APP_PORTS = [7222, 7175];
const RUNTIME_PROGRAMS = ['meilisearch', 'yt-dlp', 'deno'];
// AppKit records this StoreKit timestamp in the bundle id's preferences at every launch of any app
// with that bundle id, the installed App included; it is the one key a run may change there.
const LAUNCH_TIMESTAMP_KEY = 'SKPurchaseIntentUpdatesLastChecked';
// Where an installed app (no XR_COLLECTOR_PROFILE) publishes its Agent connection for this user.
const PRODUCT = 'XR Collector';
const USER_DISCOVERY = WINDOWS
  ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), PRODUCT, 'agent-connection.json')
  : path.join(os.homedir(), 'Library', 'Application Support', PRODUCT, 'agent-connection.json');

/** A value from a macOS bundle's Info.plist. */
const plistValue = (bundle, key) => execFileSync('plutil', ['-extract', key, 'raw', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();

/**
 * Each entry under `folder` (or the file itself) with its size and modification time; null when
 * missing. Links are read as links: Chromium keeps Singleton* links whose targets may be gone.
 */
function fileState(folder) {
  if (!existsSync(folder)) return null;
  const describe = (stat) => (stat.isDirectory() ? 'dir' : `${stat.size} ${stat.mtimeMs}`);
  if (!lstatSync(folder).isDirectory()) return describe(lstatSync(folder));
  return Object.fromEntries(readdirSync(folder, { recursive: true }).map(String).sort()
    .map((file) => [file, describe(lstatSync(path.join(folder, file)))]));
}

/** The bundle id's preferences as XML, without the launch timestamp; null when there are none. */
function preferences(bundleId) {
  const file = path.join(os.homedir(), 'Library', 'Preferences', `${bundleId}.plist`);
  if (!existsSync(file)) return null;
  return execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], { encoding: 'utf8' })
    .replace(new RegExp(`<key>${LAUNCH_TIMESTAMP_KEY}</key>\\s*<[^>]+>[^<]*</[^>]+>`, 'u'), '');
}

/**
 * The user's App as this smoke could disturb it: who listens on its ports, its discovery file, and
 * the app's per-user folders. On macOS those are what macOS keeps under ~/Library for the bundle id
 * and the app's name; on Windows the folders named after the product, the package and Electron under
 * %APPDATA% and %LOCALAPPDATA%, where Electron puts an app's data when no profile is given.
 */
function userApp(bundle) {
  const discovery = existsSync(USER_DISCOVERY) ? { mtimeMs: statSync(USER_DISCOVERY).mtimeMs, content: readFileSync(USER_DISCOVERY, 'utf8') } : null;
  const state = { listeners: Object.fromEntries(USER_APP_PORTS.map((port) => [port, listeners(port)])), discovery };
  if (WINDOWS) {
    const library = {};
    for (const variable of ['APPDATA', 'LOCALAPPDATA']) {
      for (const name of [PRODUCT, 'xr-collector', 'Electron']) library[`%${variable}%\\${name}`] = fileState(path.join(process.env[variable] ?? '', name));
    }
    return { ...state, where: '使用者資料夾', library };
  }
  const bundleId = plistValue(bundle, 'CFBundleIdentifier');
  const inLibrary = (...parts) => path.join(os.homedir(), 'Library', ...parts);
  const library = {
    preferences: preferences(bundleId),
    caches: fileState(inLibrary('Caches', bundleId)),
    httpStorages: fileState(inLibrary('HTTPStorages', bundleId)),
    savedState: fileState(inLibrary('Saved Application State', `${bundleId}.savedState`)),
    applicationSupport: fileState(inLibrary('Application Support', plistValue(bundle, 'CFBundleName'))),
  };
  return { ...state, where: `~/Library 的 ${bundleId}`, library };
}

/**
 * Collects the full path of each runtime program the process tree under `root` starts. The tree is
 * sampled every 150 ms or as soon as the previous listing returns. yt-dlp lives only while it
 * captures, and one Windows listing takes seconds, so on Windows process start events also add to
 * the tree. A sample still running when stop() is called is dropped. Await `ready` before the
 * programs to watch can start.
 */
function watchRuntimePrograms(root) {
  const seen = new Set();
  const tree = new Set([root]);
  const consider = (row) => {
    if (!tree.has(row.ppid) && !tree.has(row.pid)) return false;
    tree.add(row.pid);
    if (row.executable && RUNTIME_PROGRAMS.includes(programName(row.executable))) seen.add(row.executable);
    return true;
  };
  const starts = WINDOWS ? watchWindowsStarts(consider) : null;
  let busy = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    processTableAsync().then((rows) => {
      busy = false;
      if (stopped) return;
      for (let grew = true; grew;) {
        grew = false;
        for (const row of rows) if (!tree.has(row.pid) && consider(row)) grew = true;
      }
      for (const row of rows) if (tree.has(row.pid)) consider(row);
    }, () => { busy = false; });
  }, 150);
  return {
    ready: starts?.ready ?? Promise.resolve(),
    stop() {
      if (!stopped) { stopped = true; clearInterval(timer); starts?.stop(); }
      return [...seen].sort();
    },
  };
}

/** Every process whose command line mentions the run folder, whichever program it is. */
const mentioning = (runDir) => processTable().filter((entry) => entry.command.includes(runDir)).map((entry) => `${entry.pid} ${entry.command}`);

/** Markdown files under the Vault whose text mentions `needle`, relative to the Vault. */
function vaultFilesMentioning(vault, needle) {
  return readdirSync(vault, { recursive: true }).map(String)
    .filter((file) => file.endsWith('.md') && readFileSync(path.join(vault, file), 'utf8').includes(needle));
}

const videoId = new URL(o.video).searchParams.get('v');
const checkout = checkoutRoot();
const planned = desktopTarget({ checkout, app: o.app });
requireTarget(planned);
// macOS: the bundle holding the executable, the packaged .app or Electron.app for development.
const bundle = WINDOWS ? null : planned.app ?? path.resolve(planned.executable, '..', '..', '..');
// The folder the packaged app ships in: the .app on macOS, the .exe's folder on Windows.
const appRoot = planned.kind === 'packaged' ? (WINDOWS ? path.dirname(planned.app) : planned.app) : null;
const ownBin = planned.kind === 'packaged' ? path.join(planned.resources, 'bin') : runtimeBin(checkout);
const bundleExecutable = WINDOWS ? path.basename(planned.executable) : plistValue(bundle, 'CFBundleExecutable');
/** Instances of the same program that verify did not start, such as the user's installed App. */
const otherInstances = () => processTable().filter((entry) => isUnmarkedAppInstance(entry.command, entry.executable, bundleExecutable))
  .map((entry) => `${entry.pid} ${entry.executable}`);
const othersBefore = otherInstances();
const before = userApp(bundle);
const desktop = await launchElectron({
  issue: o.issue, label: o.evidence ? o.label : (o.label ?? (o.app ? 'packaged' : 'development')), evidence: o.evidence, app: o.app, vault: 'none',
});
console.log(`${desktop.target.kind} ${desktop.target.executable} ${desktop.target.version}, run ${desktop.runDir}, evidence ${desktop.evidence}`);
const vault = path.join(desktop.runDir, 'vault');
// A relaunch opens a new window; the recorder screenshots whichever window is current.
const record = recorder(desktop, () => desktop.window);
const consoleErrors = [];
let userAppRunning = null;
let closed = false;
/** Why the app could not be closed through its own shutdown; null once it closed. */
let closeFailure = null;
const watchConsole = (window) => {
  window.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  window.on('pageerror', (error) => consoleErrors.push(String(error)));
};
/** JSON from the runtime the window talks to; its port is chosen at each start. */
const api = async (pathname) => (await fetch(new URL(pathname, desktop.window.url()))).json();
const documents = async () => (await api('/api/documents?limit=100')).documents;
/** What the main process reports about the login item and the update feed. */
const systemHooks = () => desktop.app.evaluate(({ app, autoUpdater }) => ({
  openAtLogin: app.getLoginItemSettings().openAtLogin, updateFeed: autoUpdater.getFeedURL(),
}));

/** Quits the app and releases the run, once, from whatever point the smoke reached. */
async function shutDown(options) {
  if (closed) return;
  closed = true;
  await desktop.close(options).catch((error) => {
    closeFailure = error.message;
    console.error(`close failed: ${error.message}`);
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { shutDown().finally(() => process.exit(1)); });

// From here on every exit goes through shutDown, so the slot and the run folder are released.
let runtimePrograms = null;
try {
  watchConsole(desktop.window);
  // Only the first launch runs the collection, so its main process is the root to watch.
  runtimePrograms = watchRuntimePrograms(desktop.app.process().pid);
  await runtimePrograms.ready;
  let hooksAtStart = null;

  await record.scenario('DESKTOP-01', '啟動：受測程式與隔離的 profile', async ({ expect, shot, note }) => {
    const main = await desktop.app.evaluate(({ app }) => ({
      packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), resources: process.resourcesPath,
    }));
    note('main', main);
    note('target', desktop.target);
    expect(main.packaged === (desktop.target.kind === 'packaged'), `app.isPackaged 為 ${main.packaged}，受測的是 ${desktop.target.kind}`);
    if (desktop.target.kind === 'packaged') {
      expect(samePath(main.appPath, path.join(planned.resources, 'app.asar')), `從 asar 載入：${main.appPath}`);
      expect(inside(main.resources, appRoot), `resources 在受測的 App 內：${main.resources}`);
    }
    expect(samePath(main.userData, desktop.profile), `profile 在 run 目錄：${main.userData}`);
    const slot = SLOTS.find((candidate) => candidate.slot === desktop.ports.slot);
    expect(slot?.agent === desktop.ports.agent, `Agent port ${desktop.ports.agent} 是 slot ${desktop.ports.slot}`);
    hooksAtStart = await systemHooks();
    note('systemHooks', hooksAtStart);
    expect(hooksAtStart.updateFeed === '', `沒有設定自動更新的來源：${JSON.stringify(hooksAtStart.updateFeed)}`);
    await desktop.window.locator('.onboarding-screen').waitFor();
    await shot('onboarding');
  });

  await record.scenario('DESKTOP-02', 'Onboarding：選擇目錄並建立知識庫', async ({ expect, shot, note }) => {
    const window = desktop.window;
    await stubDialogs(desktop.app, { open: vault });
    await window.getByRole('button', { name: '選擇目錄' }).click();
    const create = window.getByRole('button', { name: '建立知識庫' });
    await waitFor(() => create.isEnabled(), 'create enabled', { timeout: 15_000 });
    await shot('chosen');
    await create.click();
    await window.getByTestId('page-documents').or(window.getByTestId('page-sources')).first().waitFor({ timeout: 60_000 });
    const dialogs = await desktop.app.evaluate(() => globalThis.__dialogCalls);
    note('dialogs', dialogs);
    expect(dialogs.length === 1 && dialogs[0].kind === 'open', `原生選擇目錄對話框呼叫 ${dialogs.length} 次`);
    const status = await api('/api/vault/status');
    note('vaultPath', status.vaultPath);
    expect(samePath(status.vaultPath, vault), `知識庫在 run 目錄：${status.vaultPath}`);
    expect(existsSync(vault) && readdirSync(vault).length > 0, `知識庫目錄已建立：${existsSync(vault) ? readdirSync(vault).join('、') : '不存在'}`);
    await shot('vault-ready');
  });

  await record.scenario('DESKTOP-03', '經畫面收集一支真實影片', async ({ expect, shot, note }) => {
    const window = desktop.window;
    await window.getByTestId('nav-documents').click();
    await window.getByTestId('add-document').click();
    await window.getByTestId('add-item-url').click();
    await window.getByTestId('add-url').fill(o.video);
    const confirm = window.getByTestId('add-confirm');
    await waitFor(async () => (await confirm.innerText()).trim() === '加入' && await confirm.isEnabled(), 'add enabled', { timeout: 30_000 });
    await shot('add');
    await confirm.click();
    // The only job of this run is the collection, so a failed job ends the wait at once.
    const saved = await waitFor(async () => {
      const found = (await documents()).find((document) => document.sourceUrl?.includes(videoId));
      if (found) return found;
      const failed = (await api('/api/jobs?state=all&limit=20')).jobs.find((job) => job.state === 'failed');
      if (failed) throw Object.assign(new Error(`收集失敗：${JSON.stringify(failed.error)}`), { jobFailed: true });
      return null;
    }, 'video collected', { timeout: 240_000, interval: 2_000, fatal: (error) => error.jobFailed }).catch(async (error) => {
      note('jobs', await api('/api/jobs?state=all&limit=20'));
      throw new Error(`影片 ${videoId} 沒有收進文件：${error.message}`);
    });
    note('title', saved.title);
    await window.reload();
    await window.getByTestId('document-list').getByText(saved.title).first().click();
    await window.getByTestId('reader-body').waitFor();
    const length = (await window.getByTestId('reader-body').innerText()).length;
    expect(length > 200, `閱讀頁有字幕內文 ${length} 字：${saved.title}`);
    const files = vaultFilesMentioning(vault, videoId);
    note('vaultFiles', files);
    expect(files.length === 1, `知識庫有 ${files.length} 個提到影片的 Markdown 檔`);
    await shot('reader');
    const programs = runtimePrograms.stop();
    note('runtimePrograms', programs);
    for (const name of ['meilisearch', 'yt-dlp']) {
      const started = programs.filter((program) => programName(program) === name);
      expect(started.length > 0 && started.every((program) => inside(program, ownBin)), `${name} 從 ${ownBin} 啟動：${started.join('、') || '沒有看到'}`);
    }
    const elsewhere = programs.filter((program) => !inside(program, ownBin));
    expect(elsewhere.length === 0, `沒有從其他位置啟動的執行檔：${elsewhere.join('、') || '無'}`);
  });

  await record.scenario('DESKTOP-04', '重啟後文件仍在', async ({ expect, shot, note }) => {
    const title = (await documents()).find((document) => document.sourceUrl?.includes(videoId))?.title;
    expect(Boolean(title), title ? `重啟前有文件「${title}」` : '重啟前沒有收進的文件，無從比對');
    if (!title) return;
    await desktop.relaunch();
    watchConsole(desktop.window);
    const hooks = await systemHooks();
    note('systemHooksAfterRelaunch', hooks);
    expect(JSON.stringify(hooks) === JSON.stringify(hooksAtStart), `重啟後登入項目與更新來源不變：${JSON.stringify(hooks)}`);
    const after = await documents();
    note('documents', after.map((document) => document.title));
    expect(after.some((document) => document.title === title), `重啟後文件清單仍有「${title}」`);
    const status = await api('/api/vault/status');
    expect(samePath(status.vaultPath, vault), `重啟後開回同一個知識庫：${status.vaultPath}`);
    await desktop.window.getByTestId('nav-documents').click();
    await desktop.window.getByTestId('document-list').getByText(title).first().waitFor();
    expect(vaultFilesMentioning(vault, videoId).length === 1, '知識庫的 Markdown 檔仍在');
    await shot('after-relaunch');
  });

  await shutDown({ keep: true });
  await record.scenario('DESKTOP-05', '結束後沒有殘留，使用者的 App 不受影響', async ({ expect, note }) => {
    const left = mentioning(desktop.runDir);
    note('processesMentioningRun', left);
    expect(closeFailure === null, `App 經自己的結束流程關閉${closeFailure ? `：${closeFailure}` : ''}`);
    expect(left.length === 0, `命令列含有 run 目錄的程序 ${left.length} 個`);
    // Meilisearch's PID file beside its database, which the app removes when it stops Meilisearch.
    note('searchPidFiles', readdirSync(path.join(desktop.runDir, 'profile'), { recursive: true }).map(String).filter((file) => file.endsWith('.pid')));
    const holder = slotHolders().find((lock) => lock.slot === desktop.ports.slot);
    note('slotLock', holder ?? null);
    expect(holder?.runDir !== desktop.runDir, `slot ${desktop.ports.slot} 的 lock 不再指向這個 run`);
    const after = userApp(bundle);
    note('userApp', { before: before.listeners, after: after.listeners, discoveryChanged: JSON.stringify(after.discovery) !== JSON.stringify(before.discovery) });
    expect(JSON.stringify(after.listeners) === JSON.stringify(before.listeners), `7222／7175 的 listener 前後相同：${JSON.stringify(after.listeners)}`);
    expect(JSON.stringify(after.discovery) === JSON.stringify(before.discovery), `使用者的 Agent 連線檔前後相同（${USER_DISCOVERY}）`);
    const others = [...new Set([...othersBefore, ...otherInstances()])];
    userAppRunning = others.length > 0;
    note('otherInstances', others);
    if (userAppRunning) {
      const skipped = Object.keys(after.library);
      note('librarySkipped', skipped);
      console.log(`  ${bundleExecutable} 另有執行中的程式（${others.join('、')}），${before.where} ${skipped.join('、')} 會被它寫入，不比對`);
      return;
    }
    for (const [place, state] of Object.entries(after.library)) {
      note(`library.${place}`, state === null ? null : 'present');
      expect(JSON.stringify(state) === JSON.stringify(before.library[place]), `${before.where} ${place} 前後相同${place === 'preferences' ? `（${LAUNCH_TIMESTAMP_KEY} 除外）` : ''}`);
    }
  });
  await rm(desktop.runDir, { recursive: true, force: true });

  const passed = await record.finish({ consoleErrors, video: o.video, userAppRunning });
  console.log(`${passed ? 'PASS' : 'FAIL'} desktop smoke (${desktop.target.kind}), results in ${desktop.evidence}/results.json`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await record.finish({ consoleErrors, video: o.video, userAppRunning, error: String(error.stack ?? error) }).catch(() => undefined);
} finally {
  runtimePrograms?.stop();
  await shutDown();
}
