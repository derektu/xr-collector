// Browsing, filtering, searching, reading, deleting and explicitly recollecting synthetic documents,
// with Vault/API/index checks and a graceful restart. Collection only establishes the precondition;
// every behavior this flow proves is driven through the Documents and Reader screens.
import { articles } from '../scripts/lib/synthetic.mjs';
import { collect, idle, subscribe } from '../scripts/lib/seed.mjs';

export const name = 'documents-reader-search';
export const title = '文件列表、搜尋、閱讀、刪除與重新收集';
export const covers = ['docs-list', 'docs-filter', 'docs-search', 'reader-view', 'reader-delete', 'reader-recollect'];

/** Meilisearch keys are the document IDs in base64url. */
const fromIndexKey = (key) => Buffer.from(key, 'base64url').toString('utf8');

const listedIds = (state) => (state.api.documents?.documents ?? []).map((document) => document.id).sort();
const vaultIds = (state) => (state.vault.documents ?? []).map((document) => document.frontmatter?.collector?.id).filter(Boolean).sort();
const indexIds = (state) => {
  const index = state.index.indexes?.find((entry) => ['documents_v3', 'documents_v2'].includes(entry.uid));
  return index ? index.keys.map(fromIndexKey).sort() : null;
};
const sameIds = (actual, expected) => actual !== null && JSON.stringify(actual) === JSON.stringify(expected);

