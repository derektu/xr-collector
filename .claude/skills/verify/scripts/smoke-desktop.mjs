#!/usr/bin/env node
// End-to-end check of a Desktop target, packaged (--app) or the checkout's development Electron. The
// Vault is seeded with two fixture documents before launch, so the result never depends on the
// network: the target's own Meilisearch must index and search them through the API and the screens,
// and its own yt-dlp and Deno must run. With --video it also collects that real YouTube video through
// the screens. The app is relaunched with the same profile and finds its documents again, then quits.
// Afterwards no process mentions the run, its slot is free, and the user's App is untouched: the
// listeners on 7222 and 7175 and the app's default data folders are the same before and after. While
// the user's App runs (something listens on 7222) it writes to those folders itself, so they are not
// compared and results.json says so in `userAppRunning`.
//
// One command, no interaction; exit code 0 only when every check passed. Run from the worktree whose
// skill is under test:
//   node .claude/skills/verify/scripts/smoke-desktop.mjs [--app <path>] [--evidence <dir>] [--issue <N>] [--label <name>] [--video <url>]
// --app picks a packaged app (a .app on macOS, release/win-unpacked/XR Collector.exe on Windows);
// without it the target is the development Electron on the checkout's build. --evidence writes
// results.json, screenshots and the app's log to that folder (missing or empty); otherwise they go to
// a new folder .local/ticket-artifacts/<issue>/<label>-<local time>/, label defaulting to the target kind.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { recorder } from './lib/drive.mjs';
import { launchElectron } from './lib/electron.mjs';
import { checkoutRoot, SLOT_LOCKS } from './lib/paths.mjs';
import { exe, inside, listeners, processTable, programName, samePath, WINDOWS } from './lib/platform.mjs';
import { desktopTarget, runtimeBin } from './lib/target.mjs';
import { waitFor } from './lib/wait.mjs';

const { values: o } = parseArgs({ options: {
  app: { type: 'string' }, evidence: { type: 'string' }, issue: { type: 'string', default: 'verify-smoke' }, label: { type: 'string' },
  video: { type: 'string' },
} });
const USER_APP_PORTS = [7222, 7175];
const KEYWORD = '離線打包驗收關鍵詞';
const FIXTURES = [
  { id: 'ci119test01', title: 'CI 離線打包驗收文件', content: `${KEYWORD}。這份文件只存在於本次隔離 smoke。` },
  { id: 'ci119noise1', title: 'CI 對照文件', content: '這是另一份不符合搜尋條件的內容。' },
];

/** Each entry under `folder` with its size and modification time; null when missing. Links are read as links. */
function fileState(folder) {
  if (!existsSync(folder)) return null;
  const describe = (stat) => (stat.isDirectory() ? 'dir' : `${stat.size} ${stat.mtimeMs}`);
  return Object.fromEntries(readdirSync(folder, { recursive: true }).map(String).sort()
    .map((file) => [file, describe(lstatSync(path.join(folder, file)))]));
}

/**
 * Where Electron keeps the app's data when no profile is given: the packaged app's product name and
 * the development app's package name, under Application Support on macOS and %APPDATA% on Windows.
 */
function userData() {
  const root = WINDOWS ? process.env.APPDATA ?? '' : path.join(os.homedir(), 'Library', 'Application Support');
  return Object.fromEntries(['XR Collector', 'xr-collector'].map((name) => [path.join(root, name), fileState(path.join(root, name))]));
}

/** Writes the fixture documents into the Vault, as collected YouTube transcripts. */
async function seedVault({ vault }) {
  const folder = path.join(vault, 'documents', 'youtube');
  await mkdir(folder, { recursive: true });
  for (const fixture of FIXTURES) {
    const metadata = {
      type: 'Transcript', title: fixture.title, resource: `https://www.youtube.com/watch?v=${fixture.id}`, tags: [],
      collector: { id: `youtube:${fixture.id}`, source: 'youtube', source_id: fixture.id, publisher: 'CI fixture',
        collected_at: '2026-10-25T00:00:00.000Z', content_extent: 'full', subtitle: { language_code: 'zh-Hant', kind: 'manual' }, source_tags: [] },
    };
    await writeFile(path.join(folder, `${fixture.id}.md`), `---\n${stringify(metadata)}---\n\n${fixture.content}\n`);
  }
}

/** Markdown files under the Vault whose text mentions `needle`, relative to the Vault. */
function vaultFilesMentioning(vault, needle) {
  return readdirSync(vault, { recursive: true }).map(String)
    .filter((file) => file.endsWith('.md') && readFileSync(path.join(vault, file), 'utf8').includes(needle));
}

