// Removing a subscription keeps its documents unless the user asks otherwise: cancelling changes
// nothing, the confirmation starts on "keep", and once confirmed the row goes while every document
// stays in the API, the Vault and the search index and still opens in the Reader. The HTTP tests
// prove the API keeps documents when asked to; only the screen shows which choice the dialog
// starts on, that cancelling sends nothing, and how the Documents page and the Reader present
// documents whose subscription is gone. Removing and deleting, and removal while a check runs, are
// covered by tests/sources/ and the HTTP tests.
import { idle, subscribe } from '../scripts/lib/seed.mjs';
import { apiIds, deletedIds, indexIds, sameIds, vaultIds } from './lib/document-ids.mjs';
import { recordRequests, screenAt } from './lib/revision.mjs';

export const name = 'subscription-remove';
export const title = '移除訂閱：取消、預設保留文件、確認後文件仍可閱讀';
export const covers = ['sub-remove', 'docs-filter', 'reader-view'];

export async function run({ instance, page, record, waitFor }) {
  const by = (id) => page.getByTestId(id);
  await subscribe(instance, `${instance.feedsOrigin}/feed.xml`);
  await idle(instance);
  const feed = (await instance.api('/api/subscriptions')).subscriptions.find((entry) => entry.type === 'rss');
  const before = await waitFor(async () => {
    const state = await instance.state();
    const ids = vaultIds(state);
    return ids.length === feed.documentCount && ids.length > 0 && sameIds(apiIds(state), ids) && sameIds(indexIds(state), ids) ? state : null;
  }, 'feed documents in API, Vault and index');
  const ids = vaultIds(before);
  const ledgerBefore = deletedIds(before) ?? [];
  const row = by(`source-row-${feed.id}`);
  const dialog = by('confirm-remove');
  // The dialog states the document count the list shows, so the list must show every document first.
  // A revision read right after the last save can still precede it: the server publishes a round of
  // changes once the round ends, so the list's count is the state to wait for.
  const openRemove = async () => {
    await screenAt(page, instance);
    await waitFor(async () => (await row.locator('.numeric').innerText()).trim() === String(ids.length), `list shows ${ids.length} documents`);
    await waitFor(async () => (await by('notice').count()) === 0, 'no toast over the page', { timeout: 15_000 });
    await page.getByRole('button', { name: `${feed.title} 的更多動作`, exact: true }).click();
    await page.getByRole('menuitem', { name: '移除', exact: true }).click();
    await dialog.waitFor();
  };
  const listed = async () => (await instance.api('/api/subscriptions')).subscriptions.some((entry) => entry.id === feed.id);

  await by('nav-sources').click();
  await row.waitFor();

  await record.scenario('REMOVE-1', '取消移除：列、訂閱與文件都不變', async ({ expect, shot }) => {
    await openRemove();
    const choices = {
      keep: await by('remove-keep').isChecked(), delete: await by('remove-delete').isChecked(), documents: Number(await dialog.getAttribute('data-documents')),
    };
    const expected = { keep: true, delete: false, documents: ids.length };
    expect(JSON.stringify(choices) === JSON.stringify(expected), '確認框預設勾選保留文件，並寫出份數', { id: 'remove.default-keep', expected, actual: choices });
    await shot('confirm');
    const removals = recordRequests(page, 'DELETE', '/api/subscriptions/');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const sent = await removals.sent();
    removals.stop();
    const state = await instance.state();
    const after = { sent, row: await row.count(), subscribed: await listed(), documents: sameIds(vaultIds(state), ids) && sameIds(apiIds(state), ids) && sameIds(indexIds(state), ids) };
    expect(sent.length === 0 && after.row === 1 && after.subscribed && after.documents, '取消不送出移除，列還在、仍訂閱、文件不變', {
      id: 'remove.cancel', expected: { sent: [], row: 1, subscribed: true, documents: true }, actual: after,
    });
  });

  await record.scenario('REMOVE-2', '以預設確認移除：列消失，文件留在 API、Vault 與索引', async ({ expect, shot }) => {
    await openRemove();
    await by('confirm-remove-button').click();
    await dialog.waitFor({ state: 'detached', timeout: 15_000 });
    await row.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
    const notice = await by('notice').getAttribute('data-tone', { timeout: 5_000 }).catch(() => null);
    expect(notice === 'ok', '顯示移除成功的提示', { id: 'remove.notice', expected: 'ok', actual: notice });
    const gone = { row: await row.count(), subscribed: await listed() };
    expect(gone.row === 0 && !gone.subscribed, '列消失，API 不再有這個訂閱', { id: 'remove.gone', expected: { row: 0, subscribed: false }, actual: gone });
    const state = await instance.state();
    const stored = state.vault.files?.['settings/rss-subscriptions.json'];
    const file = { subscribed: stored?.subscriptions?.some((entry) => entry.id === feed.id) ?? null, removed: stored?.removed?.some((entry) => entry.id === feed.id) ?? null };
    expect(file.subscribed === false && file.removed === true, 'Vault 的訂閱檔不再訂閱它，並記下移除', {
      id: 'remove.vault-subscription', expected: { subscribed: false, removed: true }, actual: stored ? file : 'rss-subscriptions.json 不存在',
    });
    const kept = { api: apiIds(state), vault: vaultIds(state), index: indexIds(state) };
    expect(sameIds(kept.api, ids) && sameIds(kept.vault, ids) && sameIds(kept.index, ids), '文件在 API、Vault 與索引一份不少', {
      id: 'remove.documents-kept', expected: ids, actual: kept,
    });
    const ledger = deletedIds(state) ?? [];
    expect(sameIds(ledger, ledgerBefore), '沒有新增刪除紀錄', { id: 'remove.no-deletion-record', expected: ledgerBefore, actual: ledger });
    await shot('removed');
  });

  await record.scenario('REMOVE-3', '文件頁標示已移除的來源，文件仍可閱讀', async ({ expect, shot }) => {
    await by('nav-documents').click();
    await by('page-documents').waitFor();
    // The options come with the first page of documents; wait for that page, not for the option under test.
    const summary = by('documents-summary');
    await waitFor(async () => await summary.getAttribute('data-loading') === 'false' && await summary.getAttribute('data-total') === String(ids.length),
      'documents listed', { timeout: 15_000 }).catch(() => undefined);
    const value = `rss:${feed.id}`;
    const source = (await instance.api('/api/documents/sources')).sources?.groups?.flatMap((group) => group.publishers).find((entry) => entry.id === feed.id) ?? null;
    const option = await by('documents-source').locator(`option[value="${value}"]`).count();
    expect(option === 1 && source?.removed === true && source.count === ids.length, '來源選項列出已移除的訂閱，API 標示已移除與份數',
      { id: 'remove.source-option', expected: { option: 1, removed: true, count: ids.length }, actual: { option, removed: source?.removed ?? null, count: source?.count ?? null } });
    if (option !== 1) return;
    await by('documents-source').selectOption(value);
    await waitFor(async () => (await page.locator('.document-row').count()) === ids.length, 'removed source lists its documents', { timeout: 15_000 }).catch(() => undefined);
    const rows = await page.locator('.document-row').count();
    expect(rows === ids.length, '篩選已移除的來源列出全部文件', { id: 'remove.filter', expected: ids.length, actual: rows });
    await page.locator('.document-row').first().click();
    await by('reader-body').waitFor();
    const body = await by('reader-body').innerText();
    const publisher = { text: (await by('reader-publisher').innerText()).trim(), href: await by('reader-publisher').getAttribute('href') };
    expect(body.includes('【合成文章】'), '文件仍可閱讀', { id: 'remove.reader', expected: '包含【合成文章】', actual: body.slice(0, 80) });
    expect(publisher.text === feed.title && publisher.href === null, '發布者顯示名稱，不再連到已移除的訂閱', {
      id: 'remove.publisher', expected: { text: feed.title, href: null }, actual: publisher,
    });
    await shot('reader');
  });
}
