// Routine scheduled checks collapse into result runs on subscription detail and the Activity page;
// detail keeps exact per-check events, raw mode stays available, and back preserves filters.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { idle, subscribe } from '../scripts/lib/index.mjs';

export const name = 'check-history-summary';
export const title = '定時檢查摘要與完整細節';
export const tier = 'feature';
export const covers = ['sub-detail', 'sub-failure', 'activity-summary', 'activity-detail', 'activity-raw'];

const CHECK_TIMEOUT = 30_000;

/** A quick, independently runnable L6 check over verify-b's exact three-document first batch. */
export async function verifyThreeDocumentLifecycle({ instance, page, record, waitFor }) {
  const source = (await instance.catalog()).youtube.channels.find((candidate) => candidate.handle === 'verify-b');
  await record.scenario('HISTORY-L6', '一批三份文件的 INFO 生命週期與 DEBUG 內部事件', async ({ expect, shot }) => {
    await subscribe(instance, `https://www.youtube.com/@${source.handle}`);
    await idle(instance);
    await page.getByTestId('nav-activity').click();
    await page.getByTestId('activity-summary').waitFor();
    await page.getByTestId('activity-summary').click();
    await page.getByTestId('log-type').selectOption('all');
    await page.getByTestId('log-level').selectOption('info');
    await waitFor(async () => await page.getByTestId('log-source').locator(`option[value="${source.id}"]`).count() === 1, 'three-document subscription filter');
    await page.getByTestId('log-source').selectOption(source.id);
    await page.getByTestId('log-range').selectOption('30d');
    await waitFor(async () => (await page.getByTestId('activity-log').innerText()).includes('完成收集：新增 3 支影片'), 'three-document summary lifecycle');
    const summary = await page.getByTestId('activity-log').innerText();
    expect((summary.match(/新增訂閱：/gu) ?? []).length === 1, '摘要有一筆新增訂閱');
    expect((summary.match(/開始收集/gu) ?? []).length === 1, '摘要有一筆主要收集開始');
    expect((summary.match(/已新增文件/gu) ?? []).length === 3, '摘要有三筆文件新增');
    expect((summary.match(/完成收集：新增 3 支影片/gu) ?? []).length === 1, '摘要有一筆三支影片的收集完成');

    await page.getByTestId('activity-raw').click();
    await waitFor(async () => await page.getByTestId('log-row').count() >= 5, 'three-document INFO events');
    const info = await page.getByTestId('activity-log').innerText();
    expect((info.match(/開始收集/gu) ?? []).length === 1, 'INFO 完整事件只有一筆主要開始');
    expect((info.match(/已新增文件/gu) ?? []).length === 3, 'INFO 完整事件有三筆文件新增');
    expect((info.match(/完成收集：新增 3 支影片/gu) ?? []).length === 1, 'INFO 完整事件只有一筆主要完成');
    expect(!info.includes('加入收集佇列'), 'INFO 以上不含 DEBUG 佇列事件');
    await shot('lifecycle-three-info');

    await page.getByTestId('log-level').selectOption('debug');
    await waitFor(async () => (await page.getByTestId('activity-log').innerText()).includes('加入收集佇列'), 'three-document DEBUG events');
    expect(await page.locator('.log-level').filter({ hasText: 'DEBUG' }).count() > 0, 'DEBUG 以上可查到內部事件');
    await shot('lifecycle-three-debug');
  });
}

