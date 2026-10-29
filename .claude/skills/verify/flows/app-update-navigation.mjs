import { defaultCatalog } from '../scripts/lib/synthetic.mjs';

export const name = 'app-update-navigation';
export const title = '側欄與原生更新入口定位到設定中的 App 更新區';
export const tier = 'feature';
export const covers = ['update-navigation'];
export const vault = 'selected';
export const catalog = () => ({ ...defaultCatalog(), updates: { enabled: true, version: '0.1.1', payloadMode: 'valid', payloadDelayMs: 0 } });

export async function run({ instance, page, record, waitFor }) {
  await record.scenario('U36-W4', '已開啟 Vault 時側欄與原生更新入口等待面板掛載後定位', async ({ expect, shot }) => {
    await page.goto(`${instance.url}/documents`);
    await page.getByTestId('sidebar-update').waitFor();
    expect(await sidebarLabel(page) === 'v0.1.0', '尚未發現更新時側欄只顯示版本', {
      id: 'u36.sidebar-idle', expected: 'v0.1.0', actual: await sidebarLabel(page),
    });
    await page.getByTestId('sidebar-update').click();
    await page.getByTestId('software-update').waitFor();
    await waitFor(() => panelIsInViewport(page), 'sidebar update panel in viewport', { timeout: 8_000 });
    expect(await panelIsInViewport(page), '側欄版本狀態開啟設定並把 App 更新區帶進可視範圍', { id: 'u36.sidebar-update-navigation' });
    await page.getByTestId('nav-documents').click();
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('software-update').waitFor();
    await page.getByTestId('search-index-state').waitFor();
    await page.getByTestId('login-startup-status').waitFor();
    await page.getByTestId('agent-active-url').waitFor();
    expect(await page.locator('main.content').evaluate((element) => element.scrollTop === 0),
      '普通設定入口維持頁首，不沿用更新入口的定位要求', { id: 'u36.ordinary-settings-position' });

    await page.addInitScript(() => {
      let navigate;
      let readyCalled = false;
      window.xrCollectorDesktop = {
        chooseDirectory: async () => null, chooseExportFile: async () => null, chooseImportFile: async () => null,
        revealVault: async () => undefined, revealExport: async () => undefined, platform: 'darwin',
        onNavigate: (listener) => { navigate = listener; },
        ready: () => { readyCalled = true; },
      };
      window.__verifyDesktopReady = () => readyCalled && typeof navigate === 'function';
      window.__verifyOpenUpdate = () => {
        if (!readyCalled || typeof navigate !== 'function') throw new Error('Desktop navigation handshake is not ready');
        navigate('update');
      };
    });
    const delayedSettingsRequests = /\/api\/(?:search\/status|device\/login-startup)$/u;
    const heldSettings = new Set();
    let releaseVault;
    let releaseSettings;
    let releaseAgent;
    let vaultHeld = false;
    let agentHeld = false;
    const vaultGate = new Promise((resolve) => { releaseVault = resolve; });
    const settingsGate = new Promise((resolve) => { releaseSettings = resolve; });
    const agentGate = new Promise((resolve) => { releaseAgent = resolve; });
    const holdVault = async (route) => { vaultHeld = true; await vaultGate; await route.continue(); };
    const holdSettings = async (route) => {
      heldSettings.add(new URL(route.request().url()).pathname);
      await settingsGate;
      await route.continue();
    };
    const holdAgent = async (route) => { agentHeld = true; await agentGate; await route.continue(); };
    await page.route('**/api/vault/setup', holdVault);
    await page.route(delayedSettingsRequests, holdSettings);
    await page.route('**/api/device/agent', holdAgent);
    try {
      await page.goto(`${instance.url}/documents`);
      await waitFor(() => page.evaluate(() => window.__verifyDesktopReady()), 'desktop navigation handshake', { timeout: 8_000 });
      expect(await page.evaluate(() => window.__verifyDesktopReady()), 'renderer 完成註冊導覽 listener 後向 preload 回報 ready', {
        id: 'u36.native-navigation-handshake', expected: true, actual: await page.evaluate(() => window.__verifyDesktopReady()),
      });
      await waitFor(() => vaultHeld, 'Vault setup request held', { timeout: 8_000 });
      await page.evaluate(() => window.__verifyOpenUpdate());
      releaseVault();
      await page.getByTestId('software-update').waitFor();
      await waitFor(() => heldSettings.size === 2 && agentHeld, 'Settings async requests held', { timeout: 8_000 });
      await waitFor(() => panelIsInViewport(page), 'native update panel initially in viewport', { timeout: 8_000 });
      releaseSettings();
      await page.getByTestId('search-index-state').waitFor();
      await page.getByTestId('login-startup-status').waitFor();
      await waitFor(() => panelIsInViewport(page), 'native update panel stable after Settings layout', { timeout: 8_000 });
      expect(await panelIsInViewport(page), '選單列／系統匣的 update 導覽訊號在 Vault 與上方設定載入後仍保持面板可見', { id: 'u36.native-update-navigation' });
      await shot('update-panel-navigation');

      const content = page.locator('main.content');
      await content.hover();
      await page.mouse.wheel(0, -10_000);
      await waitFor(() => content.evaluate((element) => element.scrollTop === 0), 'manual scroll returns to Settings top', { timeout: 8_000 });
      releaseAgent();
      await page.getByTestId('agent-active-url').waitFor();
      expect(await content.evaluate((element) => element.scrollTop === 0), '使用者離開更新區後，上方卡片延遲載入不會搶回捲動位置', {
        id: 'u36.native-navigation-yields-to-user', expected: 0, actual: await content.evaluate((element) => element.scrollTop),
      });
    } finally {
      releaseVault?.();
      releaseSettings?.();
      releaseAgent?.();
      await page.unroute('**/api/vault/setup', holdVault);
      await page.unroute(delayedSettingsRequests, holdSettings);
      await page.unroute('**/api/device/agent', holdAgent);
    }
  });

  await record.scenario('U36-W5', '側欄只顯示目前真正的更新動作', async ({ expect, shot }) => {
    await instance.api('/api/device/updates/check', { method: 'POST' });
    await waitFor(async () => await sidebarLabel(page) === 'v0.1.0 · 有新版本', 'sidebar available label', { timeout: 8_000 });
    expect(await sidebarLabel(page) === 'v0.1.0 · 有新版本', '確定有 offer 後才提示新版本', {
      id: 'u36.sidebar-available', expected: 'v0.1.0 · 有新版本', actual: await sidebarLabel(page),
    });

    await instance.updateCatalog((value) => { value.updates.payloadDelayMs = 10_000; });
    await page.getByTestId('update-download').click();
    await waitFor(async () => await sidebarLabel(page) === 'v0.1.0 · 下載中', 'sidebar downloading label', { timeout: 8_000 });
    expect(await sidebarLabel(page) === 'v0.1.0 · 下載中', '下載時顯示下載中', {
      id: 'u36.sidebar-downloading', expected: 'v0.1.0 · 下載中', actual: await sidebarLabel(page),
    });
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-download').waitFor();

    await instance.updateCatalog((value) => { value.updates.payloadDelayMs = 0; });
    await page.getByTestId('update-download').click();
    await page.getByTestId('update-apply').waitFor();
    expect(await sidebarLabel(page) === 'v0.1.0 · 可安裝', '驗證完成後顯示可安裝', {
      id: 'u36.sidebar-ready', expected: 'v0.1.0 · 可安裝', actual: await sidebarLabel(page),
    });
    await shot('sidebar-ready');

    await page.getByTestId('update-apply').click();
    await page.getByTestId('update-cancel').waitFor();
    expect(await sidebarLabel(page) === 'v0.1.0 · 等待安裝', '等待安全停止時顯示等待安裝', {
      id: 'u36.sidebar-waiting', expected: 'v0.1.0 · 等待安裝', actual: await sidebarLabel(page),
    });
    await shot('sidebar-waiting');
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-apply').waitFor();
  });
}

async function sidebarLabel(page) {
  return (await page.getByTestId('sidebar-update').innerText()).trim();
}

async function panelIsInViewport(page) {
  return await page.getByTestId('software-update').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  }).catch(() => false);
}
