// The build a user runs, as Settings shows it: the version and kind on the card are the ones the
// device API reports, the API names the checkout under test, and a failed read can be retried from
// the card. Without it a user or a bug report names the wrong build. The API serving one identity to the UI and an authorized Agent, before a
// Vault is chosen too, is in tests/server/build-info-http.test.ts.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const name = 'build-info';
export const title = '設定頁顯示裝置 API 的版本與種類，讀取失敗可重試';
export const covers = ['build-info-settings', 'build-info-api'];

export async function run({ instance, page, record, waitFor }) {
  const card = page.getByTestId('build-info');
  /** The card's version and kind once it loaded, or what it shows when the wait gives up. */
  const shownCard = async () => {
    await waitFor(async () => await card.getByTestId('build-info-kind').count() === 1, 'build info card loaded').catch(() => undefined);
    return {
      version: (await card.getByTestId('build-info-version').innerText().catch(() => null))?.trim() ?? null,
      kind: await card.getByTestId('build-info-kind').getAttribute('data-kind').catch(() => null),
    };
  };

  await record.scenario('BINFO-W1', '設定頁的版本與種類就是裝置 API 回報的受測 build', async ({ expect, themed }) => {
    await page.getByTestId('nav-settings').click();
    const info = (await instance.api('/api/device/build-info')).buildInfo;
    const pkg = JSON.parse(await readFile(path.join(instance.checkout, 'package.json'), 'utf8'));
    const identity = { version: info.version, commit: info.commit, kind: info.kind };
    const wanted = { version: pkg.version, commit: instance.commit, kind: 'development' };
    expect(JSON.stringify(identity) === JSON.stringify(wanted), '裝置 API 回報受測 checkout 的版本與 commit',
      { id: 'settings.source-identity', expected: wanted, actual: identity });
    const shown = await shownCard();
    expect(shown.version === info.version && shown.kind === info.kind, '設定頁卡片的版本與種類與裝置 API 相同',
      { id: 'settings.card', expected: { version: info.version, kind: info.kind }, actual: shown });
    await card.scrollIntoViewIfNeeded();
    await themed('settings');
  });

  await record.scenario('BINFO-W3', '讀取失敗時卡片提供重試，重試後顯示裝置 API 的版本與種類', async ({ expect, shot }) => {
    const info = (await instance.api('/api/device/build-info')).buildInfo;
    const route = '**/api/device/build-info';
    await page.route(route, (request) => request.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: '驗收注入建置資訊讀取失敗' } }),
    }));
    try {
      await page.reload();
      const alert = card.getByRole('alert');
      await alert.waitFor();
      const failed = { alert: await alert.count(), retry: await alert.getByRole('button', { name: '重試' }).count(), kind: await card.getByTestId('build-info-kind').count() };
      expect(failed.alert === 1 && failed.retry === 1 && failed.kind === 0, '讀取失敗時卡片顯示錯誤與重試，不顯示版本',
        { id: 'retry.error', expected: { alert: 1, retry: 1, kind: 0 }, actual: failed });
      await shot('read-error');
      await page.unroute(route);
      await alert.getByRole('button', { name: '重試' }).click();
      const restored = await shownCard();
      expect(restored.version === info.version && restored.kind === info.kind, '重試後卡片顯示裝置 API 的版本與種類',
        { id: 'retry.restored', expected: { version: info.version, kind: info.kind }, actual: restored });
      await shot('retry-restored');
    } finally { await page.unroute(route); }
  });
}
