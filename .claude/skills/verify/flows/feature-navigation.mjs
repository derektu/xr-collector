import { idle, subscribe } from '../scripts/lib/index.mjs';

export const name = 'feature-navigation';
export const title = '訂閱入口與篩選、工作診斷、索引重建及 RSS 重試';
export const covers = ['sub-add', 'sub-status', 'activity-raw', 'activity-summary', 'docs-search', 'rss-failure'];

export async function run({ instance, page, record, waitFor }) {
  const scenario = (id, title, body) => record.scenario(id, title, async ({ expect, ...rest }) => {
    let count = 0;
    await body({ ...rest, expect: (ok, text) => expect(ok, text, {
      id: `${id}.${++count}`, expected: true, actual: Boolean(ok),
    }) });
  });
  await scenario('NAV-SUB', '訂閱空入口、篩選與暫停恢復', async ({ expect, shot }) => {
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('add-subscription-empty').click();
    await page.getByTestId('add-item-youtube-channel').click();
    await page.getByTestId('add-dialog').waitFor();
    expect(await page.getByTestId('add-url').isVisible(), '空清單新增入口可用');
    await page.keyboard.press('Escape');
    await page.getByTestId('add-subscription').click();
    await page.getByTestId('add-item-youtube-channel').click();
    await page.getByTestId('add-url').fill('https://www.youtube.com/@verify-a');
    await waitFor(async () => await page.getByTestId('add-confirm').isEnabled(), 'subscribe enabled');
    await page.getByTestId('add-confirm').click();
    await page.getByTestId('add-dialog').waitFor({ state: 'detached' });
    await idle(instance);
    const source = (await instance.api('/api/subscriptions')).subscriptions.find((entry) => entry.type === 'youtube');
    const row = page.getByTestId(`source-row-${source.id}`);
    await row.waitFor();
    await page.getByTestId('sources-filter').fill('不存在的訂閱XYZ');
    await page.getByTestId('sources-no-match').waitFor();
    expect(await page.getByTestId('sources-no-match').isVisible(), '名稱篩選有空結果');
    await shot('filter-empty');
    await page.getByTestId('sources-filter').fill('');
    await page.getByRole('group', { name: '類型' }).getByRole('button', { name: /YouTube/u }).click();
    await row.waitFor();
    expect(await row.count() === 1, '類型篩選保留 YouTube 訂閱');
    expect((await page.getByTestId('check-all').innerText()).includes('立即檢查'), '全部檢查按鈕文字為立即檢查');
    await row.getByRole('link').click();
    await page.getByTestId('detail-settings').waitFor();
    await page.getByTestId('detail-toggle').click();
    const status = async () => (await instance.api('/api/subscriptions')).subscriptions.find((entry) => entry.id === source.id)?.status;
    await waitFor(async () => await status() === 'paused', 'API status paused');
    await waitFor(async () => (await page.getByTestId('detail-toggle').innerText()).includes('恢復'), 'paused UI');
    expect((await page.getByTestId('detail-toggle').innerText()).includes('恢復'), '詳情與 API 確認暫停狀態');
    await shot('paused');
    await page.getByTestId('detail-toggle').click();
    await waitFor(async () => await status() !== 'paused', 'resumed');
    expect(await status() !== 'paused', '恢復完成');
  });
  await scenario('NAV-LOG', '工作記錄 URL 與診斷複製', async ({ expect, shot, note }) => {
    const job = (await instance.api('/api/jobs?state=all&limit=100')).jobs[0];
    await page.goto(`${instance.url}/activity?job=${encodeURIComponent(job.id)}`);
    await page.getByTestId('copy-diagnostics').waitFor();
    expect(await page.getByTestId('log-job-filter').isVisible(), '工作篩選與複製診斷入口可達');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { window.__diagnostics = text; },
    } }));
    await page.getByTestId('copy-diagnostics').click();
    await waitFor(async () => Boolean(await page.evaluate(() => window.__diagnostics)), 'diagnostic payload');
    expect((await page.evaluate(() => window.__diagnostics)).includes(job.id), '複製 payload 包含工作 ID');
    note('scope', '攔截 clipboard.writeText，只證明交付文字，未驗真 OS 剪貼簿。');
    await shot('job-log');
    await page.getByRole('button', { name: '清除工作篩選' }).click();
    await page.getByTestId('log-job-filter').waitFor({ state: 'detached' });
    await page.getByTestId('activity-summary').click();
    await page.getByTestId('log-level').selectOption('info');
    await waitFor(async () => await page.locator('.summary-rows > li').count() > 0, 'summary rows loaded');
    expect(await page.locator('.summary-rows > li').count() > 0, '回到摘要後等事件載入才截圖');
    await shot('summary-info');
  });
  await scenario('NAV-INDEX', '重建索引保留知識庫文件', async ({ expect, shot }) => {
    await idle(instance);
    const before = await instance.state();
    await page.getByTestId('nav-settings').click();
    await page.getByRole('button', { name: '重建索引', exact: true }).click();
    await waitFor(async () => (await instance.api('/api/search/status')).status.state === 'ready', 'index ready');
    await waitFor(async () => (await page.getByTestId('search-index-state').innerText()).includes('就緒'), 'ready UI');
    const after = await instance.state();
    expect(before.vault.documents.length > 0 && before.vault.documents.length === after.vault.documents.length, '重建前後 Vault 文件數相同且不為空');
    const index = after.index.indexes.find((entry) => entry.uid === 'documents_v2');
    expect(index.numberOfDocuments === after.vault.documents.length, '實際索引筆數與 Vault 相同');
    expect(JSON.stringify(before.vault.documents) === JSON.stringify(after.vault.documents), '重建沒有改動文件內容');
    await shot('rebuilt');
  });
  await scenario('NAV-RSS', '503 檢查留在進行中等待重試', async ({ expect, shot }) => {
    await subscribe(instance, `${instance.feedsOrigin}/feed.xml`);
    await idle(instance);
    const feed = (await instance.api('/api/subscriptions')).subscriptions.find((entry) => entry.type === 'rss');
    await instance.updateCatalog((catalog) => { catalog.feeds['/feed.xml'].status = 503; });
    try {
      await page.getByTestId('nav-sources').click();
      await page.getByRole('group', { name: '類型' }).getByRole('button', { name: /全部/u }).click();
      await waitFor(async () => await page.getByTestId('notice').count() === 0, 'no notice');
      await page.getByRole('button', { name: `${feed.title} 的更多動作` }).click();
      await page.getByRole('menuitem', { name: '立即檢查', exact: true }).click();
      await waitFor(async () => (await instance.api('/api/subscriptions')).subscriptions
        .find((entry) => entry.id === feed.id)?.checkStatus.state === 'retrying', 'RSS retry');
      await page.getByTestId('nav-jobs').click();
      const row = page.getByTestId('jobs-running');
      await row.waitFor();
      expect((await row.innerText()).includes(feed.title), 'RSS 已開始的重試檢查在進行中');
      expect(await page.getByTestId('jobs-queued').count() === 0, '沒有錯放到排隊中分區');
      await shot('running-retry');
    } finally {
      await instance.updateCatalog((catalog) => { delete catalog.feeds['/feed.xml'].status; });
      await idle(instance);
    }
  });
}