/** Every process whose command line mentions the run folder, whichever program it is. */
const mentioning = (runDir) => processTable().filter((entry) => entry.command.includes(runDir)).map((entry) => `${entry.pid} ${entry.command}`);

const checkout = checkoutRoot();
const planned = desktopTarget({ checkout, app: o.app });
const videoId = o.video ? new URL(o.video).searchParams.get('v') : null;
const userAppRunning = listeners(USER_APP_PORTS[0]).length > 0;
const before = { listeners: Object.fromEntries(USER_APP_PORTS.map((port) => [port, listeners(port)])), userData: userData() };
const desktop = await launchElectron({
  issue: o.issue, label: o.evidence ? o.label : (o.label ?? planned.kind), evidence: o.evidence, app: o.app, checkout, vault: 'selected', prepareVault: seedVault,
});
// launchElectron refuses a target that is not ready and writes the failed results.json; past it,
// the paths below exist.
// The folder the packaged app ships in: the .app on macOS, the .exe's folder on Windows.
const appRoot = planned.kind === 'packaged' ? (WINDOWS ? path.dirname(planned.app) : planned.app) : null;
const ownBin = planned.kind === 'packaged' ? path.join(planned.resources, 'bin') : runtimeBin(checkout);
console.log(`${desktop.target.kind} ${desktop.target.executable} ${desktop.target.version}, run ${desktop.runDir}, evidence ${desktop.evidence}`);
// A relaunch opens a new window; the recorder screenshots whichever window is current.
const record = recorder(desktop, () => desktop.window);
let closed = false;
/** Why the app could not be closed through its own shutdown; null once it closed. */
let closeFailure = null;
const documents = async () => (await desktop.api('/api/documents?limit=100')).documents;
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
try {
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
    const build = (await desktop.api('/api/device/build-info')).buildInfo;
    note('buildInfo', build);
    // A development build is current by its file times (electronBuildCurrent); the commit it
    // recorded stays that of the build when the sources are committed afterwards unchanged.
    const packaged = desktop.target.kind === 'packaged';
    expect(build.kind === desktop.target.kind && (!packaged || (build.commit === desktop.commit && build.sourceDirty === false))
      && desktop.target.arch === process.arch,
    `BuildInfo 對應受測 checkout 與架構：${JSON.stringify({ build, checkoutCommit: desktop.commit, appArch: desktop.target.arch })}`);
    hooksAtStart = await systemHooks();
    note('systemHooks', hooksAtStart);
    expect(hooksAtStart.updateFeed === '', `沒有設定自動更新的來源：${JSON.stringify(hooksAtStart.updateFeed)}`);
    await shot('started');
  });

  await record.scenario('DESKTOP-02', '受測程式自己的 runtime 搜尋隔離文件', async ({ expect, shot, note }) => {
    const programs = { ytdlp: path.join(ownBin, 'yt-dlp', exe('yt-dlp')), deno: path.join(ownBin, exe('deno')) };
    const versions = Object.fromEntries(Object.entries(programs).map(([name, file]) => [name,
      execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim()]));
    note('runtimeVersions', versions);
    expect(Boolean(versions.ytdlp) && Boolean(versions.deno), `${ownBin} 的 yt-dlp 與 Deno 可執行：${JSON.stringify(versions)}`);
    const search = await waitFor(async () => {
      const result = await desktop.api(`/api/search?q=${encodeURIComponent(KEYWORD)}`);
      return result.total === 1 ? result : null;
    }, 'Meilisearch indexed the fixture', { timeout: 60_000 });
    expect(search.hits[0]?.id === `youtube:${FIXTURES[0].id}`, `搜尋 API 找到隔離文件：${search.hits[0]?.id ?? '無'}`);
    const meilisearch = processTable().filter((entry) => programName(entry.executable) === 'meilisearch' && entry.command.includes(desktop.profile))
      .map((entry) => entry.executable);
    note('meilisearch', meilisearch);
    expect(meilisearch.length === 1 && inside(meilisearch[0], ownBin), `Meilisearch 從 ${ownBin} 啟動：${meilisearch.join('、') || '沒有看到'}`);

    const window = desktop.window;
    await window.getByTestId('nav-documents').click();
    const rows = window.locator('.document-row');
    await waitFor(async () => await rows.count() === FIXTURES.length || null, 'documents UI lists both fixtures before filtering');
    await window.getByTestId('documents-search').fill(KEYWORD);
    await window.getByTestId('documents-search').press('Enter');
    await waitFor(async () => (await rows.count() === 1 && (await rows.first().textContent())?.includes(FIXTURES[0].title)) || null,
      'documents UI filters to the matching fixture');
    expect(await rows.count() === 1 && Boolean((await rows.first().textContent())?.includes(FIXTURES[0].title)), '搜尋畫面只列出符合的隔離文件');
    await shot('search-result');
  });

  if (videoId) {
    await record.scenario('DESKTOP-03', '經畫面收集一支真實影片', async ({ expect, shot, note }) => {
      const window = desktop.window;
      await window.getByTestId('documents-search').fill('');
      await window.getByTestId('documents-search').press('Enter');
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
        const failed = (await desktop.api('/api/jobs?state=all&limit=20')).jobs.find((job) => job.state === 'failed');
        if (failed) throw Object.assign(new Error(`收集失敗：${JSON.stringify(failed.error)}`), { jobFailed: true });
        return null;
      }, 'video collected', { timeout: 240_000, interval: 2_000, fatal: (error) => error.jobFailed });
      note('title', saved.title);
      await window.reload();
      await window.getByTestId('document-list').getByText(saved.title).first().click();
      await window.getByTestId('reader-body').waitFor();
      const length = (await window.getByTestId('reader-body').innerText()).length;
      expect(length > 200, `閱讀頁有字幕內文 ${length} 字：${saved.title}`);
      const files = vaultFilesMentioning(desktop.vault, videoId);
      note('vaultFiles', files);
      expect(files.length === 1, `知識庫有 ${files.length} 個提到影片的 Markdown 檔`);
      await shot('reader');
    });
  }

  await record.scenario('DESKTOP-04', '重啟後文件仍在', async ({ expect, shot, note }) => {
    const titles = (await documents()).map((document) => document.title).sort();
    note('documentsBefore', titles);
    await desktop.relaunch();
    const hooks = await systemHooks();
    note('systemHooksAfterRelaunch', hooks);
    expect(JSON.stringify(hooks) === JSON.stringify(hooksAtStart), `重啟後登入項目與更新來源不變：${JSON.stringify(hooks)}`);
    const after = (await documents()).map((document) => document.title).sort();
    note('documentsAfter', after);
    expect(titles.length >= FIXTURES.length && JSON.stringify(after) === JSON.stringify(titles), `重啟後文件清單相同：${after.join('、')}`);
    const status = await desktop.api('/api/vault/status');
    expect(samePath(status.vaultPath, desktop.vault), `重啟後開回同一個知識庫：${status.vaultPath}`);
    await desktop.window.getByTestId('nav-documents').click();
    await desktop.window.getByTestId('document-list').getByText(FIXTURES[0].title).first().waitFor();
    await shot('after-relaunch');
  });

  await shutDown();
  await record.scenario('DESKTOP-05', '結束後沒有殘留，使用者的 App 不受影響', async ({ expect, note }) => {
    const left = mentioning(desktop.runDir);
    note('processesMentioningRun', left);
    expect(closeFailure === null, `App 經自己的結束流程關閉${closeFailure ? `：${closeFailure}` : ''}`);
    expect(left.length === 0, `命令列含有 run 目錄的程序 ${left.length} 個`);
    const lock = path.join(SLOT_LOCKS, `${desktop.ports.slot}.json`);
    const holder = existsSync(lock) ? readFileSync(lock, 'utf8') : null;
    note('slotLock', holder);
    expect(!holder?.includes(JSON.stringify(desktop.runDir)), `slot ${desktop.ports.slot} 的 lock 不再指向這個 run`);
    const listening = Object.fromEntries(USER_APP_PORTS.map((port) => [port, listeners(port)]));
    note('userAppListeners', { before: before.listeners, after: listening });
    expect(JSON.stringify(listening) === JSON.stringify(before.listeners), `7222／7175 的 listener 前後相同：${JSON.stringify(listening)}`);
    if (userAppRunning) {
      console.log(`  使用者的 App 在執行中（7222 有 listener），${Object.keys(before.userData).join('、')} 會被它寫入，不比對`);
      return;
    }
    for (const [folder, state] of Object.entries(userData())) {
      expect(JSON.stringify(state) === JSON.stringify(before.userData[folder]), `${folder} 前後相同`);
    }
  });

  const passed = await record.finish({ consoleErrors: desktop.consoleErrors, pageErrors: desktop.pageErrors, video: o.video ?? null, userAppRunning });
  console.log(`${passed ? 'PASS' : 'FAIL'} desktop smoke (${desktop.target.kind}), results in ${desktop.evidence}/results.json`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await record.finish({ consoleErrors: desktop.consoleErrors, pageErrors: desktop.pageErrors, video: o.video ?? null, userAppRunning, error: String(error.stack ?? error) }).catch(() => undefined);
} finally {
  await shutDown();
}
