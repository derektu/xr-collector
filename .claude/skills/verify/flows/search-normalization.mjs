// Search normalization across raw Vault text, API results, UI highlights, browse semantics and restart.
import { idle, subscribe } from '../scripts/lib/index.mjs';

export const name = 'search-normalization';
export const title = '搜尋文字正規化與原文摘要';
export const covers = ['docs-search-normalization'];

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
}
