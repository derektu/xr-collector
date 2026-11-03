#!/usr/bin/env node
// Whether the Desktop app starts correctly: the checkout's development Electron, or with --app a
// packaged app. It needs no network and touches nothing outside its run: the Vault holds one fixture
// document before launch, and nothing is subscribed or collected. Checks, in order:
//   STARTUP-01 the app runs the program under test with the run's profile, and its own runtimes;
//   STARTUP-02 the main window loads with no console error and no uncaught page error;
//   STARTUP-03 health answers 200 and search is ready, on the Meilisearch of the program's own bin;
//   STARTUP-04 the Agent API answers 200 with the key and 401 without it, and the build information
//              names the commit under test;
//   STARTUP-05 search finds the fixture document;
//   STARTUP-06 the app quits through its own shutdown with its Meilisearch stopped, and leaves no
//              process mentioning the run.
//
// One command, no interaction, window hidden; exit code 0 only when every check passed. Run from the
// worktree whose skill and code are under test:
//   node .claude/skills/verify/scripts/startup.mjs [--app <path>] [--evidence <dir>] [--issue <N>] [--label <name>]
// --app is a .app on macOS or release/win-unpacked/XR Collector.exe on Windows; without it the
// development Electron runs the checkout's build (npm run build). --evidence writes results.json,
// screenshots and the app's log to that folder (missing or empty); otherwise they go to a new folder
// .local/ticket-artifacts/<issue>/<label>-<local time>/, issue defaulting to startup and label to the
// target kind.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { recorder } from './lib/drive.mjs';
import { launchElectron } from './lib/electron.mjs';
import { checkoutRoot } from './lib/paths.mjs';
import { exe, inside, processTable, programName, samePath } from './lib/platform.mjs';
import { desktopTarget, runtimeBin } from './lib/target.mjs';
import { waitFor } from './lib/wait.mjs';

const { values: o } = parseArgs({ options: {
  app: { type: 'string' }, evidence: { type: 'string' }, issue: { type: 'string', default: 'startup' }, label: { type: 'string' },
} });
const KEYWORD = '啟動檢查關鍵詞';
const FIXTURE = { id: 'startup0001', title: '啟動檢查文件', content: `${KEYWORD}。這份文件只存在於本次隔離的啟動檢查。` };

/** Writes the fixture document into the Vault, as a collected YouTube transcript. */
async function seedVault({ vault }) {
  const folder = path.join(vault, 'documents', 'youtube');
  await mkdir(folder, { recursive: true });
  const metadata = {
    type: 'Transcript', title: FIXTURE.title, resource: `https://www.youtube.com/watch?v=${FIXTURE.id}`, tags: [],
    collector: { id: `youtube:${FIXTURE.id}`, source: 'youtube', source_id: FIXTURE.id, publisher: 'startup fixture',
      collected_at: '2026-10-25T00:00:00.000Z', content_extent: 'full', subtitle: { language_code: 'zh-Hant', kind: 'manual' }, source_tags: [] },
  };
  await writeFile(path.join(folder, `${FIXTURE.id}.md`), `---\n${stringify(metadata)}---\n\n${FIXTURE.content}\n`);
}

const checkout = checkoutRoot();
const planned = desktopTarget({ checkout, app: o.app });
const packaged = planned.kind === 'packaged';
const desktop = await launchElectron({
  issue: o.issue, label: o.evidence ? o.label : (o.label ?? planned.kind), evidence: o.evidence, app: o.app, checkout, vault: 'selected', prepareVault: seedVault,
});
// launchElectron refuses a target that is not ready and writes the failed results.json; past it,
// the paths below exist. The packaged app ships its runtimes in its resources, the development app
// runs the checkout's resources/bin/<platform>.
const ownBin = packaged ? path.join(planned.resources, 'bin') : runtimeBin(checkout);
console.log(`${desktop.target.kind} ${desktop.target.executable} ${desktop.target.version}, run ${desktop.runDir}, evidence ${desktop.evidence}`);
const record = recorder(desktop, () => desktop.window);
let closed = false;
/** Why the app could not be closed through its own shutdown; null once it closed. */
let closeFailure = null;
/** The processes mentioning the run that were still running after the app quit. */
let leftovers = [];

