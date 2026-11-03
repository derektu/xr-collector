// Routine scheduled checks collapse into result runs on subscription detail and the Activity page,
// both drawn from the same summary the activity API serves; a group's detail lists exactly its
// checks, going back keeps the Activity filters, a reload keeps them all, raw events stay available
// with DEBUG on request, and a job's log can be opened by URL and copied for diagnosis. Without it
// a quiet channel buries the page in identical rows, or the two screens disagree about what ran.
// The grouping rules themselves are in tests/activity/activity-summary.test.ts and
// tests/activity/activity-jobs.test.ts; the detail's paging order is in
// tests/web/activity-group-pages.test.ts.
import path from 'node:path';
import { idle, subscribe } from '../scripts/lib/index.mjs';
import { editJson, writeText } from './lib/files.mjs';

export const name = 'check-history-summary';
export const title = '定時檢查摘要、完整細節與工作記錄';
export const covers = ['sub-detail', 'sub-failure', 'activity-summary', 'activity-detail', 'activity-raw'];

const CHECK_TIMEOUT = 30_000;

export async function run({ instance, page, openPage, record, waitFor }) {
  const catalog = await instance.catalog();
  const source = catalog.youtube.channels.find((candidate) => candidate.handle === 'verify-a');
  const subscriptionsFile = path.join(instance.runDir, 'vault', 'settings', 'youtube-channels.json');
  const jobs = async () => (await instance.api('/api/jobs?state=all&limit=100')).jobs
    .filter((job) => job.kind === 'youtube.channel' && job.source.id === source.id);
  // Group IDs name a group within one answer of the API, so screens and API are compared by result and count.
  /** The check rows of the activity summary, newest first: { result, count }. */
  const apiChecks = async () => (await instance.api('/api/activity?view=summary&severity=info,warning,error&limit=100')).entries
    .filter((entry) => entry.kind === 'check').map((entry) => ({ result: entry.result, count: entry.count }));
  /** The `[data-result]` rows of `locator` as { result, count }. */
  const rowsOf = (locator) => locator.evaluateAll((rows) => rows.map((row) => ({ result: row.dataset.result, count: Number(row.dataset.count) })));

  const scheduledCheck = async () => {
    const before = new Set((await jobs()).map((job) => job.id));
    await editJson(subscriptionsFile, (file) => {
      file.channels.find((candidate) => candidate.id === source.id).nextCheckAt = new Date(Date.now() - 1_000).toISOString();
    });
    await writeText(path.join(instance.runDir, 'schedule-trigger'), `${Date.now()}-${Math.random()}\n`);
    return waitFor(async () => {
      // A check reads as finished only once the subscription file records its end, so the next edit cannot be overwritten.
      const job = (await jobs()).find((candidate) => !before.has(candidate.id) && candidate.scope?.trigger === 'scheduled');
      return job && (job.state === 'completed' || job.state === 'failed') ? job : null;
    }, 'scheduled check settled', { timeout: CHECK_TIMEOUT });
  };
  let expected;
  let recovery;

  await record.scenario('HISTORY-W1', '例行無新內容、網路錯誤、恢復各自成組，詳情與記錄頁都和摘要 API 一致', async ({ expect, shot }) => {
    await subscribe(instance, `https://www.youtube.com/@${source.handle}`);
    await idle(instance);
    const states = [];
    for (let index = 0; index < 2; index += 1) states.push((await scheduledCheck()).state);
    await instance.updateCatalog((current) => { current.youtube.failListing = source.id; });
    for (let index = 0; index < 2; index += 1) states.push((await scheduledCheck()).state);
    await instance.updateCatalog((current) => { current.youtube.failListing = null; });
    recovery = await scheduledCheck();
    states.push(recovery.state);
    expect(JSON.stringify(states) === JSON.stringify(['completed', 'completed', 'failed', 'failed', 'completed']), '五次定時檢查依序成功、失敗、恢復',
      { id: 'w1.checks', expected: ['completed', 'completed', 'failed', 'failed', 'completed'], actual: states });

    expected = await apiChecks();
    const runs = [{ result: 'empty', count: 1 }, { result: 'network_error', count: 2 }, { result: 'empty', count: 2 }, { result: 'other', count: 1 }];
    expect(JSON.stringify(expected) === JSON.stringify(runs), '摘要 API 由新到舊：恢復 1 次、網路錯誤 2 次、無新內容 2 次、首次收集',
      { id: 'w1.api-runs', expected: runs, actual: expected });

    const detail = await openPage(`/sources/youtube/${encodeURIComponent(source.id)}`);
    await detail.getByTestId('source-detail').waitFor();
    const groups = expected.filter((entry) => entry.count > 1);
    await waitFor(async () => await detail.getByTestId('collection-check-group').count() === groups.length, 'detail groups').catch(() => undefined);
    const detailGroups = await rowsOf(detail.getByTestId('collection-check-group'));
    expect(JSON.stringify(detailGroups) === JSON.stringify(groups), '訂閱詳情的群組與摘要 API 相同',
      { id: 'w1.detail-groups', expected: groups, actual: detailGroups });
    const newest = await detail.locator('[data-testid="collection-check"], [data-testid="collection-check-group"]').first().getAttribute('data-job');
    expect(newest === recovery.id, '恢復後的單次檢查排最前、單獨顯示', { id: 'w1.detail-recovery', expected: recovery.id, actual: newest });
    await shot('subscription-summary', detail);
    await detail.close();

    await page.getByTestId('nav-activity').click();
    await page.getByTestId('activity-summary').waitFor();
    await waitFor(async () => await page.getByTestId('summary-check').count() === expected.length, 'activity summary rows').catch(() => undefined);
    const activityRows = await rowsOf(page.getByTestId('summary-check'));
    expect(JSON.stringify(activityRows) === JSON.stringify(expected), '記錄頁摘要的檢查列與摘要 API 相同',
      { id: 'w1.activity-rows', expected, actual: activityRows });
    await shot('activity-summary');
  });

  await record.scenario('HISTORY-W2', '群組細節只列這組的檢查，返回保留篩選，重新整理保留全部篩選，完整事件可看 DEBUG', async ({ expect, shot }) => {
    const defaults = { mode: await page.getByTestId('activity-summary').getAttribute('aria-pressed'), level: await page.getByTestId('log-level').inputValue() };
    expect(defaults.mode === 'true' && defaults.level === 'info', '記錄頁預設摘要、INFO 以上', { id: 'w2.defaults', expected: { mode: 'true', level: 'info' }, actual: defaults });

    await page.getByTestId('log-level').selectOption('warning');
    const errorRow = page.locator('[data-testid="summary-check"][data-result="network_error"]');
    await errorRow.waitFor();
    const group = await errorRow.getAttribute('data-group');
    await errorRow.getByRole('button').click();
    await page.getByTestId('activity-group-context').waitFor();
    await waitFor(async () => await page.getByTestId('activity-group-check').count() === 2, 'group checks').catch(() => undefined);
    const members = await page.getByTestId('activity-group-check').evaluateAll((rows) => rows.map((row) => row.dataset.result));
    const context = await page.getByTestId('activity-group-context').getAttribute('data-group');
    expect(context === group && JSON.stringify(members) === JSON.stringify(['network_error', 'network_error']), '細節是這一組，只有它的兩次網路錯誤檢查',
      { id: 'w2.group-members', expected: { group, members: ['network_error', 'network_error'] }, actual: { group: context, members } });
    const firstLevel = await page.getByTestId('activity-group-check').first().getByTestId('log-row').first().getAttribute('data-severity');
    expect(firstLevel === 'error', '每次細節由最新事件開始，WARN 以上只見 ERROR', { id: 'w2.group-level', expected: 'error', actual: firstLevel });
    await shot('group-detail');
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByTestId('activity-summary').waitFor();
    const back = await page.getByTestId('log-level').inputValue();
    expect(back === 'warning', '返回保留 WARN 以上', { id: 'w2.back-keeps-level', expected: 'warning', actual: back });

    await page.getByTestId('log-level').selectOption('info');
    await page.getByTestId('activity-raw').click();
    await waitFor(async () => await page.getByTestId('log-row').count() > 0, 'raw events loaded');
    const infoLevels = await page.getByTestId('log-row').evaluateAll((rows) => [...new Set(rows.map((row) => row.dataset.severity))]);
    expect(infoLevels.length > 0 && infoLevels.every((level) => ['info', 'warning', 'error'].includes(level)), '完整事件預設只有 INFO 以上',
      { id: 'w2.raw-info', expected: 'info／warning／error', actual: infoLevels });
    await page.getByTestId('log-level').selectOption('debug');
    await waitFor(async () => await page.locator('[data-testid="log-row"][data-severity="debug"]').count() > 0, 'debug events loaded').catch(() => undefined);
    const debugRows = await page.locator('[data-testid="log-row"][data-severity="debug"]').count();
    expect(debugRows > 0, 'DEBUG 以上可查到先前已記錄的內部事件', { id: 'w2.raw-debug', expected: '> 0', actual: debugRows });
    await shot('raw-events');

    await page.getByTestId('log-type').selectOption('documents');
    await page.getByTestId('log-level').selectOption('error');
    await page.getByTestId('log-source').selectOption(source.id);
    await page.getByTestId('log-range').selectOption('today');
    await page.reload();
    await page.getByTestId('activity-log').waitFor();
    const kept = {
      raw: await page.getByTestId('activity-raw').getAttribute('aria-pressed'),
      type: await page.getByTestId('log-type').inputValue(),
      level: await page.getByTestId('log-level').inputValue(),
      source: await page.getByTestId('log-source').inputValue(),
      range: await page.getByTestId('log-range').inputValue(),
    };
    const wanted = { raw: 'true', type: 'documents', level: 'error', source: source.id, range: 'today' };
    expect(JSON.stringify(kept) === JSON.stringify(wanted), '重新整理保留模式、類型、等級、訂閱與時間', { id: 'w2.reload-keeps-filters', expected: wanted, actual: kept });
    await shot('kept-filters');
  });

  await record.scenario('HISTORY-LOG', '以網址開啟一個工作的記錄、複製診斷資訊、清除工作篩選', async ({ expect, note, shot }) => {
    const job = recovery;
    await page.goto(`${instance.url}/activity?job=${encodeURIComponent(job.id)}`);
    await page.getByTestId('copy-diagnostics').waitFor();
    const filtered = await page.getByTestId('log-job-filter').count();
    expect(filtered === 1, '工作篩選與複製診斷入口可達', { id: 'log.job-filter', expected: 1, actual: filtered });
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { window.__diagnostics = text; },
    } }));
    await page.getByTestId('copy-diagnostics').click();
    await waitFor(async () => Boolean(await page.evaluate(() => window.__diagnostics)), 'diagnostic payload').catch(() => undefined);
    const payload = await page.evaluate(() => window.__diagnostics ?? '');
    expect(payload.includes(job.id), '複製的診斷資訊包含工作 ID', { id: 'log.diagnostics', expected: job.id, actual: payload.slice(0, 200) });
    note('scope', '攔截 clipboard.writeText，只證明交付文字，未驗真 OS 剪貼簿。');
    await shot('job-log');
    await page.getByRole('button', { name: '清除工作篩選' }).click();
    await page.getByTestId('log-job-filter').waitFor({ state: 'detached' }).catch(() => undefined);
    const cleared = { filter: await page.getByTestId('log-job-filter').count(), url: new URL(page.url()).searchParams.get('job') };
    expect(cleared.filter === 0 && cleared.url === null, '清除後回到全部記錄', { id: 'log.clear', expected: { filter: 0, url: null }, actual: cleared });
  });
}
