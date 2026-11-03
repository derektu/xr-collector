import path from 'node:path';
import { stubDialogs } from '../scripts/lib/index.mjs';

export const name = 'vault-actions';
export const title = '知識庫操作列與桌面入口';
export const covers = ['vault-actions', 'vault-native-dialogs'];
export const desktop = true;

// Every check reads the page, the API and the stubbed native calls, so the flow runs with the window hidden.
export async function run({ instance, page, record, waitFor }) {
  const button = (id) => page.getByTestId(id);
  await button('nav-settings').click();
  await button('vault-reveal').waitFor();
  await record.scenario('VAULT-D1', '操作順序、Finder 與原生選檔入口', async ({ expect, themed }) => {
    const ids = ['vault-create', 'vault-open-other', 'vault-reveal', 'vault-import', 'vault-export'];
    const order = await button('settings-vault').locator('button').evaluateAll((buttons) => buttons.map((item) => item.dataset.testid));
    expect(JSON.stringify(order) === JSON.stringify(ids), '桌面操作順序與 Tab 順序一致', { expected: ids, actual: order });
    await instance.app.evaluate(({ shell }) => {
      globalThis.__vaultRevealPaths = [];
      shell.showItemInFolder = (file) => { globalThis.__vaultRevealPaths.push(file); };
    });
    await button('vault-reveal').click();
    await waitFor(async () => await instance.app.evaluate(() => globalThis.__vaultRevealPaths.length) === 1, 'reveal handler');
    const revealed = await instance.app.evaluate(() => globalThis.__vaultRevealPaths);
    const vault = await instance.api('/api/vault/status');
    expect(revealed[0] === vault.vaultPath, 'Finder 入口交給原生 shell 的是目前 Vault', { expected: vault.vaultPath, actual: revealed });
    await stubDialogs(instance.app, {});
    await button('vault-open-other').click();
    await waitFor(async () => await instance.app.evaluate(() => globalThis.__dialogCalls.length) === 1, 'open-vault dialog');
    await button('vault-import').click();
    await button('vault-export').click();
    await waitFor(async () => await instance.app.evaluate(() => globalThis.__dialogCalls.length) === 3, 'native file dialogs');
    const calls = await instance.app.evaluate(() => globalThis.__dialogCalls.map((call) => ({ kind: call.kind, defaultPath: call.options.defaultPath })));
    const kinds = calls.map((call) => call.kind);
    expect(JSON.stringify(kinds) === JSON.stringify(['open', 'open', 'save']), '開啟既有、匯入、匯出分別呼叫原生開啟／開啟／儲存對話框', { expected: ['open', 'open', 'save'], actual: calls });
    expect(calls[0].defaultPath === path.dirname(vault.vaultPath),
      '開啟既有知識庫的選擇器從目前知識庫的上一層開始', { expected: { defaultPath: path.dirname(vault.vaultPath) }, actual: calls[0] });
    const opened = await button('open-vault-dialog').count();
    expect(opened === 0, '取消選擇不開對話框', { expected: 0, actual: opened });
    await themed('vault-actions-desktop');
  });
}
