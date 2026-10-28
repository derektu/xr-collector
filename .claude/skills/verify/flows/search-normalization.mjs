// Search normalization across raw Vault text, API results, UI highlights, browse semantics and restart.
import { idle, subscribe } from '../scripts/lib/index.mjs';

export const name = 'search-normalization';
export const title = '搜尋正規化、連續片段、條件與原文摘要';
export const covers = ['docs-search-normalization', 'docs-search-fragments', 'docs-list', 'docs-filter', 'docs-search', 'reader-view'];

const article = (title, slug, content) => ({
  title,
  link: `https://example.com/normalization/${slug}`,
  guid: `normalization-${slug}`,
  publishedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
  content: `<p>${content}</p>`,
});

export async function run({ instance, page, record, waitFor }) {
  await instance.updateCatalog((catalog) => {
    catalog.feeds['/normal-traditional.xml'] = {
      kind: 'rss2', title: '正規化測試一', articles: [
        article('台積電 ＡＩ', 'traditional', '台積電發展 ＥＰＳ ００５０，CoWoS🙂 <script>raw</script>'),
        article('地區詞 A', 'mainland', '服务器與软件；半導體、個股與現金流量'),
        article('地區詞 B', 'taiwan', '伺服器與軟體；半年後由導師直觀分析，產品已賣光'),
      ],
    };
    catalog.feeds['/normal-simplified.xml'] = {
      kind: 'rss2', title: '正規化測試二', articles: [
        article('台积电 AI', 'simplified', '台积电发展 EPS 0050，cowos🙂 <script>raw</script>'),
      ],
    };
    catalog.feeds['/normal-variant.xml'] = {
      kind: 'rss2', title: '正規化測試三', articles: [
        article('臺積電 ai', 'variant', '臺積電發展 eps 0050，ＣｏＷｏＳ🙂 <script>raw</script>'),
      ],
    };
  });
  for (const pathname of ['/normal-traditional.xml', '/normal-simplified.xml', '/normal-variant.xml']) {
    await subscribe(instance, `${instance.feedsOrigin}${pathname}`);
  }
  await idle(instance);
  const documents = await waitFor(async () => {
    const current = (await instance.api('/api/documents?limit=100')).documents;
    return current.length === 5 ? current : null;
  }, 'five normalization fixture documents');
  const main = documents.filter((document) => ['台積電 ＡＩ', '台积电 AI', '臺積電 ai'].includes(document.title));
  const mainIds = main.map(({ id }) => id).sort();
  if (documents.length !== 5 || mainIds.length !== 3) {
    throw new Error(`search-normalization precondition needs 5 documents and 3 main variants; got ${documents.length} and ${mainIds.length}`);
  }
  const idForTitle = (title) => documents.find((document) => document.title === title)?.id;

  await page.goto(`${instance.url}/documents`);
  await page.getByTestId('page-documents').waitFor();

  await record.scenario('NORM-1', '繁簡異體、NFKC 與 ASCII 大小寫等價', async ({ expect, shot }) => {
    for (const query of ['台積電', '台积电', '臺積電', 'ＡＩ', 'AI', 'CoWoS', 'cowos', 'ＥＰＳ', 'EPS', '００５０', '0050']) {
      const result = await instance.api(`/api/search?q=${encodeURIComponent(query)}&limit=20`);
      const ids = result.hits.map(({ id }) => id).sort();
      expect(result.total === 3 && JSON.stringify(ids) === JSON.stringify(mainIds), `${query} 在 API 命中相同三份原文`, {
        id: `normalization.api.${Buffer.from(query).toString('hex')}`, expected: { total: 3, ids: mainIds }, actual: { total: result.total, ids },
      });
    }

    const search = page.getByTestId('documents-search');
    const uiApi = await instance.api(`/api/search?q=${encodeURIComponent('台积电')}&limit=20`);
    await search.fill('台积电');
    await search.press('Enter');
    await waitFor(async () => (await page.getByTestId('documents-summary').innerText()).trim() === `找到 ${uiApi.total} 份`, 'UI shows its API result count');
    const summary = (await page.getByTestId('documents-summary').innerText()).trim();
    expect(summary === '找到 3 份', 'UI 正規化搜尋命中三份文件', {
      id: 'normalization.ui.count', expected: '找到 3 份', actual: summary,
    });
    const titles = (await page.locator('.document-title').allInnerTexts()).sort();
    expect(JSON.stringify(titles) === JSON.stringify(['台积电 AI', '台積電 ＡＩ', '臺積電 ai'].sort()), 'UI 與 API 回傳同三份文件且標題保留原文', {
      id: 'normalization.ui.raw-titles', expected: ['台积电 AI', '台積電 ＡＩ', '臺積電 ai'].sort(), actual: titles,
    });
    const simplifiedRow = page.locator('.document-row').filter({ hasText: '台积电 AI' });
    const excerpt = await simplifiedRow.locator('.document-excerpt').innerText();
    const highlighted = await simplifiedRow.locator('.document-excerpt mark').allInnerTexts();
    expect(excerpt.includes('台积电') && highlighted.includes('台积电') && !excerpt.includes('台積電'), '摘要與 highlight 映回簡體原文', {
      id: 'normalization.ui.raw-highlight', expected: { text: '台积电', marks: ['台积电'] }, actual: { excerpt, highlighted },
    });
    await shot('equivalent-search');
  });

  await record.scenario('NORM-2', 'Unicode 純空白維持瀏覽，地區詞不互換', async ({ expect, shot }) => {
    const mainland = idForTitle('地區詞 A');
    const taiwan = idForTitle('地區詞 B');
    const apiMainland = await instance.api(`/api/search?q=${encodeURIComponent('服務器')}`);
    const apiTaiwan = await instance.api(`/api/search?q=${encodeURIComponent('伺服器')}`);
    expect(JSON.stringify(apiMainland.hits.map(({ id }) => id)) === JSON.stringify([mainland]), '服务器只做簡轉繁，不替換成伺服器', {
      id: 'normalization.no-regional-mainland', expected: [mainland], actual: apiMainland.hits.map(({ id }) => id),
    });
    expect(JSON.stringify(apiTaiwan.hits.map(({ id }) => id)) === JSON.stringify([taiwan]), '伺服器不擴張為服务器別名', {
      id: 'normalization.no-regional-taiwan', expected: [taiwan], actual: apiTaiwan.hits.map(({ id }) => id),
    });

    const search = page.getByTestId('documents-search');
    const previousSummary = (await page.getByTestId('documents-summary').innerText()).trim();
    await search.fill('\u0085\u00a0　');
    await search.press('Enter');
    await waitFor(async () => new URL(page.url()).searchParams.get('q') !== '台积电', 'Unicode whitespace query applied');
    await waitFor(async () => {
      const summary = (await page.getByTestId('documents-summary').innerText()).trim();
      return summary !== previousSummary && await page.locator('.documents-loading').count() === 0;
    }, 'Unicode whitespace results rendered');
    const whitespaceQuery = new URL(page.url()).searchParams.get('q');
    const whitespaceSummary = (await page.getByTestId('documents-summary').innerText()).trim();
    expect(whitespaceQuery === null, '純 Unicode 空白不留下搜尋 query', {
      id: 'normalization.whitespace-browse-url', expected: null, actual: whitespaceQuery,
    });
    expect(whitespaceSummary === '共 5 份文件', '純 Unicode 空白回到瀏覽摘要', {
      id: 'normalization.whitespace-browse-summary', expected: '共 5 份文件', actual: whitespaceSummary,
    });
    expect(await page.locator('.document-row').count() === 5, '純 Unicode 空白顯示瀏覽列表', {
      id: 'normalization.whitespace-browse-list', expected: 5, actual: await page.locator('.document-row').count(),
    });
    await shot('whitespace-browse');
  });

  await record.scenario('NORM-3', '原文在搜尋與重啟前後不變', async ({ expect, shot }) => {
    const before = await instance.state();
    const rawBefore = JSON.stringify(before.vault.documents);
    await instance.restart({ page });
    await page.getByTestId('page-documents').waitFor();
    const after = await instance.state();
    const result = await instance.api(`/api/search?q=${encodeURIComponent('台积电')}`);
    expect(JSON.stringify(after.vault.documents) === rawBefore, '重啟與搜尋沒有改寫 Vault 原文', {
      id: 'normalization.restart-vault-raw', expected: 'Vault documents byte-equivalent JSON', actual: JSON.stringify(after.vault.documents) === rawBefore,
    });
    expect(result.total === 3, '重啟後同版正規化索引仍可搜尋三份文件', {
      id: 'normalization.restart-search', expected: 3, actual: result.total,
    });
    await page.getByTestId('documents-search').fill('台积电');
    await page.getByTestId('documents-search').press('Enter');
    await waitFor(async () => (await page.getByTestId('documents-summary').innerText()).trim() === `找到 ${result.total} 份`, 'restart UI shows its API result count');
    const summary = (await page.getByTestId('documents-summary').innerText()).trim();
    expect(summary === '找到 3 份', '重啟後 UI 正規化搜尋仍命中三份文件', {
      id: 'normalization.restart-ui-count', expected: '找到 3 份', actual: summary,
    });
    await shot('restart-search');
  });

  await record.scenario('NORM-4', '中文片段連續命中且不以散字拼接', async ({ expect, shot }) => {
    const target = idForTitle('地區詞 A');
    for (const query of ['半導', '導體', '股', '金', '半導體 個股', '"半導體、個股"']) {
      const result = await instance.api(`/api/search?q=${encodeURIComponent(query)}`);
      expect(JSON.stringify(result.hits.map(({ id }) => id)) === JSON.stringify([target]), `${query} 只命中連續片段文件`, {
        id: `fragment.contiguous.${Buffer.from(query).toString('hex')}`, expected: [target], actual: result.hits.map(({ id }) => id),
      });
    }
    const scattered = await instance.api(`/api/search?q=${encodeURIComponent('觀光')}`);
    expect(scattered.total === 0, '觀光不能由直觀與賣光的散字拼成', {
      id: 'fragment.scattered-negative', expected: 0, actual: scattered.total,
    });
    await page.getByTestId('documents-search').fill('導體');
    await page.getByTestId('documents-search').press('Enter');
    await waitFor(async () => (await page.getByTestId('documents-summary').innerText()).trim() === '找到 1 份', 'fragment UI result rendered');
    const row = page.locator('.document-row').filter({ hasText: '地區詞 A' });
    expect((await row.locator('.document-excerpt mark').allInnerTexts()).includes('導體'), '片段摘要標記原文中的導體', {
      id: 'fragment.raw-highlight', expected: ['導體'], actual: await row.locator('.document-excerpt mark').allInnerTexts(),
    });
    await shot('contiguous-fragment');
  });

  // Separate word-boundary competitors from the five normalization documents above.
  const contracts = [
    article('連續片段甲', 'contract', '觀光；半導體、個股與現金流量；離岸設備帶動風電；semiconductor roadmap'),
    article('空白邊界', 'space', '觀 光；半 導；服 器'),
    article('標點邊界', 'punctuation', '觀、光；半、導；服、器'),
    article('觀 半 服', 'fields', '光 導 器'),
    article('導體', 'whole-word', '導體材料'),
    article('單詞競爭者', 'one-word', '離岸設備'),
    article('原文映射', 'raw', '台积电的 ﬃ 與 CoWoS🙂'),
  ];
  // RSS subscribes with a seven-day backfill; dates stay inside that window as the flow ages.
  const pagingDate = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const otherDate = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const paging = Array.from({ length: 21 }, (_, index) => ({
    ...article(`晶片分頁 ${String(index + 1).padStart(2, '0')}`, `page-${index + 1}`, '晶片產業資料'),
    publishedAt: `${pagingDate}T12:00:00.000Z`,
  }));
  await instance.updateCatalog((catalog) => {
    catalog.feeds['/fragment-contract.xml'] = { kind: 'rss2', title: '片段規則 ＡＩ', articles: contracts };
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
    return current.length === 34 ? current : null;
  }, '34 documents for query boundaries and fragment pagination');
  await idle(instance);
  await page.goto(`${instance.url}/documents`);
  await waitFor(async () => (await page.getByTestId('documents-source').locator('option[value=""]').innerText()).includes('34'), 'source counts include all collected fixtures');
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

  await record.scenario('NORM-5', '詞界 AND、引號與欄位邊界，以及 Latin 條件', async ({ expect, shot }) => {
    const target = contractId('連續片段甲');
    const sameSet = (actual, expected) => JSON.stringify(actual) === JSON.stringify([...expected].sort());
    for (const [query, expected] of [
      ['觀光', [target]],
      ['半導', [idForTitle('地區詞 A'), target]],
      ['離岸風電', [target]],
      ['離岸 風電', [target]],
      ['"離岸風電"', []],
      ['"半導體、個股"', [idForTitle('地區詞 A'), target]],
      ['"半導體 個股"', []],
      ['semiconductr', [target]],
      ['semicon', [target]],
      ['semiconductr 半導', [target]],
      ['semicon 半導', [target]],
      ['50', []],
      ['台績電', []],
    ]) {
      const { ui, agent } = await searchApi({ q: query });
      expect(sameSet(sortedIds(ui), expected), `${query} 符合詞界／連續性規則`, {
        id: `query.rules.${Buffer.from(query).toString('hex')}`, expected: [...expected].sort(), actual: sortedIds(ui),
      });
      expect(JSON.stringify(ui) === JSON.stringify(agent), 'UI 與授權 Agent 的完整搜尋回應一致', {
        id: `query.agent.${Buffer.from(query).toString('hex')}`, expected: ui, actual: agent,
      });
    }
    const separate = await instance.api(`/api/search?q=${encodeURIComponent('半 導')}`);
    expect(sortedIds(separate).includes(contractId('觀 半 服')), '顯式空白分成兩個 AND 群組，可各自在不同欄位命中', {
      id: 'query.explicit-and-cross-field', expected: contractId('觀 半 服'), actual: sortedIds(separate),
    });
    const ranked = await instance.api(`/api/search?q=${encodeURIComponent('導體')}`);
    expect(ranked.hits[0]?.id === contractId('導體'), '固定案例的完整詞排在半導體片段之前', {
      id: 'query.whole-word-first', expected: contractId('導體'), actual: ranked.hits.map(({ id }) => id),
    });
    await page.getByTestId('documents-search').fill('觀光');
    await page.getByTestId('documents-search').press('Enter');
    await waitFor(async () => (await page.locator('.document-title').allInnerTexts()).join() === '連續片段甲', 'only contiguous tourism result');
    await shot('word-boundaries');

    await page.getByTestId('documents-search').fill('片段規則 ai');
    await page.getByTestId('documents-search').press('Enter');
    await waitFor(async () => (await page.getByTestId('documents-summary').innerText()).trim() === '找到 7 份', 'normalized publisher matches all seven articles');
    const publisherRow = page.locator('.document-row').filter({ hasText: '連續片段甲' });
    const publisherResult = await instance.api(`/api/search?q=${encodeURIComponent('片段規則 ai')}`);
    expect(publisherResult.hits.every(({ publisher }) => publisher.name === '片段規則 ＡＩ')
      && await publisherRow.locator('.document-excerpt mark').count() === 0, '發布者以正規化文字命中，顯示原名且正文沒有假 mark', {
      id: 'query.raw-publisher-no-body-mark', expected: { publisher: '片段規則 ＡＩ', bodyMarks: 0 },
      actual: { publishers: publisherResult.hits.map(({ publisher }) => publisher.name), bodyMarks: await publisherRow.locator('.document-excerpt mark').count() },
    });
    await shot('publisher-only');

    await page.getByTestId('documents-search').fill('ffi');
    await page.getByTestId('documents-search').press('Enter');
    const rawRow = page.locator('.document-row').filter({ hasText: '原文映射' });
    await waitFor(async () => (await rawRow.locator('.document-excerpt mark').allInnerTexts()).includes('ﬃ'), 'NFKC expansion maps to raw ligature');
    expect((await rawRow.locator('.document-excerpt mark').allInnerTexts()).includes('ﬃ'), 'NFKC 長度變化仍標記原始字元', {
      id: 'query.nfkc-raw-expansion', expected: 'ﬃ', actual: await rawRow.locator('.document-excerpt mark').allInnerTexts(),
    });
    await shot('raw-ligature');
    await rawRow.click();
    await page.getByTestId('reader-body').waitFor();
    const rawBody = await page.getByTestId('reader-body').innerText();
    expect(rawBody.includes('台积电的 ﬃ 與 CoWoS🙂'), 'Reader 保留簡體、連字與 emoji 原文', {
      id: 'query.reader-raw', expected: '台积电的 ﬃ 與 CoWoS🙂', actual: rawBody,
    });
    await shot('raw-reader');
    await page.goto(`${instance.url}/documents`);
  });

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
    await waitFor(async () => (await page.getByTestId('documents-summary').innerText()).trim() === '找到 21 份', 'filtered fragment summary');
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
    await waitFor(async () => (await page.getByTestId('search-index-state').innerText()).includes('就緒'), 'rebuilt index ready');
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
