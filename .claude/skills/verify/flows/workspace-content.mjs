import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { articles, channel, idle } from '../scripts/lib/index.mjs';

export const name = 'workspace-content';
export const title = '單篇類型切換、工作操作、RSS 設定、刪除後分頁與搜尋不可用';
export const covers = [
  'collect-add',
  'collect-mismatch',
  'collect-done',
  'collect-fail',
  'jobs-retry',
  'jobs-badge',
  'sub-detail',
  'jobs-dismiss',
  'docs-list',
  'docs-filter',
  'docs-search',
  'docs-search-unavailable',
  'reader-view',
  'reader-delete',
  'reader-recollect',
  'rss-add-feed',
  'rss-add-page',
  'rss-articles',
  'rss-settings',
];

export async function run({ instance, page, record, waitFor }) {
  const scenario = (id, title, body) =>
    record.scenario(id, title, async ({ expect, ...rest }) => {
      let check = 0;
      await body({
        ...rest,
        expect: (ok, text, detail) =>
          expect(ok, text, detail ?? { id: `${id}.${++check}`, expected: true, actual: Boolean(ok) }),
      });
    });
  const by = (id) => page.getByTestId(id);
  const go = async (route) => {
    await page.goto(instance.url + route);
  };
  const docs = async () => (await instance.api('/api/documents?limit=100')).documents;
  const read = async (id) => {
    await go('/documents/' + encodeURIComponent(id));
    await by('reader-body').waitFor();
  };
  const submit = async (url) => {
    await by('add-url').fill(url);
    await waitFor(async () => await by('add-confirm').isEnabled(), 'recognition ready');
    await by('add-confirm').click();
    await by('add-dialog').waitFor({ state: 'detached' });
    await idle(instance);
  };
  const add = async (url) => {
    await go('/documents');
    await by('add-document').click();
    await by('add-item-url').click();
    await submit(url);
  };
  const d = (await instance.catalog()).youtube.channels.find((x) => x.handle === 'verify-d');
  await instance.updateCatalog((c) => {
    c.youtube.channels.push(channel('E', 1, '工作失敗驗證'));
  });

  await scenario('CONTENT-1', '訂閱入口貼影片網址，改為加入一次', async ({ expect, shot }) => {
    await go('/');
    await by('add-subscription').click();
    await by('add-item-youtube-channel').click();
    await by('add-url').fill('https://www.youtube.com/watch?v=' + d.videos[1].id);
    await by('add-mismatch').waitFor();
    await shot('mismatch');
    expect(await by('add-confirm').isDisabled(), '類型不符時不能直接訂閱');
    await by('add-switch').click();
    expect((await by('add-url').inputValue()).includes(d.videos[1].id), '切換保留網址');
    await waitFor(async () => await by('add-confirm').isEnabled(), 'switch ready');
    await by('add-confirm').click();
    await by('add-dialog').waitFor({ state: 'detached' });
    const collected = await waitFor(
      async () => ((await docs()).some((x) => x.id === 'youtube:' + d.videos[1].id) ? { value: true } : null),
      'switched single item collected',
      { timeout: 30_000 }
    ).catch(() => ({ value: false }));
    await idle(instance);
    expect(collected.value, '第二入口產生文件');
    expect(!(await instance.api('/api/subscriptions')).subscriptions.some((x) => x.id === d.id), '單篇不建立訂閱');
  });

  await scenario('CONTENT-2', '失敗單篇重試與移除', async ({ expect, shot }) => {
    await instance.updateCatalog((c) => {
      c.youtube.failVideo = d.videos[2].id;
    });
    await add('https://www.youtube.com/watch?v=' + d.videos[2].id);
    await go('/jobs');
    await by('jobs-failed').waitFor();
    expect((await by('jobs-badge').count()) === 0, '只有失敗時不顯示工作徽章');
    await shot('failed');
    await instance.updateCatalog((c) => {
      c.youtube.failVideo = null;
    });
    await by('jobs-failed').getByTestId('job-retry').first().click();
    await idle(instance);
    expect(
      (await docs()).some((x) => x.id === 'youtube:' + d.videos[2].id),
      '重試收回文件'
    );
    const e = (await instance.catalog()).youtube.channels.find((x) => x.handle === 'verify-e');
    await instance.updateCatalog((c) => {
      c.youtube.failVideo = e.videos[0].id;
    });
    await add('https://www.youtube.com/watch?v=' + e.videos[0].id);
    await go('/jobs');
    await by('jobs-failed').waitFor();
    const failed = (await instance.api('/api/jobs/overview')).overview.failed.find((x) =>
      x.url?.includes(e.videos[0].id)
    );
    expect(Boolean(failed), 'API 存在新失敗單篇');
    await by('job-' + failed.jobId)
      .getByTestId('job-dismiss')
      .click();
    const listed = async () => (await instance.api('/api/jobs/overview')).overview.failed.some((x) => x.jobId === failed.jobId);
    await waitFor(async () => !(await listed()), 'dismiss persisted').catch(() => undefined);
    await by('job-' + failed.jobId).waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
    const dismissed = { api: await listed(), row: await by('job-' + failed.jobId).count() };
    expect(!dismissed.api && dismissed.row === 0, '移除後 API 與工作頁都不再有這個失敗列',
      { id: 'jobs.dismiss', expected: { api: false, row: 0 }, actual: dismissed });
    await instance.updateCatalog((c) => {
      c.youtube.failVideo = null;
    });
  });

  let feed;
  await scenario('CONTENT-3', 'RSS 畫面新增、網頁辨識與設定持久化', async ({ expect, shot }) => {
    await instance.updateCatalog((c) => {
      c.feeds['/workspace.xml'] = {
        kind: 'rss2',
        title: '【合成】工作區',
        articles: articles('工作區', 22).map((x, i) => ({
          ...x,
          publishedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
          content: x.content + (i === 2 ? '<p>NeedleWorkspaceThree</p>' : ''),
        })),
      };
      c.feeds['/workspace-blog'] = { kind: 'page', title: '工作區首頁', feeds: [{ href: '/workspace.xml' }] };
    });
    await go('/');
    await by('add-subscription').click();
    await by('add-item-rss-feed').click();
    await by('add-url').fill(instance.feedsOrigin + '/workspace-blog');
    await waitFor(async () => await by('add-confirm').isEnabled(), 'announced feed found');
    expect((await by('add-confirm').getAttribute('data-action')) === 'subscribe', '網頁辨識產生訂閱動作');
    await shot('feed-recognition');
    await by('add-confirm').click();
    await by('add-dialog').waitFor({ state: 'detached' });
    await idle(instance);
    feed = (await instance.api('/api/subscriptions')).subscriptions.find((x) => x.title === '【合成】工作區');
    expect(feed.documentCount === 22, '新 feed 收進 22 篇');
    await go('/sources/rss/' + encodeURIComponent(feed.id));
    await by('detail-settings').waitFor();
    await by('detail-settings-intervalMinutes').selectOption('30');
    await by('detail-settings-backfillDays').fill('2');
    await by('detail-settings-backfillMaxItems').fill('25');
    await waitFor(async () => {
      const saved = (await instance.api('/api/subscriptions')).subscriptions.find((x) => x.id === feed.id)?.settings;
      return saved?.intervalMinutes === 30 && saved.backfillDays === 2 && saved.backfillMaxItems === 25;
    }, 'RSS settings saved to API');
    await by('settings-saved').waitFor();
    await page.reload();
    await by('detail-settings').waitFor();
    expect(
      (await by('detail-settings-intervalMinutes').inputValue()) === '30' &&
        (await by('detail-settings-backfillDays').inputValue()) === '2' &&
        (await by('detail-settings-backfillMaxItems').inputValue()) === '25',
      '設定刷新後仍正確'
    );
    await shot('rss-settings');
    const stored = await readFile(path.join(instance.runDir, 'vault/settings/rss-subscriptions.json'), 'utf8');
    expect(stored.includes(feed.id), 'RSS 訂閱確實寫入 Vault');
  });

  await scenario('CONTENT-5', '已刪除的 RSS 不提供重新收集，最後一頁刪除後回到前一頁', async ({ expect, shot }) => {
    const rss = (await docs()).find((x) => x.publisher.id === feed.id);
    await read(rss.id);
    await by('reader-delete').click();
    await by('confirm-delete-document').getByRole('button', { name: '刪除', exact: true }).click();
    await by('page-documents').waitFor();
    const removed = JSON.parse(
      await readFile(path.join(instance.runDir, 'vault/settings/deleted-documents.json'), 'utf8')
    );
    expect(
      removed.deleted.some((x) => x.sourceType === 'rss' && `rss:${x.sourceId}` === rss.id),
      '磁碟刪除紀錄包含 RSS 文件'
    );
    await go('/documents/' + encodeURIComponent(rss.id));
    await by('reader-deleted').waitFor();
    expect((await by('reader-recollect').count()) === 0, '已刪除 RSS 不提供無法還原網址的重新收集');
    await shot('deleted-rss-reader');
    await go('/documents');
    await by('documents-source').selectOption('rss:' + feed.id);
    await waitFor(async () => (await page.locator('.document-row').count()) === 20, '21 documents first page');
    await by('documents-pagination').getByRole('button', { name: '下一頁', exact: true }).click();
    await waitFor(async () => (await page.locator('.document-row').count()) === 1, '21st document');
    await by('document-more').click();
    await page.getByRole('menuitem', { name: '刪除', exact: true }).click();
    await by('confirm-delete-document').getByRole('button', { name: '刪除', exact: true }).click();
    await waitFor(
      async () =>
        (await page.locator('.document-row').count()) === 20 && (await by('documents-pagination').count()) === 0,
      'last second-page row deletion returns to first'
    );
    expect(new URL(page.url()).searchParams.get('page') !== '2', '最後一列刪除後頁碼回退');
    await shot('last-page-deleted');
  });

  await scenario('CONTENT-6', '搜尋不可用時保留條件並退回 Vault 瀏覽', async ({ expect, note, shot }) => {
    // The feed filter from CONTENT-5 lists fewer documents than the whole Vault, so the fallback's
    // total tells a kept filter from a dropped one.
    const source = 'rss:' + feed.id;
    const summary = async () => ({
      source: await by('documents-source').inputValue(),
      mode: await by('documents-summary').getAttribute('data-mode'),
      total: Number(await by('documents-summary').getAttribute('data-total')),
    });
    const filtered = await summary();
    const vaultTotal = (await instance.api('/api/documents?limit=1')).total;
    note('before', { ...filtered, vaultTotal });
    const pattern = '**/api/search?*';
    await page.route(pattern, (r) =>
      r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'search_unavailable', message: '驗收注入搜尋不可用' } }),
      })
    );
    try {
      await by('documents-search').fill('NeedleWorkspaceThree');
      await by('search-unavailable').waitFor();
      await waitFor(async () => (await by('documents-summary').getAttribute('data-loading')) === 'false', 'fallback listed').catch(() => undefined);
      const fallback = await summary();
      const expected = { source, mode: 'browse', total: filtered.total };
      expect(filtered.source === source && filtered.total < vaultTotal && JSON.stringify(fallback) === JSON.stringify(expected),
        '搜尋不可用時保留來源篩選，瀏覽同一來源的文件', { id: 'search.fallback-keeps-filter', expected, actual: { fallback, filtered, vaultTotal } });
      expect((await by('documents-search').inputValue()) === 'NeedleWorkspaceThree', '保留搜尋字串');
      note('scope', '路由 stub 只證明 UI 的 fallback 分支，不宣稱實際引擎故障。');
      await shot('search-fallback');
      await page.locator('.document-row').first().click();
      await by('reader-body').waitFor();
      expect((await by('reader-body').count()) === 1, 'fallback 文件仍可閱讀');
      await page.locator('.reader-bar').getByRole('button', { name: '文件', exact: true }).click();
      await by('search-unavailable').waitFor();
      await by('search-unavailable').getByRole('button', { name: '前往設定' }).click();
      await by('search-index-state').waitFor();
      expect((await by('search-index-state').count()) === 1, '前往設定能看索引狀態');
    } finally {
      await page.unroute(pattern);
    }
  });
}
