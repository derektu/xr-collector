// Shared Web regression for the Vault operation lifecycle. External collection uses synthetic
// YouTube data; all transfers use the production HTTP handlers and real files/search indexes.
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { collect, idle, launchWeb, openPage as openWebPage, subscribe } from '../scripts/lib/index.mjs';

export const name = 'vault-transfer';
export const title = '知識庫匯出、匯入與切換';
export const tier = 'feature';
export const overBudget = '另啟動來源知識庫與固定位置兩個 instance；匯出、合併、取代、切換與收集中匯入依序改變同一份 Vault，拆開的每支都要重建相同前置資料。CI 約 90 秒。';
export const covers = ['vault-info', 'vault-actions', 'vault-export', 'vault-import-merge', 'vault-import-replace', 'vault-import-nothing', 'vault-open-other', 'vault-fixed'];

export async function run({ instance, page, openPage, record, waitFor }) {
  const button = (id) => page.getByTestId(id);
  const settings = async () => { await button('nav-settings').click(); await button('settings-vault').waitFor(); };
  const click = (id) => button(id).click();
  const visible = (id) => button(id).waitFor({ timeout: 60_000 });
  const exportPath = path.join(instance.runDir, 'exports', 'local.zip');
  await mkdir(path.dirname(exportPath), { recursive: true });
  let donor;
  let fixed;
  let fixedView;
  const donorRoot = path.join(instance.runDir, 'other-vault');
  const backupNames = () => readdir(path.join(instance.runDir, 'documents', 'XR Collector 備份')).catch(() => []);
  const exportThroughUI = async (file) => {
    await click('vault-export');
    await button('export-path').fill(file);
    await click('export-confirm');
    await visible('export-result-path');
  };
  const compareThroughUI = async (file) => {
    await click('vault-import');
    await button('import-path').fill(file);
    await click('import-compare');
    await page.locator('[data-testid="import-preview"], [data-testid="import-nothing"]').waitFor({ timeout: 60_000 });
  };
  const documents = async (expect, count, search = '合成') => {
    await click('nav-documents');
    await waitFor(async () => await page.locator('.document-row').count() === count, `${count} documents in UI`);
    expect(await page.locator('.document-row').count() === count, `文件頁顯示 ${count} 份文件`);
    await button('documents-search').fill(search);
    await waitFor(async () => await page.locator('.document-row').count() === count
      && (await button('documents-summary').innerText()).includes('找到') && !(await button('search-unavailable').count()), 'search results');
    expect(await page.locator('.document-row').count() === count, '搜尋可找到所有文件');
    const state = await instance.state();
    expect(state.vault.documents?.length === count, `Vault 實際保存 ${count} 份文件`, { id: `vault.count.${count}`, expected: count, actual: state.vault.documents?.length });
    const index = state.index.indexes?.find((entry) => ['documents_v3', 'documents_v2'].includes(entry.uid));
    expect(index?.numberOfDocuments === count, '搜尋索引筆數一致', { id: `index.count.${count}`, expected: count, actual: index?.numberOfDocuments });
    await button('documents-search').fill('');
    await settings();
  };
  try {
    await collect(instance, 'https://www.youtube.com/watch?v=vD000000001');
    await idle(instance);
    donor = await launchWeb({ issue: instance.issue, checkout: instance.checkout, label: `${instance.label ?? 'transfer'}-donor` });
    await collect(donor, 'https://www.youtube.com/watch?v=vB000000001');
    await idle(donor);
    const donorZip = path.join(instance.runDir, 'exports', 'donor.zip');
    await donor.api('/api/vault/export', { method: 'POST', body: JSON.stringify({ path: donorZip }) });
    await collect(donor, 'https://www.youtube.com/watch?v=vB000000002');
    await idle(donor);
    // Stop before copying the Vault, so opening it cannot share a live writer.
    await donor.stop({ keep: true });
    await cp(path.join(donor.runDir, 'vault'), donorRoot, { recursive: true });
    await settings();

    await record.scenario('R102-1', '資訊、匯出、同名檔保留與覆蓋', async ({ expect, shot, themed }) => {
      expect((await button('vault-path').innerText()).trim() === path.join(instance.runDir, 'vault'), '設定顯示目前 Vault 路徑');
      expect((await button('vault-counts').innerText()).includes('1'), '設定顯示一份文件');
      const order = await button('settings-vault').locator('button').allTextContents();
      const labels = ['建立新的知識庫…', '開啟既有知識庫…', '匯入…', '匯出…'];
      expect(JSON.stringify(order) === JSON.stringify(labels), '知識庫操作順序：建立、開啟在左，匯入、匯出在右',
        { id: 'vault.actions.order', expected: labels, actual: order });
      const frames = await Promise.all(['vault-create', 'vault-open-other', 'vault-import', 'vault-export'].map((id) => button(id).boundingBox()));
      expect(frames.every((frame) => frame && Math.abs(frame.y - frames[0].y) < 1), '一般寬度的知識庫操作按鈕同一排',
        { id: 'vault.actions.row', expected: 'same y', actual: frames });
      expect(frames[2].x > frames[1].x + frames[1].width + 32, '建立／開啟與資料操作群組分居左右',
        { id: 'vault.actions.groups', expected: 'separated groups', actual: frames });
      await themed('vault-actions');
      await click('vault-export');
      await button('export-path').fill(exportPath);
      await shot('export-input');
      await click('export-confirm');
      await visible('export-result-path');
      expect((await button('export-result-path').innerText()).trim() === exportPath, '顯示匯出結果路徑');
      const original = await readFile(exportPath);
      expect(original.subarray(0, 2).toString() === 'PK', '實際寫出 zip');
      await shot('export-done');
      await click('transfer-close');
      await click('vault-export');
      await button('export-path').fill(exportPath);
      await click('export-confirm');
      await visible('export-exists');
      await shot('export-exists');
      await click('export-keep');
      expect(original.equals(await readFile(exportPath)), '保留後 zip 位元不變');
      await click('export-confirm');
      await visible('export-exists');
      await click('export-replace');
      await visible('export-result-path');
      expect((await instance.api('/api/vault/status')).state === 'completed', '覆蓋完成');
      await click('transfer-close');
    });

    await record.scenario('R102-2', '合併、完全取代與沒有需要匯入；完成後可立刻再操作', async ({ expect, shot }) => {
      const before = await backupNames();
      await compareThroughUI(donorZip);
      await shot('merge-preview');
      await click('import-confirm');
      await visible('import-done');
      await shot('merge-done');
      await click('transfer-close');
      await documents(expect, 2);
      expect((await backupNames()).length > before.length, '寫出匯入前備份');
      await compareThroughUI(donorZip);
      if (await button('import-replace-instead').count()) await click('import-replace-instead');
      else { await click('import-mode-replace'); await click('import-next'); }
      await visible('import-replace-confirm');
      expect((await button('import-replace-counts').innerText()).includes('1'), '完全取代確認列出移除數');
      await shot('replace-confirm');
      await click('import-replace-confirm-button');
      await visible('import-done');
      await shot('replace-done');
      await click('transfer-close');
      await documents(expect, 1);
      const selfZip = path.join(instance.runDir, 'exports', 'self.zip');
      await exportThroughUI(selfZip);
      await click('transfer-close');
      await compareThroughUI(selfZip);
      expect(await button('import-nothing').count() === 1, '自己匯出的 zip 沒有需要匯入的內容');
      await shot('nothing');
      await click('import-close');
    });

    await record.scenario('R102-3', '開啟其他知識庫', async ({ expect, shot }) => {
      await click('vault-open-other');
      await button('open-vault-path').fill(donorRoot);
      await shot('open-path');
      await click('open-vault-confirm');
      await visible('open-vault-result-path');
      expect((await button('open-vault-result-path').innerText()).trim() === donorRoot, '切換到其他 Vault');
      await shot('open-done');
      await click('transfer-close');
      await documents(expect, 2);
      await click('nav-documents');
      await waitFor(async () => await page.locator('.document-title').count() === 2, 'other Vault document titles');
      const titles = await page.locator('.document-title').allInnerTexts();
      expect(titles.length === 2 && titles.every((title) => title.includes('頻道 B')), '其他 Vault 顯示兩份 B 的文件，原 Vault 的一份內容已替換');
      await settings();
    });

    await record.scenario('R102-4', '收集中匯入：等待、裝置資料可讀、恢復收集', async ({ expect, shot }) => {
      await instance.updateCatalog((catalog) => { catalog.youtube.captureDelayMs = 6000; });
      await subscribe(instance, 'https://www.youtube.com/@verify-a');
      await waitFor(async () => {
        const stored = JSON.parse(await readFile(path.join(instance.runDir, 'profile', 'jobs', 'jobs.json'), 'utf8'));
        const pacing = await instance.api('/api/pacing');
        return stored.jobs.some((job) => job.kind === 'youtube.video' && job.state === 'running' && job.phase === 'capture')
          && pacing.groups.some((group) => group.group === 'youtube' && group.state === 'busy');
      }, 'capture running');
      await click('vault-import');
      await button('import-path').fill(exportPath);
      await click('import-compare');
      await waitFor(async () => (await instance.api('/api/vault/status')).state === 'waiting', 'import waiting');
      await visible('transfer-cancel');
      const jobs = await instance.api('/api/jobs/overview');
      const activity = await instance.api('/api/activity');
      const summary = await instance.api('/api/activity?view=summary');
      expect(!!jobs.overview && Array.isArray(activity.events) && Array.isArray(summary.entries), '等待期間工作、原始活動與摘要 API 可讀');
      await shot('waiting');
      await click('transfer-cancel');
      await waitFor(async () => (await instance.api('/api/vault/status')).state === 'idle', 'cancel waiting releases operation lock');
      expect((await instance.api('/api/vault/status')).state === 'idle', '取消等待後立即釋放操作鎖');
      await visible('import-compare');
      await shot('cancelled-wait');
      await click('import-compare');
      const jobsPage = await openPage('/jobs');
      expect(await jobsPage.getByTestId('page-jobs').count() === 1, '等待期間工作頁可讀');
      await shot('jobs-during-wait', jobsPage);
      await visible('import-preview');
      // Collection resumes after comparison and changes the local items. Compare those finished
      // items again before applying, as required by the import's stale-comparison contract.
      await idle(instance);
      await click('import-cancel');
      await compareThroughUI(exportPath);
      await click('import-confirm');
      await visible('import-done');
      await shot('import-done');
      await click('transfer-close');
      await idle(instance);
      const subscriptions = (await instance.api('/api/subscriptions')).subscriptions;
      const source = subscriptions.find((entry) => entry.id === 'UCverifyAAAAAAAAAAAAAAAA');
      expect(source?.checkStatus?.state === 'scheduled', '匯入後訂閱完成檢查');
      const state = await instance.state();
      expect(state.vault.documents?.length === 8, '收集恢復並保存五份 A、兩份 B 與匯入的 D');
      await click('nav-sources');
      await page.getByTestId('page-sources').waitFor();
      await waitFor(async () => (await page.getByTestId('source-row-UCverifyAAAAAAAAAAAAAAAA').innerText()).includes('下次'), 'subscription scheduled on screen');
      await shot('collection-resumed');
    });

    await record.scenario('R102-5', '固定位置禁止建立或開啟其他知識庫', async ({ expect, shot }) => {
      fixed = await launchWeb({ issue: instance.issue, checkout: instance.checkout, vault: 'fixed', label: `${instance.label ?? 'transfer'}-fixed` });
      fixedView = await openWebPage(fixed, { route: '/settings' });
      const fixedPage = fixedView.page;
      await fixedPage.getByTestId('vault-relocation-unavailable').waitFor();
      expect(await fixedPage.getByTestId('vault-open-other').isDisabled(), '固定位置的開啟其他停用');
      expect(await fixedPage.getByTestId('vault-create').isDisabled(), '固定位置的建立新的知識庫停用');
      await shot('fixed', fixedPage);
    });
  } finally {
    await fixedView?.close();
    await fixed?.stop();
    await donor?.stop();
  }
}
