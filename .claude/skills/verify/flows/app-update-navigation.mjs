import { defaultCatalog } from '../scripts/lib/synthetic.mjs';

export const name = 'app-update-navigation';
export const title = '側欄與原生更新入口定位到設定中的 App 更新區';
export const covers = ['update-navigation'];
export const vault = 'selected';
export const catalog = () => ({ ...defaultCatalog(), updates: { enabled: true, version: '0.1.1', payloadMode: 'valid', payloadDelayMs: 0 } });

export async function run({ instance, page, record, waitFor }) {
  await record.scenario('U36-W4', '已開啟 Vault 時側欄與原生更新入口等待面板掛載後定位', async ({ expect, shot }) => {
    await page.goto(`${instance.url}/documents`);
    await page.getByTestId('sidebar-update').waitFor();
    await page.getByTestId('sidebar-update').click();
    await page.getByTestId('software-update').waitFor();
    await waitFor(() => panelIsInViewport(page), 'sidebar update panel in viewport', { timeout: 8_000 });
    expect(await panelIsInViewport(page), '側欄版本狀態開啟設定並把 App 更新區帶進可視範圍', { id: 'u36.sidebar-update-navigation' });
    await page.getByTestId('nav-documents').click();
    await page.getByTestId('nav-settings').click();
    expect(await page.locator('main.content').evaluate((element) => element.scrollTop === 0),
      '普通設定入口維持頁首，不沿用更新入口的定位要求', { id: 'u36.ordinary-settings-position' });

    await page.addInitScript(() => {
      let navigate;
      window.xrCollectorDesktop = {
        chooseDirectory: async () => null, chooseExportFile: async () => null, chooseImportFile: async () => null,
        revealVault: async () => undefined, revealExport: async () => undefined, platform: 'darwin',
        onNavigate: (listener) => { navigate = listener; },
      };
      window.__verifyOpenUpdate = () => navigate?.('update');
    });
    await page.goto(`${instance.url}/documents`);
    await page.evaluate(() => window.__verifyOpenUpdate());
    await page.getByTestId('software-update').waitFor();
    await waitFor(() => panelIsInViewport(page), 'native update panel in viewport', { timeout: 8_000 });
    expect(await panelIsInViewport(page), '選單列／系統匣的 update 導覽訊號等待面板掛載後定位', { id: 'u36.native-update-navigation' });
    await shot('update-panel-navigation');
  });
}

async function panelIsInViewport(page) {
  return await page.getByTestId('software-update').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  }).catch(() => false);
}
