// Onboarding from no Vault to a Vault in use, through each of its three entries: create a new Vault
// with a name and location, open an existing one (after the previously used one went missing), and
// create one from an export file; and creating another Vault from Settings, then switching back. The screens join the setup API, the name check and the restart
// with a missing Vault, which only the page shows together; the API rules themselves are covered by
// the runtime and new-vault tests. Web mode types paths where the desktop app opens native pickers.
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { collect, idle, subscribe } from '../scripts/lib/index.mjs';

export const name = 'onboarding';
export const title = '開始使用：建立、開啟既有與從匯出檔建立知識庫；設定頁建立新的知識庫';
export const tier = 'feature';
export const vault = 'none';
export const covers = ['onboarding-home', 'onboarding-create', 'onboarding-open', 'onboarding-missing', 'onboarding-from-export', 'vault-create'];

export async function run({ instance, page, record, waitFor }) {
  const button = (id) => page.getByTestId(id);
  const text = async (id) => (await button(id).innerText()).trim();
  const documents = path.join(instance.runDir, 'documents');
  const first = path.join(documents, 'XR Collector');
  const moved = path.join(documents, 'XR Collector (moved)');
  const other = path.join(documents, 'Other', 'My Vault');
  const exportFile = path.join(instance.runDir, 'exports', 'my-vault.zip');
  const home = async () => { await button('onboarding-home').waitFor(); };
  // A restart reopens the route the page was on; the App opens at its root, where Onboarding shows.
  const restartAtRoot = async () => {
    await page.goto(instance.url);
    await instance.restart({ page });
  };
  const preview = (expected) => waitFor(async () => (await text('new-vault-preview')) === expected, `preview ${expected}`);
  const vaultPath = async () => (await instance.api('/api/vault/status')).vaultPath;
  const documentCount = async () => (await instance.api('/api/documents')).documents.length;
  const subscriptionCount = async () => (await instance.api('/api/subscriptions')).subscriptions.length;

  // The window bottom shows the onboarding background on every onboarding screen, in both schemes.
  const fillsWindow = async (expect, screen) => {
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme });
      const fill = await page.evaluate(() => {
        const wrapper = document.querySelector('.onboarding-with-build-info');
        const box = wrapper.getBoundingClientRect();
        const below = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 2);
        return { bottom: box.bottom, viewport: window.innerHeight, coveredBy: below?.closest('.onboarding-with-build-info') ? 'onboarding' : below?.tagName ?? null };
      });
      expect(fill.bottom >= fill.viewport && fill.coveredBy === 'onboarding', `${screen}，${scheme}：視窗底部仍是開始使用畫面的背景`,
        { id: `ob.background.${screen}.${scheme}`, expected: { bottom: `>= ${fill.viewport}`, coveredBy: 'onboarding' }, actual: fill });
    }
    await page.emulateMedia({ colorScheme: 'dark' });
  };
  await page.setViewportSize({ width: 1180, height: 1400 });
  await home();

  await record.scenario('OB-W1', '沒有知識庫時看到三個入口，背景延伸到視窗底部', async ({ expect, themed }) => {
    const rows = await button('onboarding-entries').locator('.ob-row strong').allTextContents();
    const entries = ['建立新的知識庫', '開啟既有知識庫', '從匯出檔建立'];
    expect(JSON.stringify(rows) === JSON.stringify(entries), '三個入口依序出現', { id: 'ob.entries', expected: entries, actual: rows });
    const labels = await Promise.all(['onboarding-create', 'onboarding-open', 'onboarding-from-export'].map((id) => text(id)));
    expect(JSON.stringify(labels) === JSON.stringify(['建立', '開啟', '選擇檔案']), '入口按鈕文字', { id: 'ob.entry-buttons', actual: labels });
    expect(await button('onboarding-original-failure').count() === 0, '首次啟動沒有原知識庫提示', { id: 'ob.no-warning' });
    expect(await page.getByRole('button', { name: 'AI 助理連線', exact: true }).isVisible(), 'AI 助理連線入口保留', { id: 'ob.agent-entry' });
    await fillsWindow(expect, 'home');
    await themed('home');
  });


  await record.scenario('OB-W2', '建立表單：名稱衝突與不能用的名稱；用預設值建立後進入 App', async ({ expect, shot, themed }) => {
    await mkdir(path.join(documents, 'Taken'));
    await button('onboarding-create').click();
    await button('onboarding-create-form').waitFor();
    const name = button('new-vault-name');
    const location = button('new-vault-location-input');
    expect(await name.inputValue() === 'XR Collector', '名稱預設 XR Collector', { id: 'ob.create.default-name', actual: await name.inputValue() });
    expect(await location.inputValue() === documents, '位置預設為文件資料夾', { id: 'ob.create.default-location', expected: documents, actual: await location.inputValue() });
    await preview(`知識庫位置：${first}`);
    expect(await button('onboarding-create-confirm').isEnabled(), '預設值可以建立', { id: 'ob.create.default-enabled' });
    await fillsWindow(expect, 'create');
    await themed('create');

    for (const [value, message, id] of [
      ['Taken', '這個位置已經有「Taken」，請換個名稱。', 'conflict'],
      ['a/b', '名稱不能包含 \\ / : * ? " < > | 等字元。', 'invalid-char'],
      ['', '請輸入名稱。', 'empty'],
    ]) {
      await name.fill(value);
      await preview(message);
      expect(await button('onboarding-create-confirm').isDisabled(), `「${value}」：說明原因且建立停用`, { id: `ob.create.${id}`, expected: message, actual: await text('new-vault-preview') });
      if (id === 'conflict') await shot('create-conflict');
    }
    await name.fill('XR Collector');
    await preview(`知識庫位置：${first}`);
    expect(await button('onboarding-create-confirm').isEnabled(), '改回可用的名稱後恢復可建立', { id: 'ob.create.recovered' });

    await button('onboarding-back').click();
    await home();
    expect(await button('onboarding-error').count() === 0, '返回首頁不帶錯誤', { id: 'ob.create.back' });
    await button('onboarding-create').click();
    await preview(`知識庫位置：${first}`);
    await button('onboarding-create-confirm').click();
    await button('nav-settings').waitFor({ timeout: 30_000 });
    expect(await vaultPath() === first, '用預設值建立的資料夾是 文件/XR Collector', { id: 'ob.create.path', expected: first, actual: await vaultPath() });
    const entries = await readdir(first);
    expect(entries.includes('xr-collector-vault.json'), '新資料夾是知識庫', { id: 'ob.create.marker', actual: entries });
    expect(JSON.stringify(await readdir(path.join(documents, 'Taken'))) === '[]', '同名的既有資料夾沒有被動到', { id: 'ob.create.taken-untouched' });
  });

  // Content for the export, and the export file a later scenario creates a Vault from.
  await collect(instance, 'https://www.youtube.com/watch?v=vD000000001');
  await subscribe(instance, 'https://www.youtube.com/@verify-a');
  await idle(instance);
  const exported = { documents: await documentCount(), subscriptions: await subscriptionCount() };
  await mkdir(path.dirname(exportFile), { recursive: true });
  await instance.api('/api/vault/export', { method: 'POST', body: JSON.stringify({ path: exportFile }) });
  await waitFor(async () => (await instance.api('/api/vault/status')).state === 'completed', 'export completed');

  await record.scenario('OB-W3', '設定頁建立新的知識庫：改名稱與位置建立並切換，原知識庫不變，再用開啟既有切回', async ({ expect, shot }) => {
    const before = (await readdir(first, { recursive: true })).sort();
    await mkdir(path.dirname(other));
    await button('nav-settings').click();
    await button('vault-create').click();
    await button('create-vault-dialog').waitFor();
    const name = button('new-vault-name');
    const location = button('new-vault-location-input');
    await waitFor(async () => await location.inputValue() === documents, 'location defaults to the parent of the active Vault');
    expect(await name.inputValue() === 'XR Collector', '名稱預設 XR Collector，位置預設目前知識庫的上一層', { id: 'settings.create.defaults' });
    await preview('這個位置已經有「XR Collector」，請換個名稱。');
    expect(await button('create-vault-confirm').isDisabled(), '預設值與目前的知識庫同名時不能建立', { id: 'settings.create.conflict' });
    await name.fill('My Vault');
    await location.fill(path.dirname(other));
    await preview(`知識庫位置：${other}`);
    await shot('settings-create');
    await button('create-vault-confirm').click();
    await button('create-vault-result-path').waitFor({ timeout: 30_000 });
    expect(await text('create-vault-result-path') === other && await vaultPath() === other, '建立在預覽的路徑並切換過去',
      { id: 'settings.create.switched', expected: other, actual: { result: await text('create-vault-result-path'), vaultPath: await vaultPath() } });
    await shot('settings-created');
    await button('transfer-close').click();
    expect(await documentCount() === 0, '新的知識庫沒有文件', { id: 'settings.create.empty' });
    const after = (await readdir(first, { recursive: true })).sort();
    expect(JSON.stringify(after) === JSON.stringify(before), '原知識庫資料夾內容不變', { id: 'settings.create.original-untouched', expected: before.length, actual: after.length });

    await button('vault-open-other').click();
    await button('open-vault-path').fill(first);
    await button('open-vault-confirm').click();
    await button('open-vault-result-path').waitFor({ timeout: 30_000 });
    await button('transfer-close').click();
    expect(await vaultPath() === first && await documentCount() === exported.documents, '用開啟既有知識庫切回原知識庫，文件還在',
      { id: 'settings.create.back', expected: { vaultPath: first, documents: exported.documents }, actual: { vaultPath: await vaultPath(), documents: await documentCount() } });
  });

  await record.scenario('OB-W4', '原知識庫改名後重開：提示原路徑，開啟一般資料夾顯示錯誤，開啟新名稱後正常使用', async ({ expect, shot }) => {
    await rename(first, moved);
    await restartAtRoot();
    await home();
    const warning = await text('onboarding-original-failure');
    expect(warning.includes('原知識庫無法開啟') && warning.includes(first), '提示框說明原知識庫無法開啟並顯示原路徑',
      { id: 'ob.missing.warning', expected: first, actual: warning });
    await shot('missing-vault');

    await button('onboarding-open').click();
    await button('onboarding-open-path').fill(path.join(documents, 'Taken'));
    await button('onboarding-open-confirm').click();
    await button('onboarding-error').waitFor();
    expect(await text('onboarding-error') === '「Taken」不是 XR Collector 知識庫。', '選到一般資料夾時留在首頁並說明原因',
      { id: 'ob.open.not-a-vault', actual: await text('onboarding-error') });
    expect(await button('onboarding-home').isVisible(), '仍在首頁', { id: 'ob.open.stays-home' });
    await shot('open-not-a-vault');

    await button('onboarding-open-path').fill(moved);
    await button('onboarding-open-confirm').click();
    await button('nav-settings').waitFor({ timeout: 30_000 });
    expect(await vaultPath() === moved && await documentCount() === exported.documents, '開啟改名後的知識庫，文件還在',
      { id: 'ob.open.moved', expected: { vaultPath: moved, documents: exported.documents }, actual: { documents: await documentCount() } });
  });

  await record.scenario('OB-W5', '從匯出檔建立：顯示匯出內容，名稱預設為來源資料夾名稱，建立後文件與訂閱一致', async ({ expect, shot }) => {
    await rm(path.join(instance.runDir, 'profile', 'vault-selection.json'), { force: true });
    await restartAtRoot();
    await home();
    await button('onboarding-from-export').click();
    await button('onboarding-import-form').waitFor();
    expect(await button('onboarding-import-confirm').isDisabled(), '尚未選擇匯出檔時不能建立', { id: 'ob.export.needs-file' });
    await button('onboarding-package-input').fill(exportFile);
    await button('onboarding-package-read').click();
    await waitFor(async () => (await button('onboarding-package-summary').count()) === 1, 'package described');
    const summary = await text('onboarding-package-summary');
    const counts = `${exported.documents} 份文件、${exported.subscriptions} 個訂閱`;
    expect(/\d{4}-\d{2}-\d{2} 匯出/u.test(summary) && summary.includes(counts), '顯示匯出日期、文件數與訂閱數', { id: 'ob.export.summary', expected: counts, actual: summary });
    const name = await button('new-vault-name').inputValue();
    expect(name === 'XR Collector', '名稱預設為匯出時的資料夾名稱', { id: 'ob.export.default-name', expected: 'XR Collector', actual: name });
    await preview(`知識庫位置：${first}`);
    await fillsWindow(expect, 'from-export');
    await shot('from-export');
    await button('onboarding-import-confirm').click();
    await button('nav-settings').waitFor({ timeout: 30_000 });
    const result = { vaultPath: await vaultPath(), documents: await documentCount(), subscriptions: await subscriptionCount() };
    expect(result.vaultPath === first && result.documents === exported.documents && result.subscriptions === exported.subscriptions, '建立的知識庫有匯出前的文件與訂閱',
      { id: 'ob.export.contents', expected: { vaultPath: first, ...exported }, actual: result });
    expect((await readdir(moved)).includes('xr-collector-vault.json'), '來源知識庫沒有被動到', { id: 'ob.export.source-untouched' });
    await waitFor(async () => (await instance.api('/api/search/status')).status.state === 'ready', 'search ready');
    const found = await instance.api(`/api/search?q=${encodeURIComponent('合成')}`);
    expect(found.total > 0, '搜尋找得到匯入的文件', { id: 'ob.export.search', expected: '> 0', actual: found.total });
  });
}