/** Quits the app and releases the run, once, from whatever point the check reached. */
async function shutDown() {
  if (closed) return;
  closed = true;
  await desktop.close().then((closing) => { leftovers = closing.leftovers; }, (error) => {
    closeFailure = error.message;
    console.error(`close failed: ${error.message}`);
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { shutDown().finally(() => process.exit(1)); });

/** A request to the Agent API, with the key or without it; resolves with { status, body }. */
async function agent(connection, pathname, { key }) {
  const response = await fetch(`${connection.url}${pathname}`, key ? { headers: { authorization: `Bearer ${connection.token}` } } : {});
  return { status: response.status, body: await response.json().catch(() => null) };
}

// From here on every exit goes through shutDown, so the slot and the run folder are released.
try {
  await record.scenario('STARTUP-01', '啟動受測程式，profile 在 run 目錄，runtime 可執行', async ({ expect, note }) => {
    const main = await desktop.app.evaluate(({ app }) => ({
      packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), resources: process.resourcesPath,
    }));
    note('main', main);
    note('target', desktop.target);
    expect(main.packaged === packaged, `app.isPackaged 為 ${main.packaged}，受測的是 ${desktop.target.kind}`, { id: 'startup.kind', expected: packaged, actual: main.packaged });
    if (packaged) {
      expect(samePath(main.appPath, path.join(planned.resources, 'app.asar')), `從 asar 載入：${main.appPath}`, { id: 'startup.asar', actual: main.appPath });
      expect(samePath(main.resources, planned.resources), `resources 在受測的 App 內：${main.resources}`, { id: 'startup.resources', expected: planned.resources, actual: main.resources });
    }
    expect(samePath(main.userData, desktop.profile), `profile 在 run 目錄：${main.userData}`, { id: 'startup.profile', expected: desktop.profile, actual: main.userData });
    expect(desktop.target.arch === process.arch, `受測程式的架構 ${desktop.target.arch} 與 Node 相同`, { id: 'startup.arch', expected: process.arch, actual: desktop.target.arch });
    const programs = { ytdlp: path.join(ownBin, 'yt-dlp', exe('yt-dlp')), deno: path.join(ownBin, exe('deno')) };
    const versions = Object.fromEntries(Object.entries(programs).map(([name, file]) => [name,
      execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim()]));
    note('runtimeVersions', versions);
    expect(Boolean(versions.ytdlp) && Boolean(versions.deno), `${ownBin} 的 yt-dlp 與 Deno 可執行`, { id: 'startup.runtimes', actual: versions });
  });

  await record.scenario('STARTUP-02', '主視窗載入，沒有 console error 與未捕捉的例外', async ({ expect, shot }) => {
    const window = desktop.window;
    // The screen has read the server once it shows a revision; errors of the first load are in by then.
    await waitFor(() => window.evaluate(() => Boolean(document.documentElement.dataset.revision)), 'the main window read the server', { timeout: 60_000 });
    await window.getByTestId('nav-documents').click();
    await window.getByTestId('document-list').getByText(FIXTURE.title).first().waitFor({ timeout: 60_000 });
    expect(desktop.pageErrors.length === 0, `未捕捉的例外 ${desktop.pageErrors.length} 個`, { id: 'startup.page-errors', expected: [], actual: desktop.pageErrors });
    expect(desktop.consoleErrors.length === 0, `console error ${desktop.consoleErrors.length} 個`, { id: 'startup.console-errors', expected: [], actual: desktop.consoleErrors });
    await shot('loaded');
  });

  await record.scenario('STARTUP-03', 'health 回 200，搜尋 ready，Meilisearch 來自受測程式的 bin', async ({ expect, note }) => {
    const health = await fetch(`${desktop.url}/api/health`);
    expect(health.status === 200, `health 回 ${health.status}`, { id: 'startup.health', expected: 200, actual: health.status });
    const search = await waitFor(async () => {
      const { status } = await desktop.api('/api/search/status');
      return status?.state === 'ready' ? status : null;
    }, 'search is ready', { timeout: 60_000 }).catch(async () => (await desktop.api('/api/search/status')).status);
    expect(search?.state === 'ready', `搜尋狀態為 ${search?.state}`, { id: 'startup.search-ready', expected: 'ready', actual: search });
    const meilisearch = processTable().filter((entry) => programName(entry.executable) === 'meilisearch' && entry.command.includes(desktop.profile))
      .map((entry) => entry.executable);
    note('meilisearch', meilisearch);
    expect(meilisearch.length === 1 && inside(meilisearch[0], ownBin), `Meilisearch 從 ${ownBin} 啟動`, { id: 'startup.search-binary', expected: ownBin, actual: meilisearch });
  });

  await record.scenario('STARTUP-04', 'Agent 驗金鑰，build 資訊是受測版本', async ({ expect, note }) => {
    const connection = (await desktop.api('/api/device/agent/connection')).connection;
    note('agentUrl', connection.url);
    const withKey = await agent(connection, '/api/health', { key: true });
    const withoutKey = await agent(connection, '/api/health', { key: false });
    expect(withKey.status === 200, `Agent 帶金鑰回 ${withKey.status}`, { id: 'startup.agent-key', expected: 200, actual: withKey.status });
    expect(withoutKey.status === 401, `Agent 不帶金鑰回 ${withoutKey.status}`, { id: 'startup.agent-no-key', expected: 401, actual: withoutKey.status });
    const build = (await agent(connection, '/api/device/build-info', { key: true })).body?.buildInfo;
    note('buildInfo', build);
    // A packaged build is made only from a clean commit; a development build records whether the
    // checkout had uncommitted changes, which must match the checkout now.
    const expected = { kind: desktop.target.kind, commit: desktop.commit, sourceDirty: packaged ? false : desktop.dirty };
    const actual = { kind: build?.kind, commit: build?.commit, sourceDirty: build?.sourceDirty };
    expect(JSON.stringify(actual) === JSON.stringify(expected),
      `build 資訊對應受測版本${packaged ? '' : '（不同時先 npm run build）'}：${JSON.stringify(actual)}`, { id: 'startup.build-commit', expected, actual });
  });

  await record.scenario('STARTUP-05', '搜尋找到預放的文件', async ({ expect }) => {
    const search = await waitFor(async () => {
      const result = await desktop.api(`/api/search?q=${encodeURIComponent(KEYWORD)}`);
      return result.total >= 1 ? result : null;
    }, 'Meilisearch indexed the fixture', { timeout: 60_000 }).catch(() => desktop.api(`/api/search?q=${encodeURIComponent(KEYWORD)}`));
    const ids = search.hits.map((hit) => hit.id);
    expect(search.total === 1 && ids[0] === `youtube:${FIXTURE.id}`, `搜尋找到預放的文件：${ids.join('、') || '無'}`, { id: 'startup.search-hit', expected: [`youtube:${FIXTURE.id}`], actual: ids });
  });

  await shutDown();
  await record.scenario('STARTUP-06', '結束時 Meilisearch 已停止，沒有殘留程序', async ({ expect, note }) => {
    expect(closeFailure === null, `App 經自己的結束流程關閉，Meilisearch 已停止${closeFailure ? `：${closeFailure}` : ''}`, { id: 'startup.quit', expected: null, actual: closeFailure });
    expect(leftovers.length === 0, `App 結束後命令列含有 run 目錄的程序 ${leftovers.length} 個`, { id: 'startup.leftovers', expected: [], actual: leftovers });
  });

  const passed = await record.finish({ consoleErrors: desktop.consoleErrors, pageErrors: desktop.pageErrors });
  console.log(`${passed ? 'PASS' : 'FAIL'} startup (${desktop.target.kind}), results in ${desktop.evidence}/results.json`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await shutDown();
  await record.finish({ consoleErrors: desktop.consoleErrors, pageErrors: desktop.pageErrors, error: String(error.stack ?? error),
    ...(closeFailure ? { cleanupError: closeFailure } : {}) }).catch(() => undefined);
} finally {
  await shutDown();
}
