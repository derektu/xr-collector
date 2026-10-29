// The everyday journey in one pass: subscribe to channel A and add one video through the screens,
// filter and search the documents, read one, pause and resume A from the list, and delete the read
// document after first cancelling. Each step starts from the state the previous one left; data
// writes are checked in the API, the Vault and the search index. Every wait is on a state.
// Unit and HTTP tests hold each step's rule; only the screen shows the steps composing: a
// subscription made in the dialog filling the list, the Documents page and the Reader, and pausing
// and deleting from the screen reaching the data.
import { apiIds, deletedIds, indexIds, sameIds, vaultIds } from './lib/document-ids.mjs';

export const name = 'core-journey';
export const title = '核心旅程：訂閱、新增、查詢、閱讀、暫停恢復與刪除確認';
export const tier = 'core';
export const covers = ['sub-add', 'sub-status', 'sub-pause', 'collect-add', 'collect-done', 'collect-read',
  'docs-list', 'docs-filter', 'docs-search', 'reader-view', 'reader-delete'];

export async function run({ instance, page, record, waitFor }) {
  const by = (id) => page.getByTestId(id);
  const catalog = await instance.catalog();
  const a = catalog.youtube.channels.find((source) => source.handle === 'verify-a');
  const d = catalog.youtube.channels.find((source) => source.handle === 'verify-d');
  const single = d.videos[0];
  const singleId = `youtube:${single.id}`;
  const target = a.videos[2];
  const targetId = `youtube:${target.id}`;
  const targetQuery = '頻道 A 第 3 集';
  const missingQuery = '核心旅程不存在的關鍵詞';
  const row = by(`source-row-${a.id}`);
  const rowStatus = async () => (await row.getByTestId('subscription-status').innerText()).trim();
  const subscription = async () => (await instance.api('/api/subscriptions')).subscriptions.find((entry) => entry.id === a.id);
  const noToast = () => waitFor(async () => (await by('notice').count()) === 0, 'no toast over the page', { timeout: 15_000 });
  /** The state once API, Vault and index hold exactly `ids`. */
  const settledOn = (ids, label) => waitFor(async () => {
    const state = await instance.state();
    return sameIds(apiIds(state), ids) && sameIds(vaultIds(state), ids) && sameIds(indexIds(state), ids) ? state : null;
  }, label);
  let allIds;

  await record.scenario('CORE-1', '經畫面訂閱頻道 A，收完後列顯示下次檢查與 5 份文件', async ({ expect, shot }) => {
    await by('nav-sources').click();
    await by('page-sources').waitFor();
    await by('add-subscription').click();
    await by('add-item-youtube-channel').click();
    await by('add-url').fill(`https://www.youtube.com/@${a.handle}`);
    const confirm = by('add-confirm');
    await waitFor(async () => (await confirm.innerText()).trim() === '訂閱' && await confirm.isEnabled(), 'subscribe enabled', { timeout: 15_000 });
    await confirm.click();
    await by('add-dialog').waitFor({ state: 'detached', timeout: 10_000 });
    const onSources = await by('page-sources').count();
    expect(onSources === 1, '對話框關閉後留在訂閱頁', { id: 'subscribe.stays', expected: 1, actual: onSources });
    await row.waitFor({ timeout: 15_000 });
    await waitFor(async () => (await subscription())?.checkStatus?.state === 'scheduled', 'A scheduled', { timeout: 60_000 });
    const status = await waitFor(async () => { const text = await rowStatus(); return /^下次 /u.test(text) ? text : null; }, 'row shows the next check', { timeout: 15_000 })
      .catch(async () => rowStatus());
    expect(/^下次 /u.test(status), '收完後列的狀態是「下次 HH:MM」', { id: 'subscribe.status', expected: '下次 HH:MM', actual: status });
    const count = (await row.locator('[role="cell"].numeric').innerText()).trim();
    expect(count === String(a.videos.length), `列的文件數是 ${a.videos.length}`, { id: 'subscribe.documents', expected: String(a.videos.length), actual: count });
    await shot('subscribed');
  });

  await record.scenario('CORE-2', '文件頁新增單支影片：收進文件、可閱讀、不建立訂閱', async ({ expect, shot }) => {
    await noToast();
    await by('nav-documents').click();
    await by('page-documents').waitFor();
    await by('add-document').click();
    await by('add-item-url').click();
    await by('add-url').fill(`https://www.youtube.com/watch?v=${single.id}`);
    const confirm = by('add-confirm');
    await waitFor(async () => (await confirm.innerText()).trim() === '加入' && await confirm.isEnabled(), 'add enabled', { timeout: 15_000 });
    await confirm.click();
    await by('add-dialog').waitFor({ state: 'detached', timeout: 10_000 });
    const onDocuments = await by('page-documents').count();
    expect(onDocuments === 1, '加入後留在文件頁', { id: 'collect.stays', expected: 1, actual: onDocuments });
    allIds = [...a.videos.map((video) => `youtube:${video.id}`), singleId].sort();
    const state = await settledOn(allIds, 'A and the single video in API, Vault and index').catch(async () => instance.state());
    expect(sameIds(vaultIds(state), allIds) && sameIds(apiIds(state), allIds) && sameIds(indexIds(state), allIds),
      'API、Vault 與索引都是 A 的 5 份加上單支影片', { id: 'collect.data', expected: allIds, actual: { api: apiIds(state), vault: vaultIds(state), index: indexIds(state) } });
    const subscriptions = (await instance.api('/api/subscriptions')).subscriptions.map((entry) => entry.id);
    expect(!subscriptions.includes(d.id), '單支影片不建立頻道 D 的訂閱', { id: 'collect.no-subscription', expected: `不含 ${d.id}`, actual: subscriptions });
    await waitFor(async () => (await by('documents-summary').innerText()).trim() === `共 ${allIds.length} 份文件`, 'list shows every document', { timeout: 15_000 }).catch(() => undefined);
    const summary = (await by('documents-summary').innerText()).trim();
    expect(summary === `共 ${allIds.length} 份文件`, '文件頁列出全部文件', { id: 'collect.list', expected: `共 ${allIds.length} 份文件`, actual: summary });
    await page.goto(`${instance.url}/documents/${encodeURIComponent(singleId)}`);
    await by('reader-body').waitFor();
    const body = await by('reader-body').innerText();
    expect(body.includes('【合成字幕】'), '單支影片的閱讀頁顯示字幕', { id: 'collect.read', expected: '包含【合成字幕】', actual: body.slice(0, 80) });
    await shot('single-reader');
  });

  await record.scenario('CORE-3', '來源篩選、搜尋無結果與命中', async ({ expect, shot }) => {
    await page.locator('.reader-bar').getByRole('button', { name: '文件', exact: true }).click();
    await by('page-documents').waitFor();
    await by('documents-source').selectOption(`youtube:${a.id}`);
    await waitFor(async () => (await by('documents-summary').innerText()).trim() === `共 ${a.videos.length} 份文件`, 'channel A filter', { timeout: 15_000 }).catch(() => undefined);
    const titles = await page.locator('.document-title').allInnerTexts();
    expect(titles.length === a.videos.length && titles.every((text) => text.includes('頻道 A')), '篩選頻道 A 只列出它的 5 份文件',
      { id: 'filter.channel-a', expected: `${a.videos.length} 份，標題都含「頻道 A」`, actual: titles });
    await by('documents-source').selectOption('');
    await by('documents-search').fill(missingQuery);
    await by('documents-search').press('Enter');
    await by('documents-no-results').waitFor();
    const none = (await by('documents-summary').innerText()).trim();
    expect(none === '找到 0 份', '不存在的詞顯示 0 份', { id: 'search.none', expected: '找到 0 份', actual: none });
    await by('documents-search').fill(targetQuery);
    await by('documents-search').press('Enter');
    await waitFor(async () => (await by('documents-summary').innerText()).trim() === '找到 1 份', 'target found', { timeout: 15_000 }).catch(() => undefined);
    const hrefs = await page.locator('.document-row').evaluateAll((rows) => rows.map((element) => element.getAttribute('href')));
    const api = await instance.api(`/api/search?q=${encodeURIComponent(targetQuery)}`);
    expect(hrefs.length === 1 && decodeURIComponent(hrefs[0] ?? '').endsWith(targetId), '搜尋只列出目標文件',
      { id: 'search.target.rows', expected: [targetId], actual: hrefs });
    expect(api.total === 1 && api.hits[0]?.id === targetId, '搜尋 API 回傳同一份文件',
      { id: 'search.target.api', expected: { total: 1, id: targetId }, actual: { total: api.total, id: api.hits[0]?.id ?? null } });
    const marks = await page.locator('.document-excerpt mark').count();
    expect(marks > 0, '搜尋摘要標出命中內容', { id: 'search.target.highlight', expected: '至少 1 個 mark', actual: marks });
    await shot('search');
  });

  await record.scenario('CORE-4', '從搜尋結果閱讀：內文、發布者與原始來源', async ({ expect, shot }) => {
    await page.locator('.document-row').first().click();
    await by('reader-body').waitFor();
    const body = await by('reader-body').innerText();
    const publisher = by('reader-publisher');
    const publisherText = (await publisher.innerText()).trim();
    const publisherHref = await publisher.getAttribute('href');
    const sourceUrl = await by('reader-source-link').getAttribute('href');
    expect(body.includes('【合成字幕】'), '閱讀頁顯示字幕內文', { id: 'reader.body', expected: '包含【合成字幕】', actual: body.slice(0, 80) });
    expect(publisherText === a.title && publisherHref === `/sources/youtube/${encodeURIComponent(a.id)}`, '發布者是頻道 A，連到它的訂閱詳情',
      { id: 'reader.publisher', expected: { text: a.title, href: `/sources/youtube/${encodeURIComponent(a.id)}` }, actual: { text: publisherText, href: publisherHref } });
    expect(sourceUrl === `https://www.youtube.com/watch?v=${target.id}`, '原始來源連結指向影片',
      { id: 'reader.source-link', expected: `https://www.youtube.com/watch?v=${target.id}`, actual: sourceUrl });
    await shot('reader');
  });

  await record.scenario('CORE-5', '訂閱列表暫停與恢復', async ({ expect, shot }) => {
    await by('nav-sources').click();
    await row.waitFor();
    await noToast();
    await page.getByRole('button', { name: `暫停 ${a.title}`, exact: true }).click();
    await waitFor(async () => (await subscription())?.status === 'paused', 'API paused', { timeout: 15_000 }).catch(() => undefined);
    await waitFor(async () => (await rowStatus()) === '已暫停', 'row paused', { timeout: 15_000 }).catch(() => undefined);
    const paused = { api: (await subscription())?.status, row: await rowStatus() };
    expect(paused.api === 'paused' && paused.row === '已暫停', '暫停後 API 與列都是已暫停', { id: 'pause.paused', expected: { api: 'paused', row: '已暫停' }, actual: paused });
    await shot('paused');
    await noToast();
    await row.getByRole('button', { name: '恢復', exact: true }).click();
    await waitFor(async () => (await subscription())?.checkStatus?.state === 'scheduled' && (await subscription())?.status !== 'paused', 'A resumed and checked', { timeout: 60_000 }).catch(() => undefined);
    await waitFor(async () => /^下次 /u.test(await rowStatus()), 'row scheduled', { timeout: 15_000 }).catch(() => undefined);
    const resumed = { api: (await subscription())?.status, row: await rowStatus() };
    expect(resumed.api !== 'paused' && /^下次 /u.test(resumed.row), '恢復後檢查完成，列回到「下次 HH:MM」', { id: 'pause.resumed', expected: { api: '不是 paused', row: '下次 HH:MM' }, actual: resumed });
    const pauseButton = await page.getByRole('button', { name: `暫停 ${a.title}`, exact: true }).count();
    expect(pauseButton === 1, '列上回到暫停按鈕', { id: 'pause.button-back', expected: 1, actual: pauseButton });
  });

  await record.scenario('CORE-6', '閱讀頁刪除：取消保留，確認後只少這一份', async ({ expect, shot }) => {
    await page.goto(`${instance.url}/documents/${encodeURIComponent(targetId)}`);
    await by('reader-body').waitFor();
    const dialog = by('confirm-delete-document');
    await by('reader-delete').click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const kept = { reader: await by('reader-body').count(), api: apiIds(await instance.state()).includes(targetId) };
    expect(kept.reader === 1 && kept.api, '取消後仍在閱讀頁，文件還在', { id: 'delete.cancel', expected: { reader: 1, api: true }, actual: kept });
    await by('reader-delete').click();
    await dialog.waitFor();
    await shot('delete-confirm');
    await dialog.getByRole('button', { name: '刪除', exact: true }).click();
    await by('page-documents').waitFor();
    const remaining = allIds.filter((id) => id !== targetId);
    const state = await settledOn(remaining, 'only the target removed from API, Vault and index').catch(async () => instance.state());
    expect(sameIds(apiIds(state), remaining) && sameIds(vaultIds(state), remaining) && sameIds(indexIds(state), remaining),
      'API、Vault 與索引只少了刪除的文件', { id: 'delete.data', expected: remaining, actual: { api: apiIds(state), vault: vaultIds(state), index: indexIds(state) } });
    const ledger = deletedIds(state);
    expect(ledger?.includes(targetId) === true, '刪除紀錄有這份文件', { id: 'delete.ledger', expected: [targetId], actual: ledger });
    await shot('deleted');
  });
}
