// Open screens follow changes an Agent makes through its own port, without reloading and without
// polling. Each step takes the revision from the Agent's response and waits until the page shows
// that revision, then reads the screen; a screen that only polled, or missed the change, fails the
// comparison with the API. The HTTP tests prove each change reaches the stream; only a browser
// shows that the screens read again from it, stay quiet while nothing changes, and follow a
// reconnected or restarted server.
import { idle } from '../scripts/lib/seed.mjs';
import { agentClient, apiRevision, screenAt } from './lib/revision.mjs';

export const name = 'live-updates';
export const title = 'Agent 的變動即時反映在開著的畫面，閒置不發請求，斷線與重啟後跟上';
export const tier = 'core';
export const covers = ['sub-status', 'sub-pause', 'sub-detail', 'sub-remove', 'docs-list', 'reader-view', 'jobs-empty', 'vault-info'];

const IDLE_MS = 10_000;

export async function run({ instance, page, record, waitFor }) {
  const by = (id) => page.getByTestId(id);
  let agent = await agentClient(instance);
  const feedUrl = `${instance.feedsOrigin}/feed.xml`;
  const settled = async () => {
    await idle(instance);
    return apiRevision(instance);
  };
  const documentsTotal = async () => (await agent('/api/documents?limit=1')).body.total;
  const summaryTotal = async () => Number(/共 (\d+) 份文件/u.exec(await by('documents-summary').innerText())?.[1] ?? NaN);

  await by('nav-sources').click();
  let feed;

  await record.scenario('LIVE-1', '訂閱頁開著，Agent 訂閱並收集：列與文件數與 API 相同', async ({ expect, shot }) => {
    await agent('/api/subscriptions', { method: 'POST', body: JSON.stringify({ url: feedUrl }) });
    await screenAt(page, instance, await settled());
    feed = (await agent('/api/subscriptions')).body.subscriptions.find((entry) => entry.type === 'rss');
    const row = by(`source-row-${feed.id}`);
    const shown = { rows: await row.count(), documents: await row.locator('[role="cell"].numeric').innerText().catch(() => null) };
    const expected = { rows: 1, documents: String(feed.documentCount) };
    expect(feed.documentCount > 0 && JSON.stringify(shown) === JSON.stringify(expected), '訂閱列出現，文件數等於 API 的 documentCount', {
      id: 'live.subscribe', expected, actual: shown,
    });
    await shot('subscribed');
    await by('nav-jobs').click();
    const empty = await by('jobs-empty').waitFor({ timeout: 5_000 }).then(() => true, () => false);
    expect(empty, '工作頁顯示沒有進行中的工作', { id: 'live.jobs-empty', expected: true, actual: empty });
  });

  await record.scenario('LIVE-2', '詳情開著，Agent 暫停與恢復：狀態跟著改變', async ({ expect, shot }) => {
    await page.goto(`${instance.url}/sources/rss/${encodeURIComponent(feed.id)}`);
    await by('source-detail').waitFor();
    await screenAt(page, instance);
    const paused = await agent(`/api/subscriptions/rss/${encodeURIComponent(feed.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    await screenAt(page, instance, paused.revision);
    const pausedText = (await by('detail-status').innerText()).trim();
    expect(pausedText === '已暫停', '暫停後詳情顯示已暫停', { id: 'live.paused', expected: '已暫停', actual: pausedText });
    await shot('paused');
    await agent(`/api/subscriptions/rss/${encodeURIComponent(feed.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    await screenAt(page, instance, await settled());
    const resumed = (await by('detail-status').innerText()).trim();
    expect(resumed !== '已暫停', '恢復並檢查完後詳情不再顯示已暫停', { id: 'live.resumed', expected: '不是已暫停', actual: resumed });
  });

  await record.scenario('LIVE-3', '文件頁與閱讀頁開著，Agent 刪除文件：總數減少，閱讀頁顯示已刪除', async ({ expect, shot }) => {
    await by('nav-documents').click();
    await by('document-list').waitFor();
    await screenAt(page, instance);
    const before = await documentsTotal();
    const [first, second] = (await agent('/api/documents?limit=2')).body.documents;
    const removed = await agent(`/api/documents/${encodeURIComponent(first.id)}`, { method: 'DELETE' });
    await screenAt(page, instance, removed.revision);
    const totals = { screen: await summaryTotal(), api: await documentsTotal() };
    expect(totals.api === before - 1 && totals.screen === totals.api, '列表總數少一份，與 API 相同', {
      id: 'live.documents-total', expected: { screen: before - 1, api: before - 1 }, actual: totals,
    });
    await page.goto(`${instance.url}/documents/${encodeURIComponent(second.id)}`);
    await page.locator('.reader-title').first().waitFor();
    await screenAt(page, instance);
    const gone = await agent(`/api/documents/${encodeURIComponent(second.id)}`, { method: 'DELETE' });
    await screenAt(page, instance, gone.revision);
    const deleted = await by('reader-deleted').count();
    expect(deleted === 1, '開著的閱讀頁顯示這份文件已刪除', { id: 'live.reader-deleted', expected: 1, actual: deleted });
    await shot('reader-deleted');
  });

  await record.scenario('LIVE-4', '設定頁開著，Agent 刪除文件：知識庫計數與 API 相同', async ({ expect }) => {
    await by('nav-settings').click();
    await by('vault-counts').waitFor();
    await screenAt(page, instance);
    const [target] = (await agent('/api/documents?limit=1')).body.documents;
    const removed = await agent(`/api/documents/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
    await screenAt(page, instance, removed.revision);
    const expected = `${await documentsTotal()} 份文件・1 個訂閱`;
    const shown = (await by('vault-counts').innerText()).trim();
    expect(shown === expected, '計數等於 API 的文件數與訂閱數', { id: 'live.vault-counts', expected, actual: shown });
  });

  await record.scenario('LIVE-5', '畫面閒置時只留事件連線，不發其他請求', async ({ expect }) => {
    for (const [nav, shown] of [['nav-sources', `source-row-${feed.id}`], ['nav-jobs', 'jobs-empty']]) {
      await by(nav).click();
      await by(shown).waitFor({ timeout: 5_000 });
      await screenAt(page, instance);
      // The screen's data is on the page and `data-revision` is back, so the reads it started have ended.
      const requests = [];
      const listen = (request) => { if (new URL(request.url()).pathname !== '/api/events') requests.push(new URL(request.url()).pathname); };
      page.on('request', listen);
      await page.waitForTimeout(IDLE_MS);
      page.off('request', listen);
      expect(requests.length === 0, `${nav} 閒置 ${IDLE_MS / 1000} 秒沒有請求`, { id: `live.idle.${nav}`, expected: [], actual: requests });
    }
  });

  await record.scenario('LIVE-6', '網路中斷時重讀失敗的畫面維持落後，恢復後補讀', async ({ expect }) => {
    await by('nav-sources').click();
    await screenAt(page, instance);
    await page.context().setOffline(true);
    let paused;
    let offline;
    try {
      paused = await agent(`/api/subscriptions/rss/${encodeURIComponent(feed.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
      offline = {
        caughtUp: await screenAt(page, instance, paused.revision, { timeout: 2_000 }).then(() => true, () => false),
        status: (await by(`source-row-${feed.id}`).getByTestId('subscription-status').innerText()).trim(),
      };
    } finally {
      await page.context().setOffline(false);
    }
    await screenAt(page, instance, paused.revision);
    const status = (await by(`source-row-${feed.id}`).getByTestId('subscription-status').innerText()).trim();
    expect(!offline.caughtUp && offline.status !== '已暫停', '離線期間讀不到新資料，畫面不算跟上', {
      id: 'live.offline-behind', expected: { caughtUp: false, status: '不是已暫停' }, actual: offline,
    });
    expect(status === '已暫停', '恢復連線後補讀，列顯示已暫停', { id: 'live.online-again', expected: '已暫停', actual: status });
  });

  await record.scenario('LIVE-7', '伺服器重啟後，未重新載入的畫面跟上新伺服器的變動', async ({ expect, shot }) => {
    const before = await apiRevision(instance);
    await page.evaluate(() => { window.__liveUpdatesMarker = 'before-restart'; });
    await instance.restart();
    agent = await agentClient(instance);
    const after = await apiRevision(instance);
    expect(before.split(':')[0] !== after.split(':')[0], '重啟後是新的伺服器', { id: 'live.restart-epoch', expected: '不同的 epoch', actual: { before, after } });
    const removed = await agent(`/api/subscriptions/rss/${encodeURIComponent(feed.id)}?documents=keep`, { method: 'DELETE' });
    await screenAt(page, instance, removed.revision);
    const rows = await by(`source-row-${feed.id}`).count();
    expect(rows === 0, '移除後列消失', { id: 'live.restart-remove', expected: 0, actual: rows });
    const marker = await page.evaluate(() => window.__liveUpdatesMarker ?? null);
    expect(marker === 'before-restart', '畫面沒有重新載入', { id: 'live.restart-no-reload', expected: 'before-restart', actual: marker });
    await shot('after-restart');
  });
}
