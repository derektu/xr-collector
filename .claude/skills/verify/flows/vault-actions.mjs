import path from 'node:path';
import { stubDialogs } from '../scripts/lib/index.mjs';

export const name = 'vault-actions';
export const title = '知識庫操作列與桌面入口';
export const tier = 'platform';
export const covers = ['vault-actions', 'vault-native-dialogs'];
export const desktop = true;

export async function run({ instance, page, record, waitFor }) {
  const button = (id) => page.getByTestId(id);
  const resize = async (width) => {
    await instance.app.evaluate(({ BrowserWindow }, { origin, width }) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith(origin));
      window.setContentSize(width, 900);
    }, { origin: instance.url, width });
    await waitFor(async () => await page.evaluate(() => window.innerWidth) === width, `viewport ${width}`);
  };
  await button('nav-settings').click();
  await button('vault-reveal').waitFor();
  await record.scenario('VAULT-D1', '一般寬度同排，Finder 與原生選檔入口正常', async ({ expect, themed }) => {
    const ids = ['vault-create', 'vault-open-other', 'vault-reveal', 'vault-import', 'vault-export'];
    const order = await button('settings-vault').locator('button').evaluateAll((buttons) => buttons.map((item) => item.dataset.testid));
    expect(JSON.stringify(order) === JSON.stringify(ids), '桌面操作順序與 Tab 順序一致', { expected: ids, actual: order });
    const frames = await Promise.all(ids.map((id) => button(id).boundingBox()));
    expect(frames.every((frame) => frame && Math.abs(frame.y - frames[0].y) < 1), '一般寬度五個操作同一排', { expected: 'same row', actual: frames });
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
    const calls = await instance.app.evaluate(() => globalThis.__dialogCalls.map((call) => ({ kind: call.kind, title: call.options.title, defaultPath: call.options.defaultPath })));
    const kinds = calls.map((call) => call.kind);
    expect(JSON.stringify(kinds) === JSON.stringify(['open', 'open', 'save']), '開啟既有、匯入、匯出分別呼叫原生開啟／開啟／儲存對話框', { expected: ['open', 'open', 'save'], actual: calls });
    expect(calls[0].title === '選擇知識庫資料夾' && calls[0].defaultPath === path.dirname(vault.vaultPath),
      '開啟既有知識庫的選擇器從目前知識庫的上一層開始', { expected: { title: '選擇知識庫資料夾', defaultPath: path.dirname(vault.vaultPath) }, actual: calls[0] });
    expect(!(await button('open-vault-dialog').isVisible()), '取消選擇不開對話框');
    await themed('vault-actions-desktop');
  });
  await record.scenario('VAULT-D2', '最小視窗可換行且沒有水平溢出', async ({ expect, shot }) => {
    await resize(880);
    const size = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth }));
    expect(size.content <= size.viewport, '窄視窗不水平溢出', { expected: size.viewport, actual: size.content });
    for (const id of ['vault-create', 'vault-open-other', 'vault-reveal', 'vault-import', 'vault-export']) {
      const frame = await button(id).boundingBox();
      expect(frame && frame.x >= 0 && frame.x + frame.width <= size.viewport, `${id} 仍在可見範圍`, { expected: 'inside viewport', actual: frame });
    }
    await shot('vault-actions-narrow');
    await resize(1280);
  });
}
