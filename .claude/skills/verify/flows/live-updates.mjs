// Open screens follow changes an Agent makes through its own port, without reloading and without
// polling. Each step waits until the screen shows what the API answers after the change; a screen
// that missed the change never gets there. The HTTP tests prove each change reaches the stream;
// only a browser shows that the screens read again from it, stay quiet while nothing changes, and
// follow a reconnected or restarted server.
import { idle } from '../scripts/lib/seed.mjs';
import { agentClient } from './lib/requests.mjs';

export const name = 'live-updates';
export const title = 'Agent 的變動即時反映在開著的畫面，閒置不發請求，斷線與重啟後跟上';
export const covers = ['collect-add', 'sub-status', 'sub-pause', 'sub-detail', 'sub-remove', 'docs-list', 'reader-view', 'jobs-empty', 'vault-info', 'docs-search'];

const IDLE_MS = 10_000;
const SHOWN_MS = 15_000;

export async function run({ instance, page, record, waitFor }) {
  const by = (id) => page.getByTestId(id);
  let agent = await agentClient(instance);
  const feedUrl = `${instance.feedsOrigin}/feed.xml`;
  const shown = (check, label) => waitFor(check, label, { timeout: SHOWN_MS }).catch(() => false);
  const documentsTotal = async () => (await agent('/api/documents?limit=1')).total;
  const summaryTotal = async () => Number(await by('documents-summary').getAttribute('data-total') ?? NaN);
  const serverEpoch = async () => (await fetch(`${instance.url}/api/health`)).headers.get('xr-revision')?.split(':')[0] ?? null;
  const rowPhase = () => by(`source-row-${feed.id}`).getByTestId('subscription-status').getAttribute('data-phase');

  let feed;

  await record.scenario('LIVE-1', '空知識庫的文件頁有新增入口；訂閱頁開著，Agent 訂閱並收集：列與文件數與 API 相同', async ({ expect, shot }) => {
    await by('nav-documents').click();
    await by('documents-empty-vault').waitFor();
    await by('add-document-empty').click();
    await by('add-item-url').click();
    const dialog = await by('add-dialog').count();
    expect(dialog === 1, '空知識庫的新增入口開啟新增對話框', { id: 'live.empty-vault-add', expected: 1, actual: dialog });
    await page.keyboard.press('Escape');
    await by('add-dialog').waitFor({ state: 'detached' });
    await by('nav-sources').click();
    await agent('/api/subscriptions', { method: 'POST', body: JSON.stringify({ url: feedUrl }) });
    await idle(instance);
    feed = (await agent('/api/subscriptions')).subscriptions.find((entry) => entry.type === 'rss');
    const row = by(`source-row-${feed.id}`);
    const expected = { rows: 1, documents: String(feed.documentCount) };
    const onScreen = async () => ({ rows: await row.count(), documents: await row.locator('[role="cell"].numeric').innerText({ timeout: 1_000 }).catch(() => null) });
    await shown(async () => JSON.stringify(await onScreen()) === JSON.stringify(expected), 'subscription row with its documents');
    const actual = await onScreen();
    expect(feed.documentCount > 0 && JSON.stringify(actual) === JSON.stringify(expected), '訂閱列出現，文件數等於 API 的 documentCount', {
      id: 'live.subscribe', expected, actual,
    });
    await shot('subscribed');
    await by('nav-jobs').click();
    const empty = await by('jobs-empty').waitFor({ timeout: 5_000 }).then(() => true, () => false);
    expect(empty, '工作頁顯示沒有進行中的工作', { id: 'live.jobs-empty', expected: true, actual: empty });
  });

  await record.scenario('LIVE-2', '詳情開著，Agent 暫停與恢復：狀態跟著改變', async ({ expect, shot }) => {
    await page.goto(`${instance.url}/sources/rss/${encodeURIComponent(feed.id)}`);
    await by('source-detail').waitFor();
    await agent(`/api/subscriptions/rss/${encodeURIComponent(feed.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    await shown(async () => await by('detail-status').getAttribute('data-phase') === 'paused', 'detail shows paused');
    const pausedPhase = await by('detail-status').getAttribute('data-phase');
    expect(pausedPhase === 'paused', '暫停後詳情顯示已暫停', { id: 'live.paused', expected: 'paused', actual: pausedPhase });
    await shot('paused');
    await agent(`/api/subscriptions/rss/${encodeURIComponent(feed.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    await idle(instance);
    await shown(async () => ![null, 'paused'].includes(await by('detail-status').getAttribute('data-phase')), 'detail no longer shows paused');
    const resumed = await by('detail-status').getAttribute('data-phase');
    expect(resumed !== null && resumed !== 'paused', '恢復並檢查完後詳情不再顯示已暫停', { id: 'live.resumed', expected: '不是 paused', actual: resumed });
  });

  await record.scenario('LIVE-3', '文件頁、閱讀頁與設定開著，Agent 刪除文件：總數、已刪除狀態、知識庫與搜尋計數都與 API 相同', async ({ expect, shot }) => {
    await by('nav-documents').click();
    await by('document-list').waitFor();
    const before = await documentsTotal();
    await shown(async () => await summaryTotal() === before, 'documents total before the deletion');
    const [first, second, third] = (await agent('/api/documents?limit=3')).documents;
    await agent(`/api/documents/${encodeURIComponent(first.id)}`, { method: 'DELETE' });
    await shown(async () => await summaryTotal() === before - 1, 'documents total after the deletion');
    const totals = { screen: await summaryTotal(), api: await documentsTotal() };
    expect(totals.api === before - 1 && totals.screen === totals.api, '列表總數少一份，與 API 相同', {
      id: 'live.documents-total', expected: { screen: before - 1, api: before - 1 }, actual: totals,
    });
    await page.goto(`${instance.url}/documents/${encodeURIComponent(second.id)}`);
    await page.locator('.reader-title').first().waitFor();
    await agent(`/api/documents/${encodeURIComponent(second.id)}`, { method: 'DELETE' });
    await shown(async () => await by('reader-deleted').count() === 1, 'reader shows the document deleted');
    const deleted = await by('reader-deleted').count();
    expect(deleted === 1, '開著的閱讀頁顯示這份文件已刪除', { id: 'live.reader-deleted', expected: 1, actual: deleted });
    await shot('reader-deleted');

    await by('nav-settings').click();
    await by('vault-counts').waitFor();
    await agent(`/api/documents/${encodeURIComponent(third.id)}`, { method: 'DELETE' });
    const subscriptions = (await agent('/api/subscriptions')).subscriptions.length;
    const vault = { documents: await documentsTotal(), sources: subscriptions };
    const vaultCounts = async () => ({ documents: Number(await by('vault-counts').getAttribute('data-documents')), sources: Number(await by('vault-counts').getAttribute('data-sources')) });
    await shown(async () => JSON.stringify(await vaultCounts()) === JSON.stringify(vault), 'vault counts after the deletion');
    const shownVault = await vaultCounts();
    expect(JSON.stringify(shownVault) === JSON.stringify(vault), '不離開設定，知識庫計數等於 API 的文件數與訂閱數', {
      id: 'live.vault-counts', expected: vault, actual: shownVault,
    });
    const search = await waitFor(async () => {
      const status = (await instance.api('/api/search/status')).status;
      return status.state === 'ready' && status.indexedDocuments === vault.documents ? status : null;
    }, 'search index follows the deletions');
    const counts = by('search-index-counts');
    const searchCounts = async () => ({ indexed: Number(await counts.getAttribute('data-indexed')), vault: Number(await counts.getAttribute('data-vault')) });
    await shown(async () => {
      const current = await searchCounts();
      return current.indexed === vault.documents && current.vault === vault.documents;
    }, 'search card counts after the deletions');
    const shownSearch = await searchCounts();
    const index = (await instance.state()).index.indexes.find((candidate) => ['documents_v4', 'documents_v2'].includes(candidate.uid));
    const expectedSearch = { indexed: vault.documents, vault: vault.documents, engine: vault.documents };
    const actualSearch = { ...shownSearch, engine: index?.numberOfDocuments ?? null, api: { indexed: search.indexedDocuments, vault: search.vaultDocuments } };
    expect(shownSearch.indexed === vault.documents && shownSearch.vault === vault.documents && search.vaultDocuments === vault.documents
      && index?.numberOfDocuments === vault.documents, '不離開設定，搜尋卡、搜尋狀態 API 與引擎實際索引數都等於文件數', {
      id: 'live.search-counts', expected: expectedSearch, actual: actualSearch,
    });
    await shot('settings-counts');
  });

  await record.scenario('LIVE-5', '畫面閒置時只留事件連線，不發其他請求', async ({ expect }) => {
    await idle(instance);
    // Requests the page has sent and not yet seen answered; the event stream stays open by design.
    const open = new Set();
    const read = (request) => new URL(request.url()).pathname !== '/api/events';
    const sent = (request) => { if (read(request)) open.add(request); };
    const ended = (request) => { open.delete(request); };
    page.on('request', sent);
    page.on('requestfinished', ended);
    page.on('requestfailed', ended);
    try {
      // A named observation period: no request in it shows the screen does not read on a timer.
      for (const [nav, element] of [['nav-sources', `source-row-${feed.id}`], ['nav-jobs', 'jobs-empty']]) {
        await by(nav).click();
        await by(element).waitFor({ timeout: 5_000 });
        await waitFor(() => open.size === 0, `${nav} reads answered`, { timeout: SHOWN_MS });
        const requests = [];
        const listen = (request) => { if (read(request)) requests.push(new URL(request.url()).pathname); };
        page.on('request', listen);
        await page.waitForTimeout(IDLE_MS);
        page.off('request', listen);
        expect(requests.length === 0, `${nav} 閒置 ${IDLE_MS / 1000} 秒沒有請求`, { id: `live.idle.${nav}`, expected: [], actual: requests });
      }
    } finally {
      page.off('request', sent);
      page.off('requestfinished', ended);
      page.off('requestfailed', ended);
    }
  });

  await record.scenario('LIVE-6', '網路中斷時的變動，恢復連線後畫面顯示最新狀態', async ({ expect }) => {
    await by('nav-sources').click();
    await by(`source-row-${feed.id}`).waitFor();
    // The page's reads that failed after the change; the event stream's own reconnects are not reads.
    const failures = [];
    const failed = (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/') && pathname !== '/api/events') failures.push(pathname);
    };
    page.on('requestfailed', failed);
    let offlineFailures = [];
    await page.context().setOffline(true);
    try {
      await agent(`/api/subscriptions/rss/${encodeURIComponent(feed.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
      offlineFailures = await waitFor(() => (failures.length > 0 ? [...failures] : null), 'the page tried to read while offline').catch(() => []);
    } finally {
      page.off('requestfailed', failed);
      await page.context().setOffline(false);
    }
    await shown(async () => await rowPhase() === 'paused', 'row shows paused after reconnecting');
    const phase = await rowPhase();
    expect(offlineFailures.length > 0, '離線期間畫面重讀失敗，之後的狀態靠恢復連線補上', { id: 'live.offline-read-failed', expected: '至少一次失敗的讀取', actual: offlineFailures });
    expect(phase === 'paused', '恢復連線後，列顯示離線期間的暫停', { id: 'live.online-again', expected: 'paused', actual: phase });
  });

  await record.scenario('LIVE-7', '伺服器重啟後，未重新載入的畫面跟上新伺服器的變動', async ({ expect, shot }) => {
    const before = await serverEpoch();
    await page.evaluate(() => { window.__liveUpdatesMarker = 'before-restart'; });
    await instance.restart();
    agent = await agentClient(instance);
    const after = await serverEpoch();
    expect(before !== after, '重啟後是新的伺服器', { id: 'live.restart-epoch', expected: '不同的 epoch', actual: { before, after } });
    await agent(`/api/subscriptions/rss/${encodeURIComponent(feed.id)}?documents=keep`, { method: 'DELETE' });
    await shown(async () => await by(`source-row-${feed.id}`).count() === 0, 'row gone after the removal');
    const rows = await by(`source-row-${feed.id}`).count();
    expect(rows === 0, '移除後列消失', { id: 'live.restart-remove', expected: 0, actual: rows });
    const marker = await page.evaluate(() => window.__liveUpdatesMarker ?? null);
    expect(marker === 'before-restart', '畫面沒有重新載入', { id: 'live.restart-no-reload', expected: 'before-restart', actual: marker });
    await shot('after-restart');
  });
}