export async function run({ instance, page, openPage, record, waitFor }) {
  const catalog = await instance.catalog();
  const source = catalog.youtube.channels.find((candidate) => candidate.handle === 'verify-a');
  const subscriptionsFile = path.join(instance.runDir, 'vault', 'settings', 'youtube-channels.json');
  const jobs = async () => (await instance.api('/api/jobs?state=all&limit=100')).jobs
    .filter((job) => job.kind === 'youtube.channel' && job.source.id === source.id);
  const summaryAvailable = await page.getByTestId('nav-activity').click().then(async () => {
    await page.getByTestId('activity-log').waitFor();
    return await page.getByTestId('activity-summary').count() === 1;
  });
  await record.scenario('HISTORY-NEW', '記錄頁提供預設摘要與完整事件切換', async ({ expect }) => {
    expect(summaryAvailable, '記錄頁有「摘要」切換', { id: 'new.summary-toggle', expected: true, actual: summaryAvailable });
    expect(await page.getByTestId('log-type').locator('option').allInnerTexts().then((values) => values.includes('新增文件')), '紀錄類型使用「新增文件」');
    expect(await page.getByTestId('log-level').inputValue() === 'info', '預設為 INFO 以上');
    const summaryBox = await page.getByTestId('activity-summary').boundingBox();
    const levelBox = await page.getByTestId('log-level').boundingBox();
    expect(Boolean(summaryBox && levelBox && Math.abs((summaryBox.y + summaryBox.height / 2) - (levelBox.y + levelBox.height / 2)) <= 2), '摘要切換與篩選垂直置中');
    const typeSelect = page.getByTestId('log-type');
    await typeSelect.click();
    expect(await typeSelect.evaluate((element) => getComputedStyle(element).outlineStyle === 'none'), '滑鼠點選紀錄類型不顯示鍵盤焦點框');
    await page.keyboard.press('Escape');
    expect(await typeSelect.evaluate((element) => getComputedStyle(element).outlineStyle !== 'none'), '鍵盤操作紀錄類型仍顯示焦點框');
    const sourceSelect = page.getByTestId('log-source');
    await sourceSelect.click();
    expect(await sourceSelect.evaluate((element) => getComputedStyle(element).outlineStyle === 'none'), '滑鼠點選訂閱不顯示鍵盤焦點框');
    await page.keyboard.press('Escape');
    expect(await sourceSelect.evaluate((element) => getComputedStyle(element).outlineStyle !== 'none'), '鍵盤操作訂閱仍顯示焦點框');
    const levelSelect = page.getByTestId('log-level');
    await levelSelect.click();
    expect(await levelSelect.evaluate((element) => getComputedStyle(element).outlineStyle === 'none'), '滑鼠點選等級不顯示鍵盤焦點框');
    await page.keyboard.press('Escape');
    expect(await levelSelect.evaluate((element) => getComputedStyle(element).outlineStyle !== 'none'), '鍵盤操作等級仍顯示焦點框');
    const rangeSelect = page.getByTestId('log-range');
    await rangeSelect.click();
    expect(await rangeSelect.evaluate((element) => getComputedStyle(element).outlineStyle === 'none'), '滑鼠點選時間不顯示鍵盤焦點框');
    await page.keyboard.press('Escape');
    expect(await rangeSelect.evaluate((element) => getComputedStyle(element).outlineStyle !== 'none'), '鍵盤操作時間仍顯示焦點框');
  });
  if (!summaryAvailable) return;

  const scheduledCheck = async () => {
    const before = new Set((await jobs()).map((job) => job.id));
    const file = JSON.parse(await readFile(subscriptionsFile, 'utf8'));
    const row = file.channels.find((candidate) => candidate.id === source.id);
    row.nextCheckAt = new Date(Date.now() - 1_000).toISOString();
    await writeFile(subscriptionsFile, `${JSON.stringify(file, null, 2)}\n`);
    await writeFile(path.join(instance.runDir, 'schedule-trigger'), `${Date.now()}-${Math.random()}\n`);
    return waitFor(async () => {
      const job = (await jobs()).find((candidate) => !before.has(candidate.id) && candidate.scope?.trigger === 'scheduled');
      return job && (job.state === 'completed' || job.state === 'failed') ? job : null;
    }, 'scheduled check settled', { timeout: CHECK_TIMEOUT });
  };

  await record.scenario('HISTORY-W1', '例行無新內容、網路錯誤、恢復各自成組，詳情與記錄摘要一致', async ({ expect, shot }) => {
    await subscribe(instance, `https://www.youtube.com/@${source.handle}`);
    await idle(instance);
    for (let index = 0; index < 12; index += 1) expect((await scheduledCheck()).state === 'completed', `第 ${index + 1} 次無新內容檢查完成`);
    await instance.updateCatalog((current) => { current.youtube.failListing = source.id; });
    for (let index = 0; index < 2; index += 1) expect((await scheduledCheck()).state === 'failed', `第 ${index + 1} 次網路錯誤檢查完成`);
    await instance.updateCatalog((current) => { current.youtube.failListing = null; });
    expect((await scheduledCheck()).state === 'completed', '恢復後無新內容檢查完成');

    const detail = await openPage(`/sources/youtube/${encodeURIComponent(source.id)}`);
    await detail.getByTestId('source-detail').waitFor();
    const groups = detail.getByTestId('collection-check-group');
    expect(await groups.count() === 2, '訂閱詳情恰有兩組例行檢查結果');
    expect(await detail.getByTestId('collection-check').filter({ hasText: '完成檢查：沒有新影片' }).count() === 1, '恢復後的單次檢查維持單次顯示');
    expect((await groups.allInnerTexts()).some((text) => text.includes('沒有新影片・12 次')), '無新影片組顯示 12 次');
    expect((await groups.allInnerTexts()).some((text) => text.includes('網路錯誤・2 次')), '網路錯誤組顯示 2 次');
    expect((await detail.getByTestId('collection-check').allInnerTexts())[0].includes('完成檢查：沒有新影片'), '最新的恢復檢查排最前且不加 1 次');
    await shot('subscription-summary', detail);

    await page.getByTestId('nav-activity').click();
    await page.getByTestId('activity-summary').waitFor();
    const rows = page.getByTestId('summary-check');
    await waitFor(async () => {
      const text = await rows.allInnerTexts();
      return text.some((row) => row.includes('網路錯誤・2 次'))
        && text.some((row) => row.includes('沒有新影片・12 次'))
        && text.some((row) => row.includes('完成檢查：沒有新影片') && !row.includes('12 次'))
        && text.some((row) => row.includes('完成收集：新增'));
    }, 'recovery, grouped checks, and initial collection summary loaded');
    expect((await rows.allInnerTexts()).some((text) => text.includes('網路錯誤・2 次')), '記錄摘要顯示網路錯誤 2 次');
    const summaryText = await page.getByTestId('activity-log').innerText();
    expect((summaryText.match(/新增訂閱：/gu) ?? []).length === 1, '摘要只顯示一次新增訂閱');
    expect((summaryText.match(/開始收集/gu) ?? []).length === 1, '摘要只顯示一次非例行收集開始');
    expect(summaryText.includes('完成收集：新增'), '摘要顯示一次有單位的收集完成結果');
    expect(!summaryText.includes('首次收集') && !summaryText.includes('已接受收集工作'), '摘要沒有內部觸發與接受工作的雜訊');
    await shot('activity-summary');
  });

  await record.scenario('HISTORY-W2', '查看群組細節、載入每次事件、切換完整事件並返回保留篩選', async ({ expect, shot }) => {
    const detail = await openPage(`/sources/youtube/${encodeURIComponent(source.id)}`);
    const emptyGroup = detail.getByTestId('collection-check-group').filter({ hasText: '沒有新影片・12 次' });
    await emptyGroup.getByRole('link', { name: '查看細節' }).click();
    await detail.getByTestId('activity-group-context').waitFor();
    expect(await detail.getByTestId('activity-group-check').count() === 10, '先載入 10 次檢查');
    expect((await detail.getByTestId('activity-group-context').locator('..').innerText()).includes('已顯示 10 次，共 12 次收集'), '分頁前顯示已載入與總收集次數');
    const groupLevel = detail.getByTestId('group-level');
    let releaseOlder;
    let markOlder;
    const olderStarted = new Promise((resolve) => { markOlder = resolve; });
    const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
    await detail.route(/\/api\/activity\/groups\/.*cursor=/u, async (route) => {
      markOlder();
      await olderGate;
      await route.continue().catch(() => undefined);
    }, { times: 1 });
    await detail.getByRole('button', { name: '載入更早的檢查' }).click();
    await olderStarted;
    await groupLevel.selectOption('error');
    await waitFor(async () => await detail.getByTestId('activity-group-check').count() === 10, 'new level wins while older page is delayed');
    releaseOlder();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await detail.getByTestId('activity-group-check').count() === 10, '舊等級的延遲分頁不會混入新等級');
    await groupLevel.selectOption('info');
    await waitFor(async () => await detail.getByTestId('activity-group-check').count() === 10, 'info detail reloaded');
    await detail.getByRole('button', { name: '載入更早的檢查' }).click();
    await waitFor(async () => await detail.getByTestId('activity-group-check').count() === 12, 'twelve group checks loaded');
    expect((await detail.getByTestId('activity-group-context').locator('..').innerText()).includes('共 12 次收集'), '載入完成不顯示比例');
    await groupLevel.selectOption('error');
    await waitFor(async () => await detail.getByTestId('activity-group-check').count() === 12, 'loaded group count preserved after level change');
    expect(await detail.getByTestId('activity-group-check').count() === 12, '細節切 ERROR 後仍保留已載入 12 次');
    expect(await detail.getByText('這次收集沒有符合等級的事件。').count() === 12, '沒有 ERROR 的成員明示空事件且不消失');
    await groupLevel.click();
    expect(await groupLevel.evaluate((element) => getComputedStyle(element).outlineStyle === 'none'), '細節的等級選單滑鼠點選不顯示鍵盤框');
    await detail.keyboard.press('Escape');
    expect(await groupLevel.evaluate((element) => getComputedStyle(element).outlineStyle !== 'none'), '細節的等級選單保留鍵盤焦點框');
    await groupLevel.selectOption('info');
    await detail.getByRole('button', { name: '返回' }).click();
    await detail.getByTestId('source-detail').waitFor();
    expect(await detail.getByTestId('collection-check-group').count() === 2
      && await detail.getByTestId('collection-check').filter({ hasText: '完成檢查：沒有新影片' }).count() === 1, '返回訂閱詳情仍見三段結果');
    await detail.close();

    await page.getByTestId('nav-activity').click();
    await page.getByTestId('activity-summary').waitFor();
    await page.getByTestId('log-level').selectOption('warning');
    const errorRow = page.getByTestId('summary-check').filter({ hasText: '網路錯誤・2 次' });
    await errorRow.getByRole('button', { name: '查看細節' }).click();
    await page.getByTestId('activity-group-context').waitFor();
    expect(await page.getByTestId('activity-group-check').count() === 2, '細節只有這組的兩次檢查');
    expect((await page.getByTestId('activity-group-check').allInnerTexts()).every((text) => text.includes('網路錯誤')), '每次檢查保留個別錯誤與重試');
    expect(await page.getByTestId('activity-group-check').first().getByTestId('log-row').first().locator('.log-level').innerText() === 'ERROR', '每次細節由最新事件開始並只用 ERROR 等級');
    await shot('group-detail');
    await page.getByRole('button', { name: '返回' }).click();
    expect(await page.getByTestId('log-level').inputValue() === 'warning', '返回保留 WARN 以上');
    await page.reload();
    await page.getByTestId('activity-summary').waitFor();
    await waitFor(async () => await page.getByTestId('summary-check').filter({ hasText: '網路錯誤・2 次' }).count() === 1, 'refreshed error summary loaded');
    expect(await page.getByTestId('summary-check').filter({ hasText: '網路錯誤・2 次' }).count() === 1, '重新整理後摘要仍是最新的 2 次');
    await page.getByTestId('log-level').selectOption('info');
    await page.getByTestId('activity-raw').click();
    await waitFor(async () => await page.getByTestId('log-row').count() > 2, 'raw events loaded');
    expect(await page.getByTestId('log-row').count() > 2, '完整事件顯示未合併的每次事件');
    let rawText = await page.getByTestId('activity-log').innerText();
    for (let pageIndex = 0; pageIndex < 4 && (!rawText.includes('已新增文件') || !rawText.includes('完成收集')); pageIndex += 1) {
      const older = page.getByTestId('load-older');
      if (await older.count() === 0) break;
      const before = await page.getByTestId('log-row').count();
      await older.click();
      await waitFor(async () => await page.getByTestId('log-row').count() > before, 'older raw events loaded');
      rawText = await page.getByTestId('activity-log').innerText();
    }
    expect(rawText.includes('開始收集') && rawText.includes('已新增文件') && rawText.includes('完成收集'), '預設 INFO 以上保留主要生命週期');
    expect(!rawText.includes('加入收集佇列'), '預設 INFO 以上隱藏 DEBUG 佇列事件');
    expect((await page.locator('.log-level').allInnerTexts()).every((value) => ['INFO', 'WARN', 'ERROR'].includes(value)), '預設完整事件只有 INFO/WARN/ERROR');
    await page.getByTestId('log-level').selectOption('debug');
    await waitFor(async () => (await page.getByTestId('activity-log').innerText()).includes('加入收集佇列'), 'debug events loaded');
    rawText = await page.getByTestId('activity-log').innerText();
    expect(rawText.includes('加入收集佇列') && await page.locator('.log-level').filter({ hasText: 'DEBUG' }).count() > 0, 'DEBUG 以上可查到先前已記錄的內部事件');
    expect((await page.locator('.log-level').allInnerTexts()).every((value) => ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(value)), '完整事件沒有 SAVE/DONE/SKIP/ERR');
    await shot('raw-events');
    await page.getByTestId('activity-summary').click();
    await page.getByTestId('log-type').selectOption('documents');
    await page.getByTestId('log-level').selectOption('error');
    await waitFor(async () => await page.getByText('這段期間沒有符合的記錄。').count() === 1, 'empty document error intersection');
    expect(await page.getByTestId('activity-summary').getAttribute('aria-pressed') === 'true', '新增文件＋ERROR 空交集仍保留摘要');
    await page.getByTestId('activity-raw').click();
    await page.getByTestId('log-source').selectOption(source.id);
    await page.getByTestId('log-range').selectOption('today');
    await page.reload();
    await page.getByTestId('activity-log').waitFor();
    expect(await page.getByTestId('activity-raw').getAttribute('aria-pressed') === 'true'
      && await page.getByTestId('log-type').inputValue() === 'documents'
      && await page.getByTestId('log-level').inputValue() === 'error'
      && await page.getByTestId('log-source').inputValue() === source.id
      && await page.getByTestId('log-range').inputValue() === 'today', '重新整理保留模式、類型、等級、訂閱與時間');
    await shot('empty-filter');
  });

  await verifyThreeDocumentLifecycle({ instance, page, record, waitFor });
}
