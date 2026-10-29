// A feed whose site answers 429: its check fails at once and counts toward that subscription's
// failures, the row turns red, and another feed checked right after completes, since RSS has no
// shared cooldown. The fifth failure a day after the first pauses the feed by itself, and 恢復
// clears the failures and checks at once. The flow writes the earlier failures into the Vault file
// instead of failing four checks over a day.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { idle, subscribe } from '../scripts/lib/index.mjs';

export const name = 'rss-rate-limit';
export const title = 'RSS 網站限制連線';
export const tier = 'feature';
export const covers = ['rss-atom', 'rss-check', 'rss-failure'];

const DAY = 24 * 60 * 60_000;
// An RSS check takes a few seconds; one that waits for a cooldown takes minutes.
const CHECK_TIMEOUT = 30_000;

export async function run({ instance, page, openPage, record, waitFor }) {
  const subscriptionsFile = path.join(instance.runDir, 'vault', 'settings', 'rss-subscriptions.json');
  const subscriptions = async () => (await instance.api('/api/subscriptions')).subscriptions.filter((entry) => entry.type === 'rss');
  const storedFeed = async (id) => JSON.parse(await readFile(subscriptionsFile, 'utf8')).subscriptions.find((entry) => entry.id === id);
  const documentsTotal = async () => (await instance.api('/api/documents?limit=1')).total;
  const feeds = {};

  const chip = async (feed) => {
    const element = page.getByTestId(`source-row-${feed.id}`).getByTestId('subscription-status');
    return { text: (await element.innerText()).trim(), error: (await element.getAttribute('class')).split(' ').includes('error') };
  };
  const rowShows = (feed, pattern) => waitFor(async () => {
    const value = await chip(feed);
    return pattern.test(value.text) ? value : null;
  }, `${feed.title} row ${pattern}`, { timeout: 15_000 }).catch(() => chip(feed));

  /** 立即檢查 from a feed's row menu; resolves with the check job once it settled, or null when it does not within `CHECK_TIMEOUT`. */
  const checkFromRow = async (feed) => {
    const since = new Date().toISOString();
    await waitFor(async () => (await page.getByTestId('notice').count()) === 0, 'no toast over the page', { timeout: 15_000 });
    await page.getByRole('button', { name: `${feed.title} 的更多動作` }).click();
    await page.getByRole('menuitem', { name: '立即檢查' }).click();
    return waitFor(async () => {
      const job = (await instance.api('/api/jobs?state=all&limit=100')).jobs
        .find((candidate) => candidate.kind === 'rss.feed' && candidate.source.id === feed.id && candidate.createdAt >= since);
      return job && (job.state === 'completed' || job.state === 'failed') ? job : null;
    }, `${feed.title} check settled`, { timeout: CHECK_TIMEOUT }).catch(() => null);
  };

  // The RSS channel's state, sampled while the checks run.
  const pacingStates = [];
  const samplePacing = async () => {
    const group = (await instance.api('/api/pacing')).groups.find((entry) => entry.group === 'rss');
    pacingStates.push(group?.state ?? null);
  };

  await record.scenario('RL-1', '準備：訂閱 RSS 與 Atom 兩個 feed', async ({ expect }) => {
    const before = await documentsTotal();
    await subscribe(instance, `${instance.feedsOrigin}/feed.xml`);
    await subscribe(instance, `${instance.feedsOrigin}/atom.xml`);
    await idle(instance);
    for (const entry of await subscriptions()) feeds[entry.url.endsWith('/atom.xml') ? 'b' : 'a'] = entry;
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('page-sources').waitFor();
    const rows = [await rowShows(feeds.a, /^下次 /u), await rowShows(feeds.b, /^下次 /u)];
    expect(rows.every((row) => /^下次 /u.test(row.text)), '兩列都是「下次 HH:MM」', { id: 'start.scheduled', expected: '下次 HH:MM', actual: rows });
    const collected = await documentsTotal() - before;
    expect(collected === 7, 'RSS 收進 4 篇、Atom 收進 3 篇', { id: 'start.documents', expected: 7, actual: collected });
  });

  await record.scenario('RL-2', 'RSS feed 回 429：該次檢查失敗並計入，Atom 隨後照常完成，RSS 沒有冷卻', async ({ expect, shot }) => {
    await instance.updateCatalog((catalog) => {
      catalog.feeds['/feed.xml'].status = 429;
      catalog.feeds['/atom.xml'].articles.unshift({
        title: '【合成】Atom 部落格 新文章', link: 'https://example.com/atom-new', guid: 'verify-atom-new',
        publishedAt: new Date(Date.now() - 60_000).toISOString(), content: '<p>【合成文章】Atom 新文章。</p>',
      });
    });
    const sampler = setInterval(() => { void samplePacing().catch(() => undefined); }, 300);
    try {
      const failed = await checkFromRow(feeds.a);
      expect(failed?.state === 'failed' && failed.error?.code === 'rate_limited', 'RSS 的檢查立刻失敗，錯誤為 rate_limited',
        { id: 'w2.a-failed', expected: { state: 'failed', code: 'rate_limited' }, actual: failed ? { state: failed.state, error: failed.error } : 'not settled' });
      const retryLabel = /^錯誤（連續 1 次）・(?:明天 )?\d{2}:\d{2} 重試$/u;
      const shown = await rowShows(feeds.a, retryLabel);
      expect(retryLabel.test(shown.text) && shown.error, 'RSS 列為紅色並顯示重試時間',
        { id: 'w2.a-row', expected: '錯誤（連續 1 次）・[明天 ]HH:MM 重試（紅色）', actual: shown });
      const stored = await storedFeed(feeds.a.id);
      expect(stored.checkFailures?.count === 1 && stored.checkFailures.error?.code === 'rate_limited', 'Vault 檔中 RSS 的連續失敗為 1 次、rate_limited',
        { id: 'w2.a-vault', expected: { count: 1, code: 'rate_limited' }, actual: stored.checkFailures ?? null });

      const documentsBefore = await documentsTotal();
      const completed = await checkFromRow(feeds.b);
      expect(completed?.state === 'completed', 'Atom 的檢查在 30 秒內完成', { id: 'w2.b-completed', expected: 'completed', actual: completed?.state ?? 'not settled' });
      const added = await waitFor(async () => (await documentsTotal()) > documentsBefore ? await documentsTotal() - documentsBefore : null,
        'Atom article saved', { timeout: 10_000 }).catch(async () => await documentsTotal() - documentsBefore);
      expect(added === 1, 'Atom 收進 1 篇新文章', { id: 'w2.b-documents', expected: 1, actual: added });
      const rowB = await rowShows(feeds.b, /^下次 /u);
      expect(/^下次 /u.test(rowB.text) && !rowB.error, 'Atom 列回到「下次 HH:MM」', { id: 'w2.b-row', expected: '下次 HH:MM', actual: rowB });
    } finally {
      clearInterval(sampler);
    }
    await samplePacing();
    expect(pacingStates.length > 0 && !pacingStates.includes('cooldown'), 'RSS 請求通道從未進入冷卻',
      { id: 'w2.no-cooldown', expected: '沒有 cooldown', actual: [...new Set(pacingStates)] });
    const limitedEvents = (await instance.api('/api/activity?limit=20&eventType=rss.rate_limited')).events;
    expect(limitedEvents.length === 0, '記錄沒有 rss.rate_limited', { id: 'w2.no-event', expected: 0, actual: limitedEvents.map((event) => event.message) });
    await shot('rows-limited');
  });

  await record.scenario('RL-3', '詳情頁：紅條與收集紀錄說明網站限制連線', async ({ expect, shot }) => {
    const view = await openPage(`/sources/rss/${encodeURIComponent(feeds.a.id)}`);
    await view.getByTestId('source-detail').waitFor();
    const problem = view.getByTestId('detail-problem');
    const problemText = (await problem.count()) ? (await problem.innerText()).trim() : null;
    expect(problemText === '最近一次檢查失敗（連續 1 次）：這個網站暫時限制連線。', '紅條顯示連續次數與原因',
      { id: 'w3.detail-problem', expected: '最近一次檢查失敗（連續 1 次）：這個網站暫時限制連線。', actual: problemText });
    const newestCheck = view.getByTestId('collection-check').first();
    const newestTitle = (await newestCheck.count()) ? (await newestCheck.locator('.collection-title').innerText()).trim() : null;
    expect(newestTitle === '發生錯誤：網站限制連線', '收集紀錄最新一筆是這次失敗的檢查',
      { id: 'w3.collection-check', expected: '發生錯誤：網站限制連線', actual: newestTitle });
    await shot('detail-limited', view);
    await view.close();
  });

  await record.scenario('RL-4', '第 5 次失敗、距第一次失敗超過 24 小時：自動暫停', async ({ expect, shot }) => {
    // Four failures in a row, the first of them 25 hours ago.
    const file = JSON.parse(await readFile(subscriptionsFile, 'utf8'));
    const entry = file.subscriptions.find((candidate) => candidate.id === feeds.a.id);
    entry.checkFailures = {
      count: 4, since: new Date(Date.now() - DAY - 60 * 60_000).toISOString(),
      error: entry.checkFailures?.error ?? { code: 'rate_limited', message: '這個網站暫時限制連線。' },
    };
    await writeFile(subscriptionsFile, `${JSON.stringify(file, null, 2)}\n`);

    const failed = await checkFromRow(feeds.a);
    expect(failed?.state === 'failed', 'RSS 的檢查再次失敗', { id: 'w4.job-failed', expected: 'failed', actual: failed?.state ?? 'not settled' });
    const shown = await rowShows(feeds.a, /^已暫停・連續失敗 5 次$/u);
    expect(shown.text === '已暫停・連續失敗 5 次' && shown.error, 'RSS 列為紅色「已暫停・連續失敗 5 次」',
      { id: 'w4.row', expected: '已暫停・連續失敗 5 次（紅色）', actual: shown });
    const events = (await instance.api('/api/activity?limit=20&eventType=subscription.auto_paused')).events;
    expect(events.length === 1 && events[0].subscriptionId === feeds.a.id, '記錄一筆 subscription.auto_paused',
      { id: 'w4.event', expected: 1, actual: events.map((event) => ({ subscriptionId: event.subscriptionId, message: event.message })) });
    await shot('row-auto-paused');
  });

  await record.scenario('RL-5', '網站恢復後按「恢復」：次數歸零並立即檢查', async ({ expect, shot }) => {
    await instance.updateCatalog((catalog) => { delete catalog.feeds['/feed.xml'].status; });
    const since = new Date().toISOString();
    const view = await openPage(`/sources/rss/${encodeURIComponent(feeds.a.id)}`);
    await view.getByTestId('detail-toggle').click();
    const resumed = await waitFor(async () => {
      const job = (await instance.api('/api/jobs?state=all&limit=100')).jobs
        .find((candidate) => candidate.kind === 'rss.feed' && candidate.source.id === feeds.a.id && candidate.createdAt >= since);
      return job && (job.state === 'completed' || job.state === 'failed') ? job : null;
    }, 'RSS resume check settled', { timeout: CHECK_TIMEOUT }).catch(() => null);
    expect(resumed?.state === 'completed' && resumed.scope?.trigger === 'resume', '恢復後立即檢查一次並完成',
      { id: 'w5.resume-check', expected: { state: 'completed', trigger: 'resume' }, actual: resumed ? { state: resumed.state, trigger: resumed.scope?.trigger } : 'not settled' });
    await view.close();
    const shown = await rowShows(feeds.a, /^下次 /u);
    expect(/^下次 /u.test(shown.text) && !shown.error, 'RSS 列回到「下次 HH:MM」', { id: 'w5.row', expected: '下次 HH:MM', actual: shown });
    const api = (await subscriptions()).find((entry) => entry.id === feeds.a.id);
    expect(api.enabled && api.checkFailures === null && api.autoPausedAt === null, 'API 的連續失敗與自動暫停已清除',
      { id: 'w5.api', expected: { enabled: true, checkFailures: null, autoPausedAt: null }, actual: { enabled: api.enabled, checkFailures: api.checkFailures, autoPausedAt: api.autoPausedAt } });
    await shot('row-resumed');
  });
}
