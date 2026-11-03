// App updates through the shared update service: checking without a Vault from the UI and an
// authorized Agent, downloading with only cancel offered, refusing to apply while busy, an integrity
// error never publishing a ready update, keeping a ready update while a newer one downloads, the
// cancellable wait for a safe stop, and, once a Vault exists, the sidebar and the native menu
// reaching the update panel with the sidebar naming only the current action. A broken update path
// leaves users on an old build or installs a payload nobody verified.
import { defaultCatalog } from '../scripts/lib/synthetic.mjs';

export const name = 'app-update';
export const title = 'App 更新的查詢、下載驗證、取消、安全等待與更新入口';
export const covers = ['update-discovery', 'update-download', 'update-apply-wait', 'update-agent', 'update-no-vault', 'update-navigation'];
export const vault = 'none';
export const catalog = () => ({ ...defaultCatalog(), updates: { enabled: true, version: '0.1.1', payloadMode: 'valid', payloadDelayMs: 0 } });

export async function run({ instance, page, record, waitFor }) {
  const connection = (await instance.api('/api/device/agent/connection')).connection;
  const agent = async (pathname, init = {}) => {
    const response = await fetch(`${connection.url}${pathname}`, { ...init, headers: {
      authorization: `Bearer ${connection.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}),
    } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const update = async () => (await instance.api('/api/device/updates')).update;
  const selection = (offer) => JSON.stringify({ version: offer.version, sha256: offer.payload.sha256 });
  const cancels = async () => page.getByTestId('update-cancel').getAttribute('data-cancels').catch(() => null);
  let updateApiAvailable = false;

  await record.scenario('U36-W1', '未建立 Vault 時 UI 與授權 Agent 都可檢查私人更新來源', async ({ expect, shot, note }) => {
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
    expect(checked.status === 200 && checked.body.update.phase === 'available', '授權 Agent 經相同 API 找到 0.1.1', {
      id: 'u36.agent-check', actual: { status: checked.status, phase: checked.body?.update?.phase, version: checked.body?.update?.offer?.version },
    });
    await waitFor(async () => await page.getByTestId('update-download').isVisible(), 'available update UI').catch(() => undefined);
    expect(await page.getByTestId('update-download').isVisible(), 'Agent 檢查到的更新出現在畫面的下載入口', { id: 'u36.ui-follows-check' });
    const status = await update();
    expect(status.offer?.version === '0.1.1' && status.offer.source.id === 'generic-index' && status.offer.source.indexUrl.endsWith('/updates/release-darwin-arm64.json'), 'GenericIndexSource 讀取本平台的 index', {
      id: 'u36.generic-source', actual: status.offer && { version: status.offer.version, source: status.offer.source },
    });
    await page.getByRole('button', { name: '版本說明' }).click();
    const notes = await page.getByRole('dialog').count();
    expect(notes === 1, '版本說明可開啟', { id: 'u36.release-notes', expected: 1, actual: notes });
    await shot('available-no-vault');
    await page.getByRole('dialog').getByRole('button', { name: '關閉' }).click();
    note('scope', 'Web 使用真實 UpdateService 與 generic HTTP index；ZIP 是語意 fixture，fake NativeInstaller 只驗證檔案，不證明原生安裝。');
  });
  // A reverse baseline without #36 stops on the product-contract assertion above; it does not
  // spend time waiting for controls that correctly do not exist in that older checkout.
  if (!updateApiAvailable) return;

  await record.scenario('U36-W2', '下載中只顯示取消，忙碌拒絕套用，錯誤後可重試到 ready', async ({ expect, shot }) => {
    await instance.updateCatalog((value) => { value.updates.payloadDelayMs = 10_000; value.updates.payloadMode = 'valid'; });
    await page.getByTestId('update-download').click();
    await waitFor(async () => await cancels() === 'download', 'downloading cancel UI');
    const actions = { download: await page.getByTestId('update-download').count(), cancels: await cancels() };
    expect(actions.download === 0 && actions.cancels === 'download', '下載中不再顯示重複下載，只能取消下載',
      { id: 'u36.downloading-actions', expected: { download: 0, cancels: 'download' }, actual: actions });
    const downloading = await update();
    expect(downloading.phase === 'downloading' && downloading.progress?.percent === 62, '串流下載回報 62% 進度', {
      id: 'u36.progress', actual: { phase: downloading.phase, progress: downloading.progress },
    });
    const busy = await agent('/api/device/updates/apply', { method: 'POST', body: selection(downloading.offer) });
    expect(busy.status === 409 && busy.body?.error?.code === 'update_busy', '下載中由授權 Agent 套用會拒絕為 update_busy', {
      id: 'u36.agent-busy', actual: { status: busy.status, code: busy.body?.error?.code },
    });
    await shot('downloading');
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-download').waitFor();
    expect((await update()).phase === 'available', '取消後回到同一固定 offer，沒有 ready', { id: 'u36.download-cancel' });

    await instance.updateCatalog((value) => { value.updates.payloadDelayMs = 0; value.updates.payloadMode = 'corrupt'; });
    await page.getByTestId('update-download').click();
    await waitFor(async () => (await update()).phase === 'error', 'integrity error state');
    await waitFor(async () => await page.getByTestId('update-download').isVisible(), 'error retry download action');
    const failed = await update();
    expect(failed.phase === 'error' && failed.errorCode === 'update_integrity_failed' && failed.ready === null,
      '雜湊錯誤不發布 ready，但保留同一 offer 可直接重新下載', {
        id: 'u36.integrity-error', actual: { phase: failed.phase, code: failed.errorCode, ready: failed.ready },
      });
    await shot('integrity-error');
    await instance.updateCatalog((value) => { value.updates.payloadMode = 'valid'; });
    await page.getByTestId('update-download').click();
    await page.getByTestId('update-apply').waitFor();
    const ready = await update();
    expect(ready.phase === 'ready' && ready.ready?.version === '0.1.1' && ready.progress === null,
      '大小、SHA-256 與 fixture installer 驗證後才發布 ready', {
        id: 'u36.ready', actual: { phase: ready.phase, version: ready.ready?.version, progress: ready.progress },
      });
  });

  await record.scenario('U36-W3', '稍後保留 ready；套用等待可取消且 Web 不宣稱已安裝', async ({ expect, shot, note }) => {
    await page.getByTestId('update-later').click();
    await page.getByTestId('update-deferred').waitFor();
    const deferred = { phase: (await update()).phase, apply: await page.getByTestId('update-apply').isVisible() };
    expect(deferred.phase === 'ready' && deferred.apply, '稍後保留 verified ready，同一頁仍可重新啟動以安裝',
      { id: 'u36.defer-ready', expected: { phase: 'ready', apply: true }, actual: deferred });

    await instance.updateCatalog((value) => { value.updates.version = '0.1.2'; value.updates.payloadDelayMs = 10_000; });
    await page.getByTestId('update-check').click();
    await waitFor(async () => (await update()).offer?.version === '0.1.2', 'newer offer found');
    await page.getByTestId('update-download').waitFor();
    const newer = await update();
    expect(newer.phase === 'ready' && newer.ready?.version === '0.1.1' && newer.offer?.version === '0.1.2'
      && await page.getByTestId('update-apply').isVisible(),
    '檢查到 0.1.2 時仍固定保留可安裝的 0.1.1，並明確提供新版下載', {
      id: 'u36.ready-newer-offer', actual: { phase: newer.phase, ready: newer.ready?.version, offer: newer.offer?.version },
    });
    await shot('ready-and-newer');
    await page.getByTestId('update-download').click();
    await waitFor(async () => (await update()).progress?.percent === 62, 'newer download progress');
    const replacing = await update();
    expect(replacing.phase === 'downloading' && replacing.ready?.version === '0.1.1' && replacing.offer?.version === '0.1.2',
      '0.1.2 尚未驗證完成時 0.1.1 仍是唯一 ready', {
        id: 'u36.newer-not-ready-early', actual: { phase: replacing.phase, ready: replacing.ready?.version, offer: replacing.offer?.version },
      });
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-apply').waitFor();
    const retryStatus = { ...(await update()), phase: 'error', errorCode: 'update_apply_failed', message: '準備更新逾時，請重試。' };
    const retryRoute = '**/api/device/updates';
    await page.route(retryRoute, (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ update: retryStatus }) }));
    try {
      await page.reload();
      await page.getByTestId('update-apply').waitFor();
      expect(await page.getByTestId('update-apply').isVisible() && await page.getByTestId('update-download').isVisible(),
        '錯誤後保留 ready 的套用與新版 offer 的下載入口', { id: 'u36.error-retains-actions' });
      await shot('error-ready-retry');
      await page.getByTestId('update-apply').click();
    } finally { await page.unroute(retryRoute); }
    await waitFor(async () => await cancels() === 'wait', 'waiting cancel UI');
    const waiting = { phase: (await update()).phase, cancels: await cancels(), apply: await page.getByTestId('update-apply').count() };
    expect(waiting.phase === 'waiting' && waiting.cancels === 'wait' && waiting.apply === 0,
      '等待工作時不能再次套用，只能取消等待', { id: 'u36.waiting', expected: { phase: 'waiting', cancels: 'wait', apply: 0 }, actual: waiting });
    await shot('waiting-no-vault');
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-apply').waitFor();
    expect((await update()).phase === 'ready', '取消等待只釋放意圖，驗證完成的更新仍可稍後套用', { id: 'u36.wait-cancel' });
    note('native-boundary', '此流程停在 waiting 後取消；原生 A→B、installer 與重新啟動另由兩平台 packaged acceptance 證明。');
  });

  await instance.api('/api/vault/setup', { method: 'POST', body: JSON.stringify({ action: 'create', location: instance.runDir, name: 'vault' }) });
  await waitFor(async () => (await instance.api('/api/search/status')).status.state === 'ready', 'Vault created and search ready');

  await record.scenario('U36-W4', '已開啟 Vault 時側欄與原生更新入口打開設定的 App 更新區', async ({ expect, shot }) => {
    await page.addInitScript(() => {
      let navigate;
      let readyCalled = false;
      window.xrCollectorDesktop = {
        chooseVaultLocation: async () => null, chooseVault: async () => null, chooseExportFile: async () => null, chooseImportFile: async () => null,
        revealVault: async () => undefined, revealExport: async () => undefined, platform: 'darwin',
        onNavigate: (listener) => { navigate = listener; },
        ready: () => { readyCalled = true; },
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

  await record.scenario('U36-W5', '側欄只顯示目前真正的更新動作', async ({ expect, shot }) => {
    const sidebarPhase = () => page.getByTestId('sidebar-update').getAttribute('data-phase');
    /** The sidebar once it shows `phase`, read back for the check. */
    const sidebarShows = async (phase, label) => {
      await waitFor(async () => await sidebarPhase() === phase, label).catch(() => undefined);
      return sidebarPhase();
    };
    // The ready 0.1.1 and the 0.1.2 offer from W3 stay; a fresh offer needs a check that finds no ready update.
    const start = await update();
    expect(await sidebarShows(start.phase, 'sidebar follows the update phase') === start.phase, '側欄顯示目前的更新階段',
      { id: 'u36.sidebar-current', expected: start.phase, actual: await sidebarPhase() });

    await instance.updateCatalog((value) => { value.updates.payloadDelayMs = 10_000; });
    await page.getByTestId('update-download').click();
    expect(await sidebarShows('downloading', 'sidebar downloading') === 'downloading', '下載時側欄顯示下載中',
      { id: 'u36.sidebar-downloading', expected: 'downloading', actual: await sidebarPhase() });
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-download').waitFor();

    await instance.updateCatalog((value) => { value.updates.payloadDelayMs = 0; });
    await page.getByTestId('update-download').click();
    await waitFor(async () => (await update()).ready?.version === '0.1.2', '0.1.2 verified');
    expect(await sidebarShows('ready', 'sidebar ready') === 'ready', '驗證完成後側欄顯示可安裝',
      { id: 'u36.sidebar-ready', expected: 'ready', actual: await sidebarPhase() });
    await shot('sidebar-ready');

    await page.getByTestId('update-apply').click();
    expect(await sidebarShows('waiting', 'sidebar waiting') === 'waiting', '等待安全停止時側欄顯示等待安裝',
      { id: 'u36.sidebar-waiting', expected: 'waiting', actual: await sidebarPhase() });
    await shot('sidebar-waiting');
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-apply').waitFor();
  });
}

async function panelIsInViewport(page) {
  return await page.getByTestId('software-update').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  }).catch(() => false);
}
