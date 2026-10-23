#!/usr/bin/env node
// End-to-end check of the verify skill itself, in Web mode with synthetic data: launch, subscribe,
// graceful restart, crash restart, stop --keep, sweep. Asserts that state survives both restarts and
// the interrupted job finishes, that server.log separates the server's runs, and that afterwards no
// process of the run is left and its slot is free. It also asserts it never touched the user's App:
// every port it used is a verify slot, the Vault is inside the run, and the listeners on 7222 and
// 7175 are the same before and after. Needs the Playwright Chromium. Run from the worktree whose
// skill is under test; evidence goes to its .local/ticket-artifacts/<issue>/smoke[-N]/:
//   node .claude/skills/verify/scripts/smoke.mjs [--issue <N>] [--checkout <dir>]
// --checkout picks the product version the instance runs (default: the worktree the command runs in).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openPage, recorder } from './lib/drive.mjs';
import { apiState } from './lib/state.mjs';
import { launchWeb, slotHolders, sweepStale } from './lib/instance.mjs';
import { checkoutRoot, SLOTS } from './lib/paths.mjs';
import { idle, subscribe } from './lib/seed.mjs';
import { defaultCatalog } from './lib/synthetic.mjs';
import { waitFor } from './lib/wait.mjs';

const { values: o } = parseArgs({ options: { issue: { type: 'string', default: 'verify-smoke' }, checkout: { type: 'string' } } });
const USER_APP_PORTS = [7222, 7175];

/** PIDs listening on a TCP port, sorted; empty when nothing listens. */
function listeners(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).sort();
  } catch {
    return [];
  }
}

/** Every process whose command line mentions the run folder, whichever program it is. */
const mentioning = (runDir) => execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  .split('\n').filter((line) => line.includes(runDir)).map((line) => line.trim());

const documents = async (instance) => (await instance.api('/api/documents?limit=100')).documents;

const userAppBefore = Object.fromEntries(USER_APP_PORTS.map((port) => [port, listeners(port)]));
const catalog = defaultCatalog();
// Slow captures keep channel A's five videos in progress across both restarts.
catalog.youtube.captureDelayMs = 2500;
const instance = await launchWeb({ issue: o.issue, label: 'smoke', checkout: o.checkout ?? checkoutRoot(), catalog });
console.log(`run ${instance.runDir} at ${instance.url}, evidence ${instance.evidence}`);
const channelA = catalog.youtube.channels.find((source) => source.handle === 'verify-a');
let browser = null;
let record = null;
let stopped = false;

/** Closes the browser and stops the instance, once, from whatever point the smoke reached. */
async function shutDown() {
  if (stopped) return;
  stopped = true;
  await browser?.close().catch(() => undefined);
  await instance.stop().catch((error) => console.error(`stop failed: ${error.message}`));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { shutDown().finally(() => process.exit(1)); });

