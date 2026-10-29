// Native menu attention and notification activation. The flow creates real RSS subscriptions,
// then writes the already-auto-paused fixture that would otherwise take five failures over a day.
// Validation activation follows the same route as an OS click; it does not claim the OS displayed a
// toast, which remains installed-app visual acceptance.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  activateNotification, clickTray, closeWindow, idle, notifications, subscribe, trayMenu, windowState,
} from '../scripts/lib/index.mjs';

export const name = 'notification-clicks';
export const title = '自動暫停通知的選單、圖示與導頁';
export const tier = 'platform';
export const covers = ['notification-events', 'notification-actionable', 'notification-click', 'tray-menu', 'tray-open'];
export const desktop = true;

const PAUSED_AT = '2026-10-28T01:00:00.000Z';
const eventId = (vaultId, subscriptionId) => createHash('sha256')
  .update(JSON.stringify([vaultId, 'rss', subscriptionId, PAUSED_AT])).digest('hex');

async function serveFeeds(port) {
  const server = createServer((request, response) => {
    const suffix = request.url?.includes('/b.xml') ? 'B' : 'A';
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>【合成】通知 ${suffix}</title>`
      + `<link>http://127.0.0.1:${port}/${suffix}</link><item><title>【合成】通知文章 ${suffix}</title>`
      + `<link>http://127.0.0.1:${port}/${suffix}/1</link><guid>notification-${suffix}</guid>`
      + `<pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate><description>通知驗收內容。</description></item></channel></rss>`;
    response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' }).end(xml);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    urls: [`http://127.0.0.1:${port}/a.xml`, `http://127.0.0.1:${port}/b.xml`],
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

export async function run({ instance, record, waitFor }) {
  const feeds = await serveFeeds(instance.ports.feeds);
  const page = () => instance.window;
  const subscriptionsFile = path.join(instance.vault, 'settings', 'rss-subscriptions.json');
  const markerFile = path.join(instance.vault, 'xr-collector-vault.json');
  let ids;
  let originalVaultId;

  try {
    await record.scenario('NCLICK-D0', '準備兩筆真 RSS 訂閱，再載入自動暫停 fixture', async ({ expect, note }) => {
      for (const url of feeds.urls) await subscribe(instance, url);
      await idle(instance);
      const subscriptions = (await instance.api('/api/subscriptions')).subscriptions.filter((entry) => entry.type === 'rss');
      const byUrl = feeds.urls.map((url) => subscriptions.find((entry) => entry.url === url));
      expect(byUrl.every(Boolean), '兩筆 RSS 都經公開訂閱 API 建立', { id: 'fixture.subscriptions', expected: feeds.urls, actual: subscriptions.map((entry) => entry.url) });
      ids = byUrl.map((entry) => entry.id);

      const stored = JSON.parse(await readFile(subscriptionsFile, 'utf8'));
      for (const row of stored.subscriptions.filter((entry) => ids.includes(entry.id))) {
        row.enabled = false;
        row.nextCheckAt = null;
        row.autoPausedAt = PAUSED_AT;
        row.checkFailures = {
          count: 5,
          since: '2026-10-26T01:00:00.000Z',
          error: { code: 'feed_not_found', message: '找不到 feed（合成通知驗收）' },
        };
      }
      await writeFile(subscriptionsFile, `${JSON.stringify(stored, null, 2)}\n`);
      originalVaultId = JSON.parse(await readFile(markerFile, 'utf8')).id;
      const first = stored.subscriptions.find((entry) => entry.id === ids[0]);
      const event = {
        id: eventId(originalVaultId, ids[0]), vaultId: originalVaultId, sourceType: 'rss', subscriptionId: ids[0], title: first.title,
        failureCount: 5, error: first.checkFailures.error, autoPausedAt: PAUSED_AT, delivery: 'attempted', deliveryMessage: null,
      };
      await writeFile(path.join(instance.profile, 'notifications.json'), `${JSON.stringify({ version: 1, enabled: true, events: [event] }, null, 2)}\n`);

      const other = path.join(instance.runDir, 'other-vault');
      const { createVaultDirectory } = await import(pathToFileURL(path.join(instance.checkout, 'dist/node/vault/vault-directory.js')).href);
      await createVaultDirectory(other, 'XR Collector notification-clicks flow');
      await mkdir(path.join(other, 'settings'), { recursive: true });
      await writeFile(path.join(other, 'settings', 'rss-subscriptions.json'), `${JSON.stringify({ ...stored, subscriptions: [first], removed: [] }, null, 2)}\n`);
      note('fixture', { ids, originalVaultId, other });
      await instance.relaunch();
    });

    await record.scenario('NCLICK-D1', 'attention 圖示、兩筆選單與隱藏／最小化後通知導頁', async ({ expect, note, shot }) => {
      const menu = await trayMenu(instance.app);
      const submenu = menu.items.find((item) => item.kind === 'submenu');
      note('menu', menu);
      expect(menu.icon === 'attention' && submenu?.items.length === 2, '兩筆自動暫停顯示 attention 與兩個入口',
        { id: 'menu.attention', expected: { icon: 'attention', entries: 2 }, actual: { icon: menu.icon, entries: submenu?.items.length ?? 0 } });

      await closeWindow(instance.app);
      await activateNotification(instance.app, eventId(originalVaultId, ids[0]));
      await waitFor(async () => { const state = await windowState(instance.app); return state.visible && state.focused; }, 'hidden window shown and focused');
      await waitFor(() => page().url().endsWith(`/sources/rss/${encodeURIComponent(ids[0])}`), 'notification source route');
      await page().getByTestId('detail-problem').waitFor();
      expect((await page().getByTestId('detail-problem').innerText()).includes('自動暫停'), '點通知顯示真詳情與自動暫停原因',
        { id: 'click.detail', expected: '自動暫停', actual: await page().getByTestId('detail-problem').innerText() });

      await instance.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await activateNotification(instance.app, eventId(originalVaultId, ids[0]));
      await waitFor(async () => instance.app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMinimized()), 'minimized window restored');
      expect((await windowState(instance.app)).focused, '最小化後通知 handler 還原並聚焦',
        { id: 'click.restore', expected: true, actual: await windowState(instance.app) });
      await shot('attention-notification-detail');

      await clickTray(instance.app, `subscription:${eventId(originalVaultId, ids[1])}`);
      await waitFor(() => page().url().endsWith(`/sources/rss/${encodeURIComponent(ids[1])}`), 'menu source without ledger');
      expect(await page().getByTestId('source-detail').count() === 1, '無 ledger 的第二筆也能從選單開詳情',
        { id: 'menu.synthetic-detail', expected: 1, actual: await page().getByTestId('source-detail').count() });
    });

    await record.scenario('NCLICK-D2', '正常重啟去重，舊通知不啟動收集', async ({ expect, note }) => {
      const beforeDocuments = (await instance.api('/api/documents?limit=1')).total;
      await instance.relaunch();
      expect((await notifications(instance.app)).length === 0, '正常重啟不重發前置通知',
        { id: 'restart.no-redelivery', expected: 0, actual: await notifications(instance.app) });
      await activateNotification(instance.app, eventId(originalVaultId, ids[0]));
      await waitFor(() => page().url().endsWith(`/sources/rss/${encodeURIComponent(ids[0])}`), 'old notification after restart');
      await page().getByTestId('detail-problem').waitFor();
      const jobs = (await instance.api('/api/jobs/overview')).overview;
      const afterDocuments = (await instance.api('/api/documents?limit=1')).total;
      note('jobs', jobs);
      expect(jobs.running.length === 0 && jobs.queued.length === 0 && afterDocuments === beforeDocuments, '點舊通知不重啟 runtime、不開始收集或新增文件',
        { id: 'restart.no-work', expected: { running: 0, queued: 0, documents: beforeDocuments }, actual: { running: jobs.running.length, queued: jobs.queued.length, documents: afterDocuments } });
    });

    await record.scenario('NCLICK-D3', '目前詳情已被外部移除時，點舊通知重新載入不存在狀態', async ({ expect, shot }) => {
      await instance.api(`/api/subscriptions/rss/${encodeURIComponent(ids[0])}`, { method: 'DELETE', body: '{}' });
      await activateNotification(instance.app, eventId(originalVaultId, ids[0]));
      await page().getByTestId('source-missing').waitFor();
      const one = await trayMenu(instance.app);
      expect(one.items.find((item) => item.kind === 'submenu')?.items.length === 1, '同一路由重抓後顯示不存在，選單剩一筆',
        { id: 'removed.same-detail', expected: 1, actual: one });
      await shot('removed-old-notification');

      await instance.api(`/api/subscriptions/rss/${encodeURIComponent(ids[1])}`, { method: 'DELETE', body: '{}' });
      const empty = await trayMenu(instance.app);
      expect(empty.icon !== 'attention' && !empty.items.some((item) => item.kind === 'submenu'), '最後一筆移除後 attention 與子選單清除',
        { id: 'removed.clear', expected: { attention: false, submenu: false }, actual: empty });
    });

    await record.scenario('NCLICK-D4', '其他 Vault 有相同 ID 時，舊通知拒絕錯誤導頁與自動切換', async ({ expect, shot }) => {
      await page().getByTestId('nav-settings').click();
      const other = path.join(instance.runDir, 'other-vault');
      await instance.api('/api/vault/open', { method: 'POST', body: JSON.stringify({ path: other }) });
      await waitFor(async () => (await instance.api('/api/health')).runtime.vaultPath === other, 'other Vault opened');
      await activateNotification(instance.app, eventId(originalVaultId, ids[0]));
      await waitFor(async () => page().getByTestId('notice').textContent().then((text) => text.includes('其他知識庫'), () => false), 'cross-Vault notice');
      expect(page().url().endsWith('/settings') && (await instance.api('/api/health')).runtime.vaultPath === other, '舊通知不導到另一 Vault 同 ID 訂閱，也不切換 Vault',
        { id: 'cross-vault.refuse', expected: { route: '/settings', vault: other }, actual: { route: new URL(page().url()).pathname, vault: (await instance.api('/api/health')).runtime.vaultPath } });
      await shot('cross-vault-refused');
    });
  } finally {
    await feeds.close();
  }
}
