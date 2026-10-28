import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { articles, channel, idle, subscribe } from '../scripts/lib/index.mjs';

export const name = 'workspace-content';
export const title = '單篇收集、工作操作、RSS 設定與文件閱讀搜尋';
export const covers = [
  'collect-add',
  'collect-mismatch',
  'collect-done',
  'collect-read',
  'collect-fail',
  'jobs-retry',
  'jobs-dismiss',
  'docs-list',
  'docs-filter',
  'docs-search',
  'docs-search-unavailable',
  'reader-view',
  'reader-delete',
  'reader-recollect',
  'vault-info',
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
  const displayedVaultCountsWithin = async (expected, timeout = 6000) => {
    const deadline = Date.now() + timeout;
    let actual = '';
    do {
      actual = (await by('vault-counts').innerText()).trim();
      if (actual === expected) return actual;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    return actual;
  };
  const displayedSearchCountsWithin = async (expected, timeout = 6000) => {
    const totals = by('settings-search-index').locator('p').filter({ hasText: '已索引' });
    const deadline = Date.now() + timeout;
    let actual = '';
    do {
      actual = (await totals.innerText()).trim();
      if (actual === expected) return actual;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    return actual;
  };
  await instance.updateCatalog((c) => {
    c.feeds['/counts-three.xml'] = {
      kind: 'rss2', title: '【合成】計數第一輪', articles: articles('計數第一輪', 3),
    };
    c.feeds['/counts-two.xml'] = {
      kind: 'rss2', title: '【合成】計數第二輪', articles: articles('計數第二輪', 2),
    };
  });

  await scenario('COUNTS-1', '留在設定時文件數從 0 更新為 3', async ({ expect, shot }) => {
    await go('/documents');
    await by('documents-empty-vault').waitFor();
    expect((await by('documents-empty-vault').count()) === 1, '空 Vault 顯示新增入口', {
      id: 'COUNTS-1.empty-vault', expected: 1, actual: await by('documents-empty-vault').count(),
    });
    await by('add-document-empty').click();
    await by('add-item-url').click();
    expect((await by('add-dialog').count()) === 1, '空 Vault 的新增入口開啟相同對話框', {
      id: 'COUNTS-1.empty-add-entry', expected: 1, actual: await by('add-dialog').count(),
    });
    await page.keyboard.press('Escape');
    await go('/settings');
    await by('vault-counts').waitFor();
    expect((await by('vault-counts').innerText()).trim() === '0 份文件・0 個訂閱', '初始畫面顯示 0 份文件', {
      id: 'COUNTS-1.initial-dom', expected: '0 份文件・0 個訂閱', actual: (await by('vault-counts').innerText()).trim(),
    });
    await subscribe(instance, instance.feedsOrigin + '/counts-three.xml');
    await idle(instance);
    const state = await instance.state();
    expect(state.api.documents.total === 3, '背景收集後 API 有 3 份文件', {
      id: 'COUNTS-1.api', expected: 3, actual: state.api.documents.total,
    });
    expect(state.vault.documents.length === 3, '背景收集後 Vault 有 3 份文件', {
      id: 'COUNTS-1.vault', expected: 3, actual: state.vault.documents.length,
    });
    const actual = await displayedVaultCountsWithin('3 份文件・1 個訂閱');
    expect(actual === '3 份文件・1 個訂閱', '不離開設定，畫面在 6 秒內更新為 3 份文件', {
      id: 'COUNTS-1.dom-within-6s', expected: '3 份文件・1 個訂閱', actual,
    });
    const search = await waitFor(async () => {
      const next = (await instance.api('/api/search/status')).status;
      return next.state === 'ready' && next.indexedDocuments === 3 && next.vaultDocuments === 3 ? next : null;
    }, 'search has 3 documents');
    expect(search.indexedDocuments === 3 && search.vaultDocuments === 3, '搜尋狀態 API 已索引與知識庫數都是 3', {
      id: 'COUNTS-1.search-api', expected: { indexedDocuments: 3, vaultDocuments: 3 },
      actual: { indexedDocuments: search.indexedDocuments, vaultDocuments: search.vaultDocuments },
    });
    const searchActual = await displayedSearchCountsWithin('已索引 3 份／知識庫 3 份');
    expect(searchActual === '已索引 3 份／知識庫 3 份', '搜尋 API 就緒後 6 秒內，搜尋卡更新為 3／3', {
      id: 'COUNTS-1.search-dom-within-6s', expected: '已索引 3 份／知識庫 3 份', actual: searchActual,
    });
    const settled = await instance.state();
    const index = settled.index.indexes.find((candidate) => ['documents_v3', 'documents_v2'].includes(candidate.uid));
    expect(index?.numberOfDocuments === 3, '搜尋引擎實際索引有 3 份文件', {
      id: 'COUNTS-1.index', expected: 3, actual: index?.numberOfDocuments ?? null,
    });
    await shot('counts-3');
  });

  await scenario('COUNTS-2', '再次收集更新為 5，返回設定仍為 5', async ({ expect, shot }) => {
    await subscribe(instance, instance.feedsOrigin + '/counts-two.xml');
    await idle(instance);
    const state = await instance.state();
    expect(state.api.documents.total === 5, '第二次背景收集後 API 有 5 份文件', {
      id: 'COUNTS-2.api', expected: 5, actual: state.api.documents.total,
    });
    expect(state.vault.documents.length === 5, '第二次背景收集後 Vault 有 5 份文件', {
      id: 'COUNTS-2.vault', expected: 5, actual: state.vault.documents.length,
    });
    const actual = await displayedVaultCountsWithin('5 份文件・2 個訂閱');
    expect(actual === '5 份文件・2 個訂閱', '不離開設定，畫面在 6 秒內更新為 5 份文件', {
      id: 'COUNTS-2.dom-within-6s', expected: '5 份文件・2 個訂閱', actual,
    });
    const search = await waitFor(async () => {
      const next = (await instance.api('/api/search/status')).status;
      return next.state === 'ready' && next.indexedDocuments === 5 && next.vaultDocuments === 5 ? next : null;
    }, 'search has 5 documents');
    expect(search.indexedDocuments === 5 && search.vaultDocuments === 5, '搜尋狀態 API 已索引與知識庫數都是 5', {
      id: 'COUNTS-2.search-api', expected: { indexedDocuments: 5, vaultDocuments: 5 },
      actual: { indexedDocuments: search.indexedDocuments, vaultDocuments: search.vaultDocuments },
    });
    const searchActual = await displayedSearchCountsWithin('已索引 5 份／知識庫 5 份');
    expect(searchActual === '已索引 5 份／知識庫 5 份', '搜尋 API 就緒後 6 秒內，搜尋卡更新為 5／5', {
      id: 'COUNTS-2.search-dom-within-6s', expected: '已索引 5 份／知識庫 5 份', actual: searchActual,
    });
    const settled = await instance.state();
    const index = settled.index.indexes.find((candidate) => ['documents_v3', 'documents_v2'].includes(candidate.uid));
    expect(index?.numberOfDocuments === 5, '搜尋引擎實際索引有 5 份文件', {
      id: 'COUNTS-2.index', expected: 5, actual: index?.numberOfDocuments ?? null,
    });
    await shot('counts-5');
    await by('nav-documents').click();
    await by('page-documents').waitFor();
    await by('nav-settings').click();
    await by('vault-counts').waitFor();
    const returned = (await by('vault-counts').innerText()).trim();
    expect(returned === '5 份文件・2 個訂閱', '離開再返回設定仍顯示 5 份文件', {
      id: 'COUNTS-2.returned-dom', expected: '5 份文件・2 個訂閱', actual: returned,
    });
    const returnedSearch = (await by('settings-search-index').locator('p').filter({ hasText: '已索引' }).innerText()).trim();
    expect(returnedSearch === '已索引 5 份／知識庫 5 份', '離開再返回設定，搜尋卡仍顯示 5／5', {
      id: 'COUNTS-2.returned-search-dom', expected: '已索引 5 份／知識庫 5 份', actual: returnedSearch,
    });
  });

  const d = (await instance.catalog()).youtube.channels.find((x) => x.handle === 'verify-d');
  await instance.updateCatalog((c) => {
    c.youtube.channels.push(channel('E', 1, '工作失敗驗證'));
  });

  await scenario('CONTENT-1', '兩個單篇入口與閱讀', async ({ expect, shot }) => {
    await go('/documents');
    await page.locator('[data-testid="documents-empty-vault"], [data-testid="documents-summary"]').waitFor();
    await by('add-document').click();
    await by('add-item-url').click();
    await by('add-url').fill('https://www.youtube.com/watch?v=' + d.videos[0].id);
    await waitFor(async () => await by('add-confirm').isEnabled(), 'single URL ready');
    await shot('add-dialog');
    await by('add-confirm').click();
    await by('add-dialog').waitFor({ state: 'detached' });
    await idle(instance);
    expect((await by('page-documents').count()) === 1, '加入後留在文件頁');
    await read('youtube:' + d.videos[0].id);
    expect((await by('reader-body').innerText()).includes('【合成字幕】'), '單篇閱讀顯示字幕');
    expect((await by('reader-source-link').getAttribute('href')).includes(d.videos[0].id), '來源連結正確');
    await shot('reader');
    await go('/');
    await by('add-subscription').click();
    await by('add-item-youtube-channel').click();
    await by('add-url').fill('https://www.youtube.com/watch?v=' + d.videos[1].id);
    await by('add-mismatch').waitFor();
    expect(await by('add-confirm').isDisabled(), '類型不符時不能直接訂閱');
    expect((await by('add-switch').innerText()).trim() === '改為加入一次', '切換按鈕的完整文字');
    await by('add-switch').click();
    expect((await by('add-url').inputValue()).includes(d.videos[1].id), '切換保留網址');
    await waitFor(async () => await by('add-confirm').isEnabled(), 'switch ready');
    await by('add-confirm').click();
    await idle(instance);
    expect(
      (await docs()).some((x) => x.id === 'youtube:' + d.videos[1].id),
      '第二入口產生文件'
    );
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
    await waitFor(
      async () => !(await instance.api('/api/jobs/overview')).overview.failed.some((x) => x.jobId === failed.jobId),
      'dismiss persisted'
    );
    expect(true, '移除後 API 不再包含失敗列');
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
    expect((await by('add-confirm').innerText()).trim() === '訂閱', '網頁辨識產生訂閱動作');
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

  await scenario('CONTENT-4', '22 篇文件的分頁、來源與搜尋', async ({ expect, note, shot }) => {
    await go('/documents');
    await by('documents-source').selectOption('rss:' + feed.id);
    await waitFor(async () => (await page.locator('.document-row').count()) === 20, 'first page 20');
    note('source-options', await by('documents-source').locator('option').allInnerTexts());
    await by('documents-pagination').getByRole('button', { name: '下一頁', exact: true }).click();
    await waitFor(async () => (await page.locator('.document-row').count()) === 2, 'second page 2');
    expect(new URL(page.url()).searchParams.get('page') === '2', '頁碼記在 URL');
    await shot('page-two');
    await page.locator('.document-row').first().click();
    await by('reader-body').waitFor();
    expect((await by('reader-body').innerText()).includes('【合成文章】'), 'RSS Markdown 文章可閱讀');
    const publisherHref = `/sources/rss/${encodeURIComponent(feed.id)}`;
    const shownPublisherHref = await waitFor(async () => {
      const href = await by('reader-publisher').getAttribute('href');
      return href === publisherHref ? href : null;
    }, 'reader links the subscribed RSS publisher');
    expect(shownPublisherHref === publisherHref, '仍訂閱的發布者可以開啟正確的訂閱詳情');
    await page.locator('.reader-bar').getByRole('button', { name: '文件', exact: true }).click();
    await waitFor(async () => (await page.locator('.document-row').count()) === 2, 'reader returns to second page');
    expect(new URL(page.url()).searchParams.get('page') === '2', '返回保留分頁');
    await by('documents-search').fill('NeedleWorkspaceThree');
    await waitFor(
      async () =>
        (await page.locator('.document-row').count()) === 1 &&
        (await by('documents-summary').innerText()).includes('找到 1'),
      'search unique body'
    );
    expect(new URL(page.url()).searchParams.get('page') !== '2', '搜尋回第一頁');
    await shot('search-match');
    await by('documents-search').fill('NoWorkspaceDocumentExists');
    await by('documents-no-results').waitFor();
    expect((await by('documents-no-results').innerText()).includes('沒有符合'), '無結果顯示搜尋空狀態');
    await page.getByRole('button', { name: '清除搜尋', exact: true }).click();
    await waitFor(
      async () => (await page.locator('.document-row').count()) === 20,
      'clear search restores source list'
    );
  });

  await scenario('CONTENT-5', '刪除返回入口、已刪除閱讀與 YouTube 重新收集', async ({ expect, shot }) => {
    const id = 'youtube:' + d.videos[0].id;
    await read(id);
    await by('reader-delete').click();
    await by('confirm-delete-document').getByRole('button', { name: '取消', exact: true }).click();
    expect((await by('reader-body').count()) === 1, '取消保留閱讀');
    await by('reader-delete').click();
    await by('confirm-delete-document').getByRole('button', { name: '刪除', exact: true }).click();
    await by('page-documents').waitFor();
    const afterDeleteTotal = (await instance.api('/api/documents?limit=1')).total;
    await waitFor(
      async () =>
        (await by('documents-summary').innerText()) === `共 ${afterDeleteTotal} 份文件` &&
        (await by('documents-source').locator('option').first().innerText()) === `全部（${afterDeleteTotal}）`,
      'deleted reader returns to a settled document list'
    );
    expect((await by('reader-deleted').count()) === 0, '確認刪除後返回文件入口');
    await shot('delete-return');
    const removed = JSON.parse(
      await readFile(path.join(instance.runDir, 'vault/settings/deleted-documents.json'), 'utf8')
    );
    expect(
      removed.deleted.some((x) => x.sourceType === 'youtube' && x.sourceId === d.videos[0].id),
      '磁碟刪除紀錄包含文件'
    );
    await go('/documents/' + encodeURIComponent(id));
    await by('reader-deleted').waitFor();
    expect((await by('reader-recollect').count()) === 1, '重新開啟刪除的 YouTube 可重新收集');
    await shot('deleted-reader');
    await by('reader-recollect').click();
    await by('reader-body').waitFor({ timeout: 60_000 });
    expect(
      (await docs()).some((x) => x.id === id),
      '重新收集後 API 再次有文件'
    );
    const rss = (await docs()).find((x) => x.publisher.id === feed.id);
    await read(rss.id);
    await by('reader-delete').click();
    await by('confirm-delete-document').getByRole('button', { name: '刪除', exact: true }).click();
    await by('page-documents').waitFor();
    await go('/documents/' + encodeURIComponent(rss.id));
    await by('reader-deleted').waitFor();
    expect((await by('reader-recollect').count()) === 0, '已刪除 RSS 不提供無法還原網址的重新收集');
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
      expect((await page.locator('.document-row').count()) === 20, '搜尋不可用仍瀏覽相同來源');
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