try {
  browser = await openPage(instance, { route: '/documents' });
  const { page, consoleErrors } = browser;
  record = recorder(instance, page);
  await record.scenario('SMOKE-01', '隔離：slot port、run 內的 Vault', async ({ expect, note }) => {
    const ports = [instance.ports.ui, instance.ports.search, instance.ports.agent, instance.ports.feeds];
    const slot = SLOTS.find((candidate) => candidate.slot === instance.ports.slot);
    note('ports', ports);
    expect(slot && ports.join() === [slot.ui, slot.search, slot.agent, slot.feeds].join(), `port ${ports.join('、')} 是 slot ${instance.ports.slot}`);
    expect(ports.every((port) => port >= 7250 && port <= 7265), 'port 都在 7250–7265');
    const { vaultPath } = await instance.api('/api/vault/status');
    note('vaultPath', vaultPath);
    expect(vaultPath?.startsWith(`${instance.runDir}/`), `Vault ${vaultPath} 在 run 目錄內`);
  });

  await record.scenario('SMOKE-02', '正常重啟：訂閱與文件保留', async ({ expect, shot, note }) => {
    await subscribe(instance, 'https://www.youtube.com/@verify-a');
    const before = await waitFor(async () => { const list = await documents(instance); return list.length >= 1 && list; }, 'first document', { timeout: 60_000 });
    note('documentsBefore', before.length);
    await instance.restart({ page });
    const after = await documents(instance);
    note('documentsAfter', after.length);
    expect(after.length >= before.length, `重啟後文件 ${after.length} 份，重啟前 ${before.length} 份`);
    const subscriptions = JSON.stringify(await instance.api('/api/subscriptions'));
    expect(subscriptions.includes(channelA.id), `訂閱清單仍有頻道 A（${channelA.id}）`);
    expect(new URL(page.url()).pathname === '/documents', `頁面回到 ${new URL(page.url()).pathname}`);
    await page.getByTestId('page-documents').waitFor();
    await shot('after-graceful');
  });

  await record.scenario('SMOKE-03', '當機重啟：工作接續完成，lastStop 為 crash', async ({ expect, shot, note }) => {
    const { overview } = await instance.api('/api/jobs/overview');
    note('runningBeforeCrash', overview.running.length);
    expect(overview.running.length > 0, `當機前有 ${overview.running.length} 個進行中的工作`);
    await instance.restart({ crash: true, page });
    const finished = await idle(instance, 180_000);
    note('failed', finished.failed);
    const list = await documents(instance);
    note('documents', list.length);
    expect(list.length === channelA.videos.length, `文件 ${list.length} 份，頻道 A 有 ${channelA.videos.length} 支影片`);
    const { jobs } = await instance.api('/api/jobs?state=all&limit=100');
    const crashed = jobs.filter((job) => job.recovery?.lastStop === 'crash');
    note('jobs', jobs.map((job) => ({ id: job.id, kind: job.kind, state: job.state, recovery: job.recovery ?? null })));
    expect(crashed.length > 0, `${crashed.length} 個工作的 recovery.lastStop 為 crash`);
    expect(crashed.every((job) => job.state === 'completed'), `接續的工作都已完成：${crashed.map((job) => job.state).join('、')}`);
    await page.reload();
    await page.getByTestId('page-documents').waitFor();
    await shot('after-crash');
  });

  await record.scenario('SMOKE-04', 'server.log 有兩次重啟的分隔', async ({ expect, note }) => {
    const separators = readFileSync(path.join(instance.runDir, 'server.log'), 'utf8').split('\n').filter((line) => line.startsWith('--- verify restart'));
    note('separators', separators);
    expect(separators.length === 2, `${separators.length} 行分隔`);
    expect(separators[0]?.startsWith('--- verify restart (graceful)') && separators[1]?.startsWith('--- verify restart (crash)'), '依序為 graceful、crash');
  });

  const state = await apiState(instance);
  await browser.close();
  browser = null;
  await instance.stop({ keep: true });
  stopped = true;

  await record.scenario('SMOKE-05', 'stop 與 sweep 後沒有殘留', async ({ expect, note }) => {
    expect(existsSync(instance.runDir), 'stop --keep 保留 run 目錄');
    // Another session's sweep may remove the folder first, so the check is the folder, not sweep's list.
    const swept = sweepStale(instance.checkout);
    note('sweep', swept);
    expect(!existsSync(instance.runDir), 'sweep 之後 run 目錄不存在');
    const left = mentioning(instance.runDir);
    note('processesMentioningRun', left);
    expect(left.length === 0, `命令列含有 run 目錄的程序 ${left.length} 個`);
    const holder = slotHolders().find((lock) => lock.slot === instance.ports.slot);
    note('slotLock', holder ?? null);
    expect(holder?.runDir !== instance.runDir, `slot ${instance.ports.slot} 的 lock 不再指向這個 run`);
    const userAppAfter = Object.fromEntries(USER_APP_PORTS.map((port) => [port, listeners(port)]));
    note('userApp', { before: userAppBefore, after: userAppAfter });
    expect(JSON.stringify(userAppAfter) === JSON.stringify(userAppBefore), `7222／7175 的 listener 前後相同：${JSON.stringify(userAppAfter)}`);
  });

  const passed = await record.finish({ consoleErrors, state });
  console.log(`${passed ? 'PASS' : 'FAIL'} smoke, results in ${instance.evidence}/results.json`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await record?.finish({ consoleErrors: browser?.consoleErrors ?? [], error: String(error.stack ?? error) }).catch(() => undefined);
} finally {
  await shutDown();
}
