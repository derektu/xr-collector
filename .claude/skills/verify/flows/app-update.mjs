// App updates through the shared update service: checking without a Vault from the UI and an
// authorized Agent, downloading with only cancel offered and install refused until the download
// finishes, a failed download never offering an install and showing a short reason while the API keeps
// the updater's words, a ready update kept beside a newer offer,
// the sidebar and the native menu reaching the update panel once a Vault exists, and an install that
// the next start records as installed. A broken update path leaves users on an old build or
// installs a version they did not choose.
import { defaultCatalog } from '../scripts/lib/synthetic.mjs';

export const name = 'app-update';
export const title = 'App 更新的查詢、下載、取消、安裝紀錄與更新入口';
export const covers = ['update-discovery', 'update-download', 'update-install', 'update-agent', 'update-no-vault', 'update-navigation'];
export const vault = 'none';
export const catalog = () => ({ ...defaultCatalog(), updates: { enabled: true, version: '0.1.1', currentVersion: '0.1.0', payloadMode: 'valid' } });

export async function run({ instance, page, record, waitFor }) {
  const connection = (await instance.api('/api/device/agent/connection')).connection;
  const agent = async (pathname, init = {}) => {
    const response = await fetch(`${connection.url}${pathname}`, { ...init, headers: {
      authorization: `Bearer ${connection.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}),
    } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const update = async () => (await instance.api('/api/device/updates')).update;
  const selection = (offer) => JSON.stringify({ version: offer.version });
  let updateApiAvailable = false;

  await record.scenario('U36-W1', '未建立 Vault 時 UI 與授權 Agent 都可檢查更新來源', async ({ expect, shot, note }) => {
    let initialApi;
    try { initialApi = await instance.api('/api/device/updates'); } catch (error) { initialApi = { error: String(error) }; }
    updateApiAvailable = Boolean(initialApi?.update);
    expect(updateApiAvailable, '裝置更新 API 已由產品提供', { id: 'u36.update-api', actual: initialApi });
    if (!updateApiAvailable) return;
    await page.goto(`${instance.url}/settings`);
    await page.getByTestId('update-check').waitFor();
    const setup = (await instance.api('/api/vault/setup')).vault.state;
    expect(await page.getByTestId('device-settings-without-vault').isVisible() && await page.getByTestId('update-check').isVisible(),
      '未建立 Vault 仍可進入裝置更新設定並檢查更新', { id: 'u36.no-vault-ui', expected: { vault: '不是 ready', check: true }, actual: setup });
    const checked = await agent('/api/device/updates/check', { method: 'POST' });
    expect(checked.status === 200 && checked.body.update.phase === 'available' && checked.body.update.offer?.version === '0.1.1',
      '授權 Agent 經相同 API 找到 0.1.1', {
        id: 'u36.agent-check', actual: { status: checked.status, phase: checked.body?.update?.phase, version: checked.body?.update?.offer?.version },
      });
    await waitFor(async () => await page.getByTestId('update-download').isVisible(), 'available update UI').catch(() => undefined);
    expect(await page.getByTestId('update-download').isVisible(), 'Agent 檢查到的更新出現在畫面的下載入口', { id: 'u36.ui-follows-check' });
    await shot('available-no-vault');
    note('scope', 'Web 使用真實 UpdateService；fixture updater 照 electron-updater 的方式讀合成的 latest-mac.yml 與 payload，不證明原生安裝。');
  });
  // A reverse baseline without the update API stops on the product-contract assertion above; it does
  // not spend time waiting for controls that correctly do not exist in that older checkout.
  if (!updateApiAvailable) return;

  await record.scenario('U36-W2', '下載中只顯示取消、拒絕安裝，下載失敗不提供安裝，重試後可安裝', async ({ expect, shot }) => {
    // The payload stops after 62 % of its bytes until the flow releases it, so the download stays under way.
    await instance.updateCatalog((value) => { value.updates.holdPayload = true; value.updates.payloadMode = 'valid'; });
    await page.getByTestId('update-download').click();
    await page.getByTestId('update-cancel').waitFor();
    const actions = { download: await page.getByTestId('update-download').count(), cancel: await page.getByTestId('update-cancel').count() };
    expect(actions.download === 0 && actions.cancel === 1, '下載中不再顯示重複下載，只能取消下載',
      { id: 'u36.downloading-actions', expected: { download: 0, cancel: 1 }, actual: actions });
    const downloading = await waitFor(async () => {
      const value = await update();
      return value.progress?.percent === 62 && (await instance.held()).payload ? value : null;
    }, 'download held at 62 %').catch(update);
    expect(downloading.phase === 'downloading' && downloading.progress?.percent === 62, '下載回報 62% 進度', {
      id: 'u36.progress', actual: { phase: downloading.phase, progress: downloading.progress },
    });
    const refused = await agent('/api/device/updates/apply', { method: 'POST', body: selection(downloading.offer) });
    expect(refused.status === 409 && refused.body?.error?.code === 'update_not_ready', '下載中由授權 Agent 安裝會拒絕為 update_not_ready', {
      id: 'u36.agent-not-ready', actual: { status: refused.status, code: refused.body?.error?.code },
    });
    await shot('downloading');
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-download').waitFor();
    expect((await update()).phase === 'available', '取消後回到同一版本，沒有可安裝的更新', { id: 'u36.download-cancel' });

    await instance.updateCatalog((value) => { value.updates.holdPayload = false; value.updates.payloadMode = 'corrupt'; });
    await page.getByTestId('update-download').click();
    await waitFor(async () => (await update()).phase === 'error', 'download error state');
    await waitFor(async () => await page.getByTestId('update-download').isVisible(), 'error retry download action');
    const failed = await update();
    expect(failed.phase === 'error' && failed.errorCode === 'update_download_failed' && failed.ready === null
      && await page.getByTestId('update-apply').count() === 0,
    'sha512 不符時不提供安裝，同一版本可直接重新下載', {
      id: 'u36.download-failed', actual: { phase: failed.phase, code: failed.errorCode, ready: failed.ready },
    });
    const statusLine = await page.getByTestId('update-message').textContent();
    expect(statusLine === failed.message && typeof failed.detail === 'string' && failed.detail.length > 0 && !statusLine.includes(failed.detail),
      '設定頁顯示 API 的 message，更新程式的原文只在 API 的 detail', {
        id: 'u36.download-failed-detail', actual: { statusLine, message: failed.message, detail: failed.detail },
      });
    await shot('download-failed');
    await instance.updateCatalog((value) => { value.updates.payloadMode = 'valid'; });
    await page.getByTestId('update-download').click();
    await page.getByTestId('update-apply').waitFor();
    const ready = await update();
    expect(ready.phase === 'ready' && ready.ready?.version === '0.1.1' && ready.progress === null,
      '下載完成後才可重新啟動以安裝', { id: 'u36.ready', actual: { phase: ready.phase, version: ready.ready?.version, progress: ready.progress } });
  });

  await record.scenario('U36-W3', '檢查到更新的版本時，已下載的版本與新版下載並列', async ({ expect, shot }) => {
    await instance.updateCatalog((value) => { value.updates.version = '0.1.2'; });
    await page.getByTestId('update-check').click();
    await waitFor(async () => (await update()).offer?.version === '0.1.2', 'newer offer found');
    await page.getByTestId('update-download').waitFor();
    const newer = await update();
    expect(newer.ready?.version === '0.1.1' && newer.offer?.version === '0.1.2'
      && await page.getByTestId('update-apply').isVisible() && await page.getByTestId('update-download').isVisible(),
    '檢查到 0.1.2 時仍可安裝已下載的 0.1.1，並提供新版下載', {
      id: 'u36.ready-newer-offer', actual: { phase: newer.phase, ready: newer.ready?.version, offer: newer.offer?.version },
    });
    await shot('ready-and-newer');
  });

  await instance.api('/api/vault/setup', { method: 'POST', body: JSON.stringify({ action: 'create', location: instance.runDir, name: 'vault' }) });
  await waitFor(async () => (await instance.api('/api/search/status')).status.state === 'ready', 'Vault created and search ready');

  await record.scenario('U36-W4', '已開啟 Vault 時側欄與原生更新入口打開設定的 App 更新區', async ({ expect, shot }) => {
    await page.addInitScript(() => {
      let navigate;
      let readyCalled = false;
      window.xrCollectorDesktop = {
        chooseVaultLocation: async () => null, chooseVault: async () => null, chooseExportFile: async () => null, chooseImportFile: async () => null,
        revealVault: async () => undefined, revealTransferFile: async () => undefined, platform: 'darwin',
        onNavigate: (listener) => { navigate = listener; },
        navigationReady: () => { readyCalled = true; },
      };
      window.__verifyDesktopReady = () => readyCalled && typeof navigate === 'function';
      window.__verifyOpenUpdate = () => navigate('update');
    });
    await page.goto(`${instance.url}/documents`);
    await page.getByTestId('sidebar-update').click();
    await page.getByTestId('software-update').waitFor();
    await waitFor(() => panelIsInViewport(page), 'sidebar update panel in viewport').catch(() => undefined);
    const sidebar = { path: new URL(page.url()).pathname, inView: await panelIsInViewport(page) };
    expect(sidebar.path === '/settings' && sidebar.inView, '側欄版本狀態打開設定並把 App 更新區帶進可視範圍',
      { id: 'u36.sidebar-update-navigation', expected: { path: '/settings', inView: true }, actual: sidebar });

    await page.getByTestId('nav-documents').click();
    await page.getByTestId('page-documents').waitFor();
    await waitFor(() => page.evaluate(() => window.__verifyDesktopReady()), 'desktop navigation handshake');
    await page.evaluate(() => window.__verifyOpenUpdate());
    await page.getByTestId('software-update').waitFor();
    await waitFor(() => panelIsInViewport(page), 'native update panel in viewport').catch(() => undefined);
    const native = { path: new URL(page.url()).pathname, inView: await panelIsInViewport(page) };
    expect(native.path === '/settings' && native.inView, '選單列／系統匣的 update 導覽訊號打開設定的 App 更新區',
      { id: 'u36.native-update-navigation', expected: { path: '/settings', inView: true }, actual: native });
    await shot('update-panel-navigation');
  });

  await record.scenario('U36-W5', '側欄顯示目前的更新動作；安裝後下次啟動記為已安裝', async ({ expect, shot, note }) => {
    const sidebarPhase = () => page.getByTestId('sidebar-update').getAttribute('data-phase');
    /** The sidebar once it shows `phase`, read back for the check. */
    const sidebarShows = async (phase, label) => {
      await waitFor(async () => await sidebarPhase() === phase, label).catch(() => undefined);
      return sidebarPhase();
    };
    const start = await update();
    expect(await sidebarShows(start.phase, 'sidebar follows the update phase') === start.phase, '側欄顯示目前的更新階段',
      { id: 'u36.sidebar-current', expected: start.phase, actual: await sidebarPhase() });

    await instance.updateCatalog((value) => { value.updates.holdPayload = true; });
    await page.getByTestId('update-download').click();
    expect(await sidebarShows('downloading', 'sidebar downloading') === 'downloading', '下載時側欄顯示下載中',
      { id: 'u36.sidebar-downloading', expected: 'downloading', actual: await sidebarPhase() });
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-download').waitFor();

    await instance.updateCatalog((value) => { value.updates.holdPayload = false; });
    await page.getByTestId('update-download').click();
    await waitFor(async () => (await update()).ready?.version === '0.1.2', '0.1.2 downloaded');
    expect(await sidebarShows('ready', 'sidebar ready') === 'ready', '下載完成後側欄顯示可安裝',
      { id: 'u36.sidebar-ready', expected: 'ready', actual: await sidebarPhase() });
    await shot('sidebar-ready');

    await page.getByTestId('update-apply').click();
    expect(await sidebarShows('installing', 'sidebar installing') === 'installing', '安裝時側欄顯示安裝中',
      { id: 'u36.sidebar-installing', expected: 'installing', actual: await sidebarPhase() });
    const installing = { apply: await page.getByTestId('update-apply').count(), download: await page.getByTestId('update-download').count(),
      check: await page.getByTestId('update-check').count() };
    expect(Object.values(installing).every((count) => count === 0), '安裝中不再提供更新操作',
      { id: 'u36.installing-actions', expected: { apply: 0, download: 0, check: 0 }, actual: installing });
    await shot('sidebar-installing');

    await instance.updateCatalog((value) => { value.updates.currentVersion = '0.1.2'; });
    await instance.restart({ page });
    const installed = await update();
    expect(installed.currentVersion === '0.1.2' && installed.lastAttempt?.outcome === 'installed' && installed.lastAttempt.version === '0.1.2',
      '以 0.1.2 重新啟動後，安裝結果記為已安裝', { id: 'u36.installed', actual: { currentVersion: installed.currentVersion, lastAttempt: installed.lastAttempt } });
    note('native-boundary', 'Web 只記錄安裝請求；原生 A→B 由兩平台的打包驗收證明。');
  });
}

async function panelIsInViewport(page) {
  return await page.getByTestId('software-update').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  }).catch(() => false);
}