const rowHrefs = (page) => page.locator('.document-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('href')));

export async function run({ instance, page, record, waitFor }) {
  // The product page size is 20. A (5) + RSS (16) + one D video gives 22 deterministic documents,
  // so the list has a real second page without making subscription behavior part of this flow.
  const fixtureNow = Date.now();
  await instance.updateCatalog((catalog) => {
    catalog.youtube.captureDelayMs = 25;
    catalog.feeds['/feed.xml'].articles = articles('RSS 部落格', 16, fixtureNow).map((article, index) => ({
      ...article,
      publishedAt: new Date(fixtureNow - (index + 1) * 60 * 60_000).toISOString(),
    }));
  });
  const catalog = await instance.catalog();
  const channelA = catalog.youtube.channels.find((source) => source.handle === 'verify-a');
  const channelD = catalog.youtube.channels.find((source) => source.handle === 'verify-d');
  const targetVideo = channelA.videos[2];
  const targetId = `youtube:${targetVideo.id}`;
  const targetQuery = '頻道 A 第 3 集';
  const missingQuery = '絕對不存在的驗收關鍵詞';

  await subscribe(instance, `https://www.youtube.com/@${channelA.handle}`);
  await subscribe(instance, `${instance.feedsOrigin}/feed.xml`);
  await collect(instance, `https://www.youtube.com/watch?v=${channelD.videos[0].id}`);
  await idle(instance);
  const precondition = await waitFor(async () => {
    const state = await instance.state();
    const ids = vaultIds(state);
    return ids.length === 22 && sameIds(listedIds(state), ids) && sameIds(indexIds(state), ids) ? state : null;
  }, '22 precondition documents persisted in API, Vault and index');
  const expectedIds = vaultIds(precondition);
  if (expectedIds.length !== 22) throw new Error(`documents-reader-search precondition needs 22 Vault documents; got ${expectedIds.length}`);
  const expectedAfterDelete = expectedIds.filter((id) => id !== targetId);

  await page.getByTestId('nav-documents').click();
  await page.getByTestId('page-documents').waitFor();

  await record.scenario('DOCS-1', '文件列表、分頁與來源篩選', async ({ expect, shot, note }) => {
    await waitFor(async () => (await page.getByTestId('documents-summary').innerText()).trim() === '共 22 份文件', '22 documents listed');
    const firstCount = await page.locator('.document-row').count();
    expect(firstCount === 20, '第一頁列出 20 份文件', { id: 'list.page1.count', expected: 20, actual: firstCount });
    const preconditionApi = listedIds(precondition);
    const preconditionIndex = indexIds(precondition);
    expect(sameIds(preconditionApi, expectedIds) && sameIds(preconditionIndex, expectedIds), '前置資料的 API、Vault 與索引是同一組 22 個 ID',
      { id: 'list.precondition.ids', expected: expectedIds, actual: { api: preconditionApi, vault: expectedIds, index: preconditionIndex } });
    const first = await rowHrefs(page);
    const pagination = await page.getByTestId('documents-pagination').count();
    expect(pagination === 1, '超過 20 份文件時顯示分頁', { id: 'list.pagination.visible', expected: 1, actual: pagination });

    await page.getByRole('button', { name: '下一頁', exact: true }).click();
    await waitFor(async () => await page.locator('.document-row').count() === 2, 'second page has two documents');
    const second = await rowHrefs(page);
    const pageUnion = new Set([...first, ...second]);
    expect(second.length === 2, '第二頁列出剩餘 2 份文件', { id: 'list.page2.count', expected: 2, actual: second.length });
    expect(pageUnion.size === 22, '兩頁文件不重複且合計 22 份', { id: 'list.pages.complete', expected: 22, actual: pageUnion.size });
    await shot('page-2');

    const source = `youtube:${channelA.id}`;
    const options = await page.getByTestId('documents-source').locator('option').allInnerTexts();
    note('sourceOptions', options);
    await page.getByTestId('documents-source').selectOption(source);
    await waitFor(async () => (await page.getByTestId('documents-summary').innerText()).trim() === '共 5 份文件', 'channel A filter has five documents');
    const filteredTitles = await page.locator('.document-title').allInnerTexts();
    expect(filteredTitles.length === 5, '頻道 A 篩選後列出 5 份文件', { id: 'filter.channel-a.count', expected: 5, actual: filteredTitles.length });
    expect(filteredTitles.every((title) => title.includes('頻道 A')), '篩選結果全部來自頻道 A',
      { id: 'filter.channel-a.only', expected: '每個標題包含「頻道 A」', actual: filteredTitles });
    await shot('channel-a-filter');
  });

  await record.scenario('DOCS-2', '搜尋、無結果與閱讀頁', async ({ expect, shot }) => {
    await page.getByTestId('documents-source').selectOption('');
    await page.getByTestId('documents-search').fill(missingQuery);
    await page.getByTestId('documents-search').press('Enter');
    await page.getByTestId('documents-no-results').waitFor();
    const emptySummary = (await page.getByTestId('documents-summary').innerText()).trim();
    const emptyApi = await instance.api(`/api/search?q=${encodeURIComponent(missingQuery)}`);
    expect(emptySummary === '找到 0 份', '不存在的詞顯示 0 份結果', { id: 'search.none.summary', expected: '找到 0 份', actual: emptySummary });
    expect(emptyApi.total === 0 && emptyApi.hits.length === 0, '不存在的詞在搜尋 API 也沒有結果',
      { id: 'search.none.api', expected: { total: 0, ids: [] }, actual: { total: emptyApi.total, ids: emptyApi.hits.map((hit) => hit.id) } });
    await shot('no-results');

    await page.getByTestId('documents-search').fill(targetQuery);
    await page.getByTestId('documents-search').press('Enter');
    await waitFor(async () => (await page.getByTestId('documents-summary').innerText()).trim() === '找到 1 份', 'target search has one result');
    const search = await instance.api(`/api/search?q=${encodeURIComponent(targetQuery)}`);
    const rows = await page.locator('.document-row').count();
    expect(rows === 1, '畫面只列出目標文件', { id: 'search.target.row-count', expected: 1, actual: rows });
    expect(search.total === 1 && search.hits[0]?.id === targetId, '搜尋 API 回傳相同目標文件',
      { id: 'search.target.api', expected: { total: 1, id: targetId }, actual: { total: search.total, id: search.hits[0]?.id ?? null } });
    const highlights = await page.locator('.document-excerpt mark').count();
    expect(highlights > 0, '搜尋摘要標出命中內容', { id: 'search.target.highlight', expected: '至少 1 個 mark', actual: highlights });
    await shot('search-result');

    await page.locator('.document-row').click();
    await page.getByTestId('reader-body').waitFor();
    const body = await page.getByTestId('reader-body').innerText();
    const publisher = (await page.getByTestId('reader-publisher').innerText()).trim();
    const sourceUrl = await page.getByTestId('reader-source-link').getAttribute('href');
    expect(body.includes('【合成字幕】'), '閱讀頁顯示合成字幕內文', { id: 'reader.body', expected: '包含【合成字幕】', actual: body.slice(0, 80) });
    expect(publisher === channelA.title, '閱讀頁顯示頻道 A 發布者', { id: 'reader.publisher', expected: channelA.title, actual: publisher });
    expect(sourceUrl === `https://www.youtube.com/watch?v=${targetVideo.id}`, '原始來源連結指向目標影片',
      { id: 'reader.source-link', expected: `https://www.youtube.com/watch?v=${targetVideo.id}`, actual: sourceUrl });
    await shot('reader');
  });

  await record.scenario('DOCS-3', '刪除後導向、直接開啟已刪文件與資料面', async ({ expect, shot, note }) => {
    await page.getByTestId('reader-delete').click();
    const dialog = page.getByTestId('confirm-delete-document');
    await dialog.waitFor();
    await shot('delete-confirmation');
    await dialog.getByRole('button', { name: '刪除', exact: true }).click();
    await page.getByTestId('page-documents').waitFor();
    await page.getByTestId('documents-no-results').waitFor();
    const retainedQuery = await page.getByTestId('documents-search').inputValue();
    expect(retainedQuery === targetQuery, '刪除後回文件頁並保留搜尋詞', { id: 'delete.redirect.query', expected: targetQuery, actual: retainedQuery });
    expect(new URL(page.url()).pathname === '/documents', '刪除後目前實作導向文件頁',
      { id: 'delete.redirect.path', expected: '/documents', actual: new URL(page.url()).pathname });
    await shot('delete-returned-to-documents');

    await page.goto(`${instance.url}/documents/${encodeURIComponent(targetId)}`);
    await page.getByTestId('reader-deleted').waitFor();
    const deletedTitle = (await page.getByTestId('reader-deleted').locator('h1').innerText()).trim();
    expect(deletedTitle === '這份文件已刪除', '直接開已刪文件顯示已刪除狀態',
      { id: 'delete.direct-url.state', expected: '這份文件已刪除', actual: deletedTitle });

    await waitFor(async () => (await instance.api(`/api/search?q=${encodeURIComponent(targetQuery)}`)).total === 0, 'deleted target leaves search');
    // Search excludes pending removals immediately; the physical engine deletion is asynchronous.
    await waitFor(async () => sameIds(indexIds(await instance.state()), expectedAfterDelete), 'physical index contains exactly the remaining IDs');
    const state = await instance.state();
    const api = listedIds(state);
    const vault = vaultIds(state);
    const index = indexIds(state);
    const deletionFile = state.vault.files?.['settings/deleted-documents.json'];
    const deleted = deletionFile?.deleted?.map((entry) => `${entry.sourceType}:${entry.sourceId}`).sort() ?? null;
    expect(sameIds(api, expectedAfterDelete), 'API 列表只移除目標 ID',
      { id: 'delete.api.removed', expected: expectedAfterDelete, actual: api });
    expect(sameIds(vault, expectedAfterDelete), 'Vault 只移除目標 ID',
      { id: 'delete.vault.removed', expected: expectedAfterDelete, actual: vault });
    expect(sameIds(index, expectedAfterDelete), '索引只移除目標 ID',
      { id: 'delete.index.removed', expected: expectedAfterDelete, actual: index ?? state.index });
    expect(deleted?.includes(targetId) === true, 'deleted-documents.json 記錄目標文件',
      { id: 'delete.ledger.recorded', expected: [targetId], actual: deleted });
    await shot('deleted-direct-url');
  });

  await record.scenario('DOCS-4', '從已刪除狀態重新收集', async ({ expect, shot }) => {
    await page.getByTestId('reader-recollect').click();
    await page.getByTestId('reader-body').waitFor({ timeout: 60_000 });
    await waitFor(async () => sameIds(indexIds(await instance.state()), expectedIds), 'recollected document persisted in index');
    const state = await instance.state();
    const api = listedIds(state);
    const vault = vaultIds(state);
    const index = indexIds(state);
    const deleted = state.vault.files?.['settings/deleted-documents.json']?.deleted
      ?.map((entry) => `${entry.sourceType}:${entry.sourceId}`).sort() ?? null;
    expect(sameIds(api, expectedIds), '重新收集後 API 恢復完整 ID 集合',
      { id: 'recollect.api.restored', expected: expectedIds, actual: api });
    expect(sameIds(vault, expectedIds), '重新收集後 Vault 恢復完整 ID 集合',
      { id: 'recollect.vault.restored', expected: expectedIds, actual: vault });
    expect(sameIds(index, expectedIds), '重新收集後索引恢復完整 ID 集合',
      { id: 'recollect.index.restored', expected: expectedIds, actual: index ?? state.index });
    expect(deleted !== null && !deleted.includes(targetId), '重新收集後刪除紀錄移除目標',
      { id: 'recollect.ledger.cleared', expected: { targetPresent: false }, actual: deleted === null ? deletionFileDescription(state) : { targetPresent: deleted.includes(targetId), ids: deleted } });
    await shot('recollected-reader');
  });

  await record.scenario('DOCS-5', '重啟後搜尋仍正確', async ({ expect, shot }) => {
    await instance.restart({ page });
    await page.getByTestId('nav-documents').click();
    await page.getByTestId('documents-search').fill(targetQuery);
    await page.getByTestId('documents-search').press('Enter');
    await waitFor(async () => (await page.getByTestId('documents-summary').innerText()).trim() === '找到 1 份', 'restart search has target');
    const search = await instance.api(`/api/search?q=${encodeURIComponent(targetQuery)}`);
    const state = await instance.state();
    const api = listedIds(state);
    const vault = vaultIds(state);
    const index = indexIds(state);
    expect(search.total === 1 && search.hits[0]?.id === targetId, '重啟後搜尋仍回傳重新收集的目標',
      { id: 'restart.search.target', expected: { total: 1, id: targetId }, actual: { total: search.total, id: search.hits[0]?.id ?? null } });
    expect(sameIds(api, expectedIds), '重啟後 API 仍是完整前置 ID 集合',
      { id: 'restart.api.complete', expected: expectedIds, actual: api });
    expect(sameIds(vault, expectedIds), '重啟後 Vault 仍是完整前置 ID 集合',
      { id: 'restart.vault.complete', expected: expectedIds, actual: vault });
    expect(sameIds(index, expectedIds), '重啟後索引仍是完整前置 ID 集合',
      { id: 'restart.index.complete', expected: expectedIds, actual: index ?? state.index });
    await shot('restart-search');
  });
}

function deletionFileDescription(state) {
  const value = state.vault.files?.['settings/deleted-documents.json'];
  return value === undefined ? 'deleted-documents.json 不存在' : value;
}
