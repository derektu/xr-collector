import { defaultCatalog } from '../scripts/lib/synthetic.mjs';

export const name = 'app-update';
export const title = 'App 更新的查詢、下載驗證、取消與安全等待';
export const tier = 'feature';
export const covers = ['update-discovery', 'update-download', 'update-apply-wait', 'update-agent', 'update-no-vault'];
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
  let updateApiAvailable = false;

  await record.scenario('U36-W1', '未建立 Vault 時 UI 與授權 Agent 都可檢查私人更新來源', async ({ expect, shot, note }) => {
    let initialApi;
    try { initialApi = await instance.api('/api/device/updates'); } catch (error) { initialApi = { error: String(error) }; }
    updateApiAvailable = Boolean(initialApi?.update);
    expect(updateApiAvailable, '裝置更新 API 已由產品提供', { id: 'u36.update-api', actual: initialApi });
    if (!updateApiAvailable) return;
    const unavailable = async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ update: {
      phase: 'idle', currentVersion: '0.1.0', target: 'darwin-arm64', installerAvailable: false,
      offer: null, ready: null, lastAttempt: { id: 'fixture', version: '0.1.0', buildId: 'fixture', startedAt: '2026-10-28T00:00:00.000Z',
        finishedAt: '2026-10-28T00:01:00.000Z', outcome: 'unknown', message: '無法確認 0.1.0 的安裝結果。' },
      progress: null, lastCheckAttemptAt: null, checkedAt: null, message: '此執行環境無法安裝更新。', errorCode: null,
    } }) });
    await page.route('**/api/device/updates', unavailable);
    await page.goto(`${instance.url}/settings`);
    await page.getByTestId('software-update').waitFor();
    expect(await page.getByTestId('device-settings-without-vault').isVisible(), '未建立 Vault 仍可進入裝置更新設定', {
      id: 'u36.no-vault-ui', actual: (await instance.api('/api/vault/setup')).vault.state,
    });
    expect(await page.getByTestId('update-check').isVisible(), '沒有原生 installer 仍可檢查 metadata', { id: 'u36.check-without-installer' });
    expect((await page.getByTestId('update-attempt-problem').innerText()).trim() === '無法確認 0.1.0 的安裝結果。'
      && await page.getByText('最近一次安裝：', { exact: false }).count() === 0, '結果不明仍直接告知，但不顯示安裝歷史標頭', {
        id: 'u36.attempt-problem-only', actual: await page.getByTestId('software-update').innerText(),
      });
    await page.unroute('**/api/device/updates', unavailable);
    await page.reload();
    await page.getByTestId('update-check').waitFor();
    expect(await page.getByTestId('update-check').isVisible(), '檢查更新不依賴 Vault', { id: 'u36.check-visible' });
    const checked = await agent('/api/device/updates/check', { method: 'POST' });
    expect(checked.status === 200 && checked.body.update.phase === 'available', '授權 Agent 經相同 API 找到 0.1.1', {
      id: 'u36.agent-check', actual: { status: checked.status, phase: checked.body?.update?.phase, version: checked.body?.update?.offer?.version },
    });
    await waitFor(async () => await page.getByTestId('update-download').isVisible(), 'available update UI', { timeout: 8_000 });
    const status = await update();
    expect(status.offer?.version === '0.1.1' && status.offer.source.id === 'generic-index' && status.offer.source.indexUrl.endsWith('/updates/release-darwin-arm64.json'), 'GenericIndexSource 讀取本平台的 index', {
      id: 'u36.generic-source', actual: status.offer && { version: status.offer.version, source: status.offer.source },
    });
    await page.getByRole('button', { name: '版本說明' }).click();
    expect(await page.getByRole('dialog', { name: '0.1.1 版本說明' }).getByText('合成更新，只驗證共用下載與等待流程。').isVisible(),
      '版本說明可讀', { id: 'u36.release-notes' });
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
    await waitFor(async () => await page.getByTestId('update-cancel').isVisible(), 'downloading cancel UI', { timeout: 8_000 });
    expect(await page.getByTestId('update-download').count() === 0 && await page.getByTestId('update-cancel').innerText() === '取消下載',
      '下載中不再顯示重複下載，只能取消', { id: 'u36.downloading-actions' });
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
    await waitFor(async () => (await update()).phase === 'error', 'integrity error state', { timeout: 8_000 });
    await waitFor(async () => await page.getByTestId('update-download').isVisible(), 'error retry download action', { timeout: 8_000 });
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
    expect(await page.getByText('已保留，可隨時安裝', { exact: true }).isVisible()
      && await page.getByTestId('update-apply').isVisible() && (await update()).phase === 'ready',
    '稍後保留 verified ready，同一頁仍可重新啟動以安裝', { id: 'u36.defer-ready' });

    await instance.updateCatalog((value) => { value.updates.version = '0.1.2'; value.updates.payloadDelayMs = 10_000; });
    await page.getByTestId('update-check').click();
    await page.getByRole('button', { name: '下載 0.1.2' }).waitFor();
    const newer = await update();
    expect(newer.phase === 'ready' && newer.ready?.version === '0.1.1' && newer.offer?.version === '0.1.2'
      && await page.getByTestId('update-apply').isVisible(),
    '檢查到 0.1.2 時仍固定保留可安裝的 0.1.1，並明確提供新版下載', {
      id: 'u36.ready-newer-offer', actual: { phase: newer.phase, ready: newer.ready?.version, offer: newer.offer?.version },
    });
    await shot('ready-and-newer');
    await page.getByRole('button', { name: '下載 0.1.2' }).click();
    await waitFor(async () => (await update()).progress?.percent === 62, 'newer download progress', { timeout: 8_000 });
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
      await page.getByText(retryStatus.message, { exact: true }).waitFor();
      expect(await page.getByTestId('update-apply').isVisible() && await page.getByTestId('update-download').isVisible(),
        '錯誤後保留 ready 的套用與新版 offer 的下載入口', { id: 'u36.error-retains-actions' });
      await shot('error-ready-retry');
      await page.getByTestId('update-apply').click();
    } finally { await page.unroute(retryRoute); }
    await page.getByTestId('update-cancel').waitFor();
    const waiting = await agent('/api/device/updates');
    expect(waiting.status === 200 && waiting.body.update.phase === 'waiting'
      && await page.getByTestId('update-cancel').innerText() === '取消等待' && await page.getByTestId('update-apply').count() === 0,
    '等待工作時 Agent 與 UI 同步，不能再次套用，只能取消等待', {
      id: 'u36.waiting', actual: { status: waiting.status, phase: waiting.body?.update?.phase },
    });
    await shot('waiting-no-vault');
    await page.getByTestId('update-cancel').click();
    await page.getByTestId('update-apply').waitFor();
    expect((await update()).phase === 'ready', '取消等待只釋放意圖，驗證完成的更新仍可稍後套用', { id: 'u36.wait-cancel' });
    note('native-boundary', '此流程停在 waiting 後取消；原生 A→B、installer 與重新啟動另由兩平台 packaged acceptance 證明。');
  });
}
