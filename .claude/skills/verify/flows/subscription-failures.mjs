// Channel A's listing failing check after check: the row stays red with the failures in a row, the
// detail page's 上次檢查 matches the newest check in the collection record, a failed check stays
// out of the Jobs page's failed section, the fifth failure a day after the first pauses A by itself,
// and 恢復 clears the failures and checks at once. The flow writes the earlier failures into the
// Vault file instead of failing four checks over a day; each failing check still takes its three
// attempts (about 2.5 minutes).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { idle, subscribe } from '../scripts/lib/index.mjs';
import { watch, watched } from './lib/watch.mjs';

export const name = 'subscription-failures';
export const title = '訂閱連續失敗與自動暫停';
export const covers = ['sub-status', 'sub-failure'];

/** Every subscription row's status text and color, by row test ID; runs inside the page. */
const subscriptionStatuses = () => Object.fromEntries([...document.querySelectorAll('[data-testid^="source-row-"]')]
  .map((row) => {
    const chip = row.querySelector('.status-chip');
    return [row.dataset.testid, `${(chip?.textContent ?? '').trim()}|${chip?.className ?? ''}`];
  }));

const DAY = 24 * 60 * 60_000;
const CHECK_TIMEOUT = 5 * 60_000;

export async function run({ instance, page, openPage, record, waitFor }) {
  const catalog = await instance.catalog();
  const a = catalog.youtube.channels.find((source) => source.handle === 'verify-a');
  const row = page.getByTestId(`source-row-${a.id}`);
  const channelsFile = path.join(instance.runDir, 'vault', 'settings', 'youtube-channels.json');
  const subscription = async () => (await instance.api('/api/subscriptions')).subscriptions.find((entry) => entry.id === a.id);
  const detail = async () => instance.api(`/api/subscriptions/youtube/${encodeURIComponent(a.id)}`);
  const storedA = async () => JSON.parse(await readFile(channelsFile, 'utf8')).channels.find((entry) => entry.id === a.id);
  const chip = async () => {
    const element = row.getByTestId('subscription-status');
    return { text: (await element.innerText()).trim(), error: (await element.getAttribute('class')).split(' ').includes('error') };
  };
  const checksSince = async (since) => (await instance.api('/api/jobs?state=all&limit=100')).jobs
    .filter((job) => job.kind === 'youtube.channel' && job.source.id === a.id && job.createdAt >= since);

  /** 立即檢查 from A's row menu; resolves with the check job once it settled. */
  const checkFromRow = async () => {
    const since = new Date().toISOString();
    await waitFor(async () => (await page.getByTestId('notice').count()) === 0, 'no toast over the page', { timeout: 15_000 });
    await page.getByRole('button', { name: `${a.title} 的更多動作` }).click();
    await page.getByRole('menuitem', { name: '立即檢查' }).click();
    return waitFor(async () => {
      const [job] = await checksSince(since);
      return job && (job.state === 'completed' || job.state === 'failed') ? job : null;
    }, 'A check settled', { timeout: CHECK_TIMEOUT });
  };

  /** The detail page's problem banner, 上次檢查 and newest check in the collection record. */
  const detailPage = async () => {
    const detailView = await openPage(`/sources/youtube/${encodeURIComponent(a.id)}`);
    await detailView.getByTestId('source-detail').waitFor();
    const problem = detailView.getByTestId('detail-problem');
    const lastChecked = (await detailView.locator('.stats div', { hasText: '上次檢查' }).locator('dd').innerText()).trim();
    const newestCheck = detailView.getByTestId('collection-check').first();
    const newestCheckAt = (await newestCheck.count()) ? (await newestCheck.locator('.collection-when').innerText()).trim() : null;
    return {
      view: detailView,
      problem: (await problem.count()) ? (await problem.innerText()).trim() : null,
      lastChecked, newestCheckAt,
    };
  };

  await record.scenario('FAIL-1', '準備：訂閱 A 完成，之後列出 A 的影片會失敗', async ({ expect }) => {
    await subscribe(instance, `https://www.youtube.com/@${a.handle}`);
    await idle(instance);
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('page-sources').waitFor();
    await watch(page, 'status', subscriptionStatuses);
    // Jobs can read idle between the add job and the first check it starts; the row settles once that check ends.
    const start = await waitFor(async () => {
      const value = await chip();
      return /^下次 /u.test(value.text) ? value : null;
    }, 'A row scheduled', { timeout: 120_000 }).catch(chip);
    expect(/^下次 /u.test(start.text), 'A 一開始為「下次 HH:MM」', { id: 'start.scheduled', expected: '下次 HH:MM', actual: start.text });
    await instance.updateCatalog((current) => { current.youtube.failListing = a.id; });
  });

  await record.scenario('FAIL-2', '列出失敗一次：列維持紅色並顯示連續次數，上次檢查與收集紀錄一致，工作頁失敗區沒有它', async ({ expect, shot, note }) => {
    const failed = await checkFromRow();
    expect(failed.state === 'failed', 'A 的檢查失敗', { id: 'w1.job-failed', expected: 'failed', actual: failed.state });

    const shown = await waitFor(async () => {
      const value = await chip();
      return /^錯誤（連續 1 次）・\d{2}:\d{2} 重試$/u.test(value.text) ? value : null;
    }, 'A row failing', { timeout: 15_000 }).catch(chip);
    expect(/^錯誤（連續 1 次）・\d{2}:\d{2} 重試$/u.test(shown.text) && shown.error, '列為紅色「錯誤（連續 1 次）・HH:MM 重試」',
      { id: 'w1.row', expected: '錯誤（連續 1 次）・HH:MM 重試（紅色）', actual: shown });
    const samples = ((await watched(page, 'status'))[`source-row-${a.id}`] ?? []).map((sample) => sample.value.split('|')[0]);
    note('rowSequence', samples);
    const afterRetrying = samples.slice(samples.findIndex((value) => value.startsWith('錯誤・')));
    expect(samples.some((value) => /^錯誤・\d{2}:\d{2} 重試$/u.test(value)) && !afterRetrying.some((value) => value.startsWith('下次')),
      '重試期間顯示「錯誤・HH:MM 重試」，之後沒有回到「下次」', { id: 'w1.row-sequence', expected: '錯誤・HH:MM 重試 → 錯誤（連續 1 次）', actual: samples });

    const api = await subscription();
    expect(api.checkFailures?.count === 1 && api.checkFailures.since === failed.finishedAt && api.status === 'error',
      'API 的 checkFailures 為 1 次，從這次失敗起算', { id: 'w1.api-failures', expected: { count: 1, since: failed.finishedAt }, actual: api.checkFailures ?? null });
    expect(api.lastCheckedAt === failed.finishedAt, '上次檢查是失敗那次檢查結束的時間', { id: 'w1.last-checked', expected: failed.finishedAt, actual: api.lastCheckedAt });
    const newest = (await detail()).collection.find((entry) => entry.kind === 'check');
    expect(newest?.at === api.lastCheckedAt, '收集紀錄最新一筆檢查與上次檢查同一個時間', { id: 'w1.record-matches', expected: api.lastCheckedAt, actual: newest?.at ?? null });

    const view = await detailPage();
    expect(view.problem?.startsWith('最近一次檢查失敗（連續 1 次）：') ?? false, '詳情頁紅條顯示連續次數與原因',
      { id: 'w1.detail-problem', expected: '最近一次檢查失敗（連續 1 次）：…', actual: view.problem });
    expect(view.lastChecked === view.newestCheckAt, '詳情頁「上次檢查」與收集紀錄最新一筆檢查的時間相同',
      { id: 'w1.detail-last-checked', expected: view.newestCheckAt, actual: view.lastChecked });
    await shot('detail-failing', view.view);
    await view.view.close();

    const { overview } = await instance.api('/api/jobs/overview');
    expect(!overview.failed.some((entry) => entry.jobId === failed.id), '失敗的檢查不在工作頁的失敗區',
      { id: 'w1.not-in-failed', expected: false, actual: overview.failed.map((entry) => entry.jobId) });
    await shot('row-failing');
  });

  await record.scenario('FAIL-3', '第 5 次失敗、距第一次失敗超過 24 小時：自動暫停', async ({ expect, shot }) => {
    // Four failures in a row, the first of them 25 hours ago.
    const file = JSON.parse(await readFile(channelsFile, 'utf8'));
    const entry = file.channels.find((candidate) => candidate.id === a.id);
    entry.checkFailures = {
      count: 4, since: new Date(Date.now() - DAY - 60 * 60_000).toISOString(),
      error: entry.checkFailures?.error ?? { code: 'network_error', message: '無法連線到 YouTube，請稍後再試。（合成錯誤）' },
    };
    await writeFile(channelsFile, `${JSON.stringify(file, null, 2)}\n`);

    const failed = await checkFromRow();
    expect(failed.state === 'failed', 'A 的檢查再次失敗', { id: 'w3.job-failed', expected: 'failed', actual: failed.state });
    const shown = await waitFor(async () => {
      const value = await chip();
      return value.text === '已暫停・連續失敗 5 次' ? value : null;
    }, 'A row auto paused', { timeout: 15_000 }).catch(chip);
    expect(shown.text === '已暫停・連續失敗 5 次' && shown.error, '列為紅色「已暫停・連續失敗 5 次」',
      { id: 'w3.row', expected: '已暫停・連續失敗 5 次（紅色）', actual: shown });

    const stored = await storedA();
    expect(stored.enabled === false && stored.autoPausedAt === failed.finishedAt && stored.checkFailures?.count === 5 && !stored.nextCheckAt,
      'Vault 檔中 A 已暫停，記錄自動暫停時間與 5 次失敗', { id: 'w3.vault', expected: { enabled: false, autoPausedAt: failed.finishedAt, count: 5 },
        actual: { enabled: stored.enabled, autoPausedAt: stored.autoPausedAt ?? null, count: stored.checkFailures?.count ?? null, nextCheckAt: stored.nextCheckAt ?? null } });
    const api = await subscription();
    expect(api.checkStatus?.state === 'auto_paused' && api.autoPausedAt === failed.finishedAt, 'API 的 checkStatus 為 auto_paused',
      { id: 'w3.api', expected: 'auto_paused', actual: { checkStatus: api.checkStatus, autoPausedAt: api.autoPausedAt } });
    const events = (await instance.api('/api/activity?limit=20&eventType=subscription.auto_paused')).events;
    expect(events.length === 1 && events[0].subscriptionId === a.id && events[0].severity === 'warning', '記錄一筆 subscription.auto_paused',
      { id: 'w3.event', expected: 1, actual: events.map((event) => ({ subscriptionId: event.subscriptionId, severity: event.severity, message: event.message })) });

    const view = await detailPage();
    expect(/^連續失敗 5 次，.+ 自動暫停：.+/u.test(view.problem ?? ''), '詳情頁紅條顯示自動暫停的時間與原因',
      { id: 'w3.detail-problem', expected: '連續失敗 5 次，<時間> 自動暫停：<原因>', actual: view.problem });
    await shot('detail-auto-paused', view.view);
    await view.view.close();
    await shot('row-auto-paused');
  });

  await record.scenario('FAIL-4', '恢復：次數歸零並立即檢查，完成後回到「下次 HH:MM」', async ({ expect, shot }) => {
    await instance.updateCatalog((current) => { current.youtube.failListing = null; });
    const since = new Date().toISOString();
    const view = await openPage(`/sources/youtube/${encodeURIComponent(a.id)}`);
    await view.getByTestId('detail-toggle').click();
    const resumed = await waitFor(async () => {
      const [job] = await checksSince(since);
      return job && (job.state === 'completed' || job.state === 'failed') ? job : null;
    }, 'A resume check settled', { timeout: CHECK_TIMEOUT });
    expect(resumed.state === 'completed' && resumed.scope?.trigger === 'resume', '恢復後立即檢查一次並完成',
      { id: 'w4.resume-check', expected: { state: 'completed', trigger: 'resume' }, actual: { state: resumed.state, trigger: resumed.scope?.trigger } });
    await view.close();

    const shown = await waitFor(async () => {
      const value = await chip();
      return /^下次 /u.test(value.text) ? value : null;
    }, 'A row scheduled', { timeout: 15_000 }).catch(chip);
    expect(/^下次 /u.test(shown.text) && !shown.error, '列回到「下次 HH:MM」', { id: 'w4.row', expected: '下次 HH:MM', actual: shown });
    const api = await subscription();
    expect(api.enabled && api.checkFailures === null && api.autoPausedAt === null && api.status === 'tracking', 'API 的連續失敗與自動暫停已清除',
      { id: 'w4.api', expected: { checkFailures: null, autoPausedAt: null }, actual: { enabled: api.enabled, checkFailures: api.checkFailures, autoPausedAt: api.autoPausedAt, status: api.status } });
    // The job reads as completed a moment before its end reaches the subscription file.
    const stored = await waitFor(async () => {
      const value = await storedA();
      return value.lastCheckedAt === resumed.finishedAt ? value : null;
    }, 'A check time stored', { timeout: 10_000 }).catch(storedA);
    expect(stored.checkFailures === undefined && stored.autoPausedAt === undefined && stored.lastCheckedAt === resumed.finishedAt,
      'Vault 檔中 A 沒有連續失敗紀錄，上次檢查是恢復後那次檢查', { id: 'w4.vault', expected: { lastCheckedAt: resumed.finishedAt },
        actual: { checkFailures: stored.checkFailures ?? null, autoPausedAt: stored.autoPausedAt ?? null, lastCheckedAt: stored.lastCheckedAt } });
    await shot('row-resumed');
  });
}
