// Fragment search through the screens and the authorized Agent: a fragment query filtered by source
// and date pages the same documents in the UI, the UI API and the Agent, and rebuilding the index
// from Settings and restarting keep the results and the Vault text. Without it the two readers of
// the index disagree, or a rebuild changes what a user finds. The text rules (simplified and
// variant characters, NFKC, regional words, contiguous fragments, word boundaries, quoting, raw
// highlights) are in tests/search/meilisearch-integration.test.ts and the unit tests beside it.
import { idle, subscribe } from '../scripts/lib/index.mjs';

export const name = 'search-normalization';
export const title = '片段搜尋的條件與分頁、UI 與 Agent 一致、重建與重啟保留結果';
export const covers = ['docs-search-fragments', 'docs-filter', 'docs-search'];

const article = (title, slug, content) => ({
  title,
  link: `https://example.com/normalization/${slug}`,
  guid: `normalization-${slug}`,
  publishedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
  content: `<p>${content}</p>`,
});

export async function run({ instance, page, record, waitFor }) {
  // RSS subscribes with a seven-day backfill; dates stay inside that window as the flow ages.
  const pagingDate = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const otherDate = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const paging = Array.from({ length: 21 }, (_, index) => ({
    ...article(`晶片分頁 ${String(index + 1).padStart(2, '0')}`, `page-${index + 1}`, '晶片產業資料'),
    publishedAt: `${pagingDate}T12:00:00.000Z`,
  }));
  await instance.updateCatalog((catalog) => {
    catalog.feeds['/fragment-contract.xml'] = { kind: 'rss2', title: '片段規則', articles: [
      article('連續片段甲', 'contract', '觀光；半導體、個股與現金流量；離岸設備帶動風電'),
      article('原文映射', 'raw', '台积电的 ﬃ 與 CoWoS🙂；半導體材料'),
    ] };
    catalog.feeds['/fragment-pages.xml'] = { kind: 'rss2', title: '片段分頁', articles: paging };
    catalog.feeds['/fragment-other.xml'] = { kind: 'rss2', title: '片段其他來源', articles: [
      { ...article('其他晶片來源', 'other-source', '晶片產業資料'), publishedAt: `${otherDate}T12:00:00.000Z` },
    ] };
  });
  for (const pathname of ['/fragment-contract.xml', '/fragment-pages.xml', '/fragment-other.xml']) {
    await subscribe(instance, `${instance.feedsOrigin}${pathname}`);
  }
  await idle(instance);
  const expanded = await waitFor(async () => {
    const current = (await instance.api('/api/documents?limit=100')).documents;
    return current.length === 24 ? current : null;
  }, '24 documents for fragment filters and pagination');
  await page.goto(`${instance.url}/documents`);
  await page.getByTestId('page-documents').waitFor();
  const contractId = (title) => expanded.find((document) => document.title === title)?.id;
  const sortedIds = (result) => result.hits.map(({ id }) => id).sort();
  const searchApi = async (parameters) => {
    const route = `/api/search?${new URLSearchParams(parameters)}`;
    const ui = await instance.api(route);
    // Read credentials from the run-private UI origin; never put the token in evidence.
    const { connection } = await instance.api('/api/device/agent/connection');
    const response = await fetch(`${connection.url}${route}`, { headers: { authorization: `Bearer ${connection.token}` } });
    if (!response.ok) throw new Error(`Agent search returned ${response.status}`);
    const agent = await response.json();
    return { ui, agent };
  };
  /** The Documents page summary once it shows loaded results: { mode, total }. */
  const summary = async () => {
    const element = page.getByTestId('documents-summary');
    if (await element.getAttribute('data-loading') !== 'false') return null;
    return { mode: await element.getAttribute('data-mode'), total: Number(await element.getAttribute('data-total')) };
  };

  await record.scenario('NORM-6', '片段召回套用來源、日期與分頁，UI 與 Agent 一致', async ({ expect, shot }) => {
    const expected = expanded.filter(({ title }) => title.startsWith('晶片分頁 '));
    const publisherId = expected[0].publisher.id;
    const parameters = { q: '晶', sourceType: 'rss', publisherId, publishedFrom: pagingDate, publishedTo: pagingDate, limit: '20' };
    const first = await searchApi({ ...parameters, offset: '0' });
    const second = await searchApi({ ...parameters, offset: '20' });
    const all = [...first.ui.hits, ...second.ui.hits].map(({ id }) => id);
    expect(first.ui.total === 21 && second.ui.total === 21 && first.ui.hits.length === 20 && second.ui.hits.length === 1
      && sameIds(all, expected.map(({ id }) => id)), '片段兩頁合計 21 份、無漏項／重複／其他來源', {
      id: 'fragment.filtered-pages', expected: { total: 21, counts: [20, 1], ids: expected.map(({ id }) => id).sort() },
      actual: { totals: [first.ui.total, second.ui.total], counts: [first.ui.hits.length, second.ui.hits.length], ids: all.sort() },
    });
    const dateOnly = await instance.api(`/api/search?${new URLSearchParams({ q: '晶', publishedFrom: otherDate, publishedTo: otherDate })}`);
    expect(sameIds(sortedIds(dateOnly), [contractId('其他晶片來源')]), '日期單獨排除其他日期的片段結果', {
      id: 'fragment.date-filter', expected: [contractId('其他晶片來源')], actual: sortedIds(dateOnly),
    });
    expect(JSON.stringify(first.ui) === JSON.stringify(first.agent) && JSON.stringify(second.ui) === JSON.stringify(second.agent), '授權 Agent 的兩頁完整回應與 UI API 相同', {
      id: 'fragment.agent-pagination', expected: [first.ui, second.ui], actual: [first.agent, second.agent],
    });
    await page.getByTestId('documents-source').selectOption(`rss:${publisherId}`);
    await page.getByTestId('documents-search').fill('晶');
    await page.getByTestId('documents-search').press('Enter');
    await waitFor(async () => { const now = await summary(); return now?.mode === 'search' && now.total === 21; }, 'filtered fragment summary');
    await page.getByRole('button', { name: '下一頁', exact: true }).click();
    await waitFor(async () => await page.locator('.document-row').count() === 1, 'fragment second page');
    const hrefs = await page.locator('.document-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('href')));
    expect(hrefs[0] === `/documents/${encodeURIComponent(second.ui.hits[0].id)}`, 'UI 第二頁與 API 的剩餘文件相同', {
      id: 'fragment.ui-page2', expected: second.ui.hits[0].id, actual: hrefs,
    });
    await shot('filtered-page-2');
  });

  await record.scenario('NORM-7', '畫面重建與重啟保留連續片段、原文與 API 結果', async ({ expect, shot, note }) => {
    const before = await instance.state();
    const query = { q: '半導' };
    const original = await searchApi(query);
    await page.getByTestId('nav-settings').click();
    await page.getByRole('button', { name: '重建索引', exact: true }).click();
    await waitFor(async () => await page.getByTestId('search-index-state').getAttribute('data-state') === 'ready', 'rebuilt index ready');
    const rebuilt = await searchApi(query);
    await instance.restart({ page });
    const restarted = await searchApi(query);
    const after = await instance.state();
    const canonical = (response) => ({ ...response, hits: [...response.hits].sort((left, right) => left.id.localeCompare(right.id)) });
    expect(JSON.stringify(canonical(original.ui)) === JSON.stringify(canonical(rebuilt.ui)), '重建後片段 ID、total、原文與摘要不變', {
      id: 'fragment.rebuild-results', expected: canonical(original.ui), actual: canonical(rebuilt.ui),
    });
    expect(JSON.stringify(rebuilt.ui) === JSON.stringify(restarted.ui), '重啟沿用同一投影，片段順序與完整回應不變', {
      id: 'fragment.restart-results', expected: rebuilt.ui, actual: restarted.ui,
    });
    note('fragmentOrderAcrossRebuild', { before: original.ui.hits.map(({ id }) => id), rebuilt: rebuilt.ui.hits.map(({ id }) => id), restarted: restarted.ui.hits.map(({ id }) => id) });
    expect(JSON.stringify(restarted.ui) === JSON.stringify(restarted.agent), '重啟後重新讀取連線資料，Agent 結果一致', {
      id: 'fragment.restart-agent', expected: restarted.ui, actual: restarted.agent,
    });
    expect(JSON.stringify(before.vault.documents) === JSON.stringify(after.vault.documents), '重建與重啟不改寫 Vault 文件', {
      id: 'fragment.rebuild-restart-vault', expected: 'unchanged', actual: JSON.stringify(before.vault.documents) === JSON.stringify(after.vault.documents),
    });
    await shot('rebuilt-index');
  });
}

function sameIds(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}
