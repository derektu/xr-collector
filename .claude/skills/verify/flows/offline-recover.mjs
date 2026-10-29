// The device losing its network while channel A downloads and channel B comes due, then getting it
// back: the offline message and the controls it disables, 立即檢查 refused, subscription rows that
// never show an error, nothing dispatched or failed while offline, and after recovery one check of
// B and A finishing. The catalog's `network: 'offline'` cuts the synthetic sources and the
// runtime's network probe off together.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collect, idle, subscribe } from '../scripts/lib/index.mjs';
import { watch, watched } from './lib/watch.mjs';

export const name = 'offline-recover';
export const title = '斷網與恢復';
export const tier = 'feature';
export const covers = ['sub-status', 'sub-check', 'sub-offline'];

/** Every subscription row's status text, by row test ID; runs inside the page. */
const subscriptionStatuses = () => Object.fromEntries([...document.querySelectorAll('[data-testid^="source-row-"]')]
  .map((row) => [row.dataset.testid, (row.querySelector('.status-chip')?.textContent ?? '').trim()]));

/** Whether the offline message shows, and its text; runs inside the page. */
const bannerState = () => ({ banner: document.querySelector('[data-testid="offline-banner"]')?.textContent?.trim() ?? '' });

const OFFLINE_REFUSED = '目前沒有網路，恢復後再試。';
const UNAVAILABLE = '沒有網路時無法使用';

export async function run({ instance, page, openPage, record, waitFor }) {
  const catalog = await instance.catalog();
  const [a, b, d] = ['verify-a', 'verify-b', 'verify-d'].map((handle) => catalog.youtube.channels.find((source) => source.handle === handle));
  const rowOf = (source) => `source-row-${source.id}`;
  const channelsFile = path.join(instance.runDir, 'vault', 'settings', 'youtube-channels.json');
  const apiStatus = async (source) => (await instance.api('/api/subscriptions')).subscriptions.find((entry) => entry.id === source.id)?.checkStatus ?? null;
  const connectivity = async () => (await instance.api('/api/health')).connectivity ?? null;
  const events = async (since, eventType) => (await instance.api(`/api/activity?limit=100&since=${encodeURIComponent(since)}${eventType ? `&eventType=${eventType}` : ''}`)).events;
  const jobCount = async () => (await instance.api('/api/jobs?state=all&limit=100')).jobs.length;
  const disabled = async (target, testId) => target.getByTestId(testId).first().isDisabled();
  let offlineAt;
  let jobsPage;
  let documentsPage;

  await record.scenario('OFF-1', '準備：B 檢查完成、A 下載中，工作頁有一個失敗項目', async ({ expect }) => {
    // A failed single item gives the Jobs page a 重試 button to disable.
    const failing = d.videos[1].id;
    await instance.updateCatalog((current) => { current.youtube.failVideo = failing; });
    await collect(instance, `https://www.youtube.com/watch?v=${failing}`);
    await subscribe(instance, `https://www.youtube.com/@${b.handle}`);
    await idle(instance);
    await instance.updateCatalog((current) => { current.youtube.captureDelayMs = 2500; });
    await subscribe(instance, `https://www.youtube.com/@${a.handle}`);
    await waitFor(async () => {
      const status = await apiStatus(a);
      return status?.state === 'downloading' && status.done >= 1;
    }, 'A downloading', { timeout: 60_000 });
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('page-sources').waitFor();
    await watch(page, 'status', subscriptionStatuses);
    await watch(page, 'banner', bannerState);
    const state = await connectivity();
    expect(state?.state === 'online', '開始時 health 的 connectivity 為 online', { id: 'start.online', expected: 'online', actual: state });
  });

  await record.scenario('OFF-2', '斷網：全域訊息、停用的按鈕、立即檢查被拒絕、不派工也不失敗', async ({ expect, shot, note }) => {
    offlineAt = new Date().toISOString();
    await instance.updateCatalog((current) => { current.network = 'offline'; });
    // B comes due while the device is offline.
    const channels = JSON.parse(await readFile(channelsFile, 'utf8'));
    const entry = (channels.channels ?? channels.subscriptions ?? []).find((candidate) => candidate.id === b.id);
    if (!entry) throw new Error(`B is not in ${channelsFile}`);
    entry.nextCheckAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(channelsFile, `${JSON.stringify(channels, null, 2)}\n`);

    // A's capture under way loses the network and the confirmation finds it gone.
    const banner = page.getByTestId('offline-banner');
    await banner.waitFor({ timeout: 30_000 });
    const text = (await banner.innerText()).trim();
    expect(/^目前沒有網路，恢復後自動檢查。（\d{2}:\d{2} 確認）$/u.test(text), '頁面上方顯示沒有網路的訊息與確認時間',
      { id: 'offline.banner', expected: '目前沒有網路，恢復後自動檢查。（HH:MM 確認）', actual: text });
    const state = await connectivity();
    expect(state?.state === 'offline' && typeof state.checkedAt === 'string', 'health 的 connectivity 為 offline 並有確認時間',
      { id: 'offline.health', expected: 'offline', actual: state });

    const addDisabled = await disabled(page, 'add-subscription');
    const addTitle = await page.getByTestId('add-subscription').getAttribute('title');
    expect(addDisabled && addTitle === UNAVAILABLE, '「新增訂閱」停用並提示沒有網路時無法使用', { id: 'offline.add-subscription', expected: [true, UNAVAILABLE], actual: [addDisabled, addTitle] });
    const checkEnabled = !(await disabled(page, 'check-all'));
    expect(checkEnabled, '「立即檢查」保持可按', { id: 'offline.check-all.enabled', expected: true, actual: checkEnabled });
    await shot('sources-offline');

    documentsPage = await openPage('/documents');
    await documentsPage.getByTestId('offline-banner').waitFor({ timeout: 15_000 });
    const documentAdd = await disabled(documentsPage, 'add-document');
    expect(documentAdd, '文件頁「新增」停用', { id: 'offline.add-document', expected: true, actual: documentAdd });
    await shot('documents-offline', documentsPage);

    jobsPage = await openPage('/jobs');
    await jobsPage.getByTestId('offline-banner').waitFor({ timeout: 15_000 });
    await jobsPage.getByTestId('job-retry').first().waitFor({ timeout: 15_000 });
    const retry = await disabled(jobsPage, 'job-retry');
    expect(retry, '工作頁失敗項目的「重試」停用', { id: 'offline.job-retry', expected: true, actual: retry });
    await shot('jobs-offline', jobsPage);

    // 立即檢查 confirms the network and is refused while it is still gone.
    const before = await jobCount();
    await waitFor(async () => (await page.getByTestId('notice').count()) === 0, 'no toast over the page', { timeout: 15_000 });
    await page.getByTestId('check-all').click();
    const notice = page.getByTestId('notice');
    await notice.waitFor({ timeout: 15_000 });
    const noticeText = (await notice.innerText()).trim();
    expect(noticeText === OFFLINE_REFUSED, '按「立即檢查」顯示目前沒有網路', { id: 'offline.check-all.refused', expected: OFFLINE_REFUSED, actual: noticeText });
    const after = await jobCount();
    expect(after === before, '立即檢查沒有開始工作', { id: 'offline.check-all.no-job', expected: before, actual: after });
    await shot('check-all-refused');

    // Two scheduler polls finish with B due; the verify server names each finished poll in
    // schedule-trigger.done.
    const trigger = path.join(instance.runDir, 'schedule-trigger');
    for (let poll = 0; poll < 2; poll += 1) {
      const value = `${Date.now()}-${poll}-${Math.random()}\n`;
      await writeFile(trigger, value);
      await waitFor(async () => (await readFile(`${trigger}.done`, 'utf8').catch(() => '')) === value, `scheduler poll ${poll + 1} finished`, { timeout: 15_000 });
    }
    const during = (await events(offlineAt)).map((event) => ({ eventType: event.eventType, pauseReason: event.pauseReason }));
    note('eventsOffline', during);
    const paused = during.filter((event) => event.eventType === 'collection.paused');
    expect(paused.length === 1 && paused[0].pauseReason === 'offline', '記錄一筆 collection.paused（offline）', { id: 'offline.paused-event', expected: 1, actual: paused });
    const forbidden = during.filter((event) => ['schedule.dispatched', 'job.failed', 'job.retry_scheduled'].includes(event.eventType)).map((event) => event.eventType);
    expect(forbidden.length === 0, '斷網期間沒有派工、失敗或排定重試', { id: 'offline.no-dispatch-or-failure', expected: [], actual: forbidden });
    const bStatus = await apiStatus(b);
    note('bStatusOffline', bStatus);
  });

  await record.scenario('OFF-3', '恢復：訊息消失、按鈕可按、B 檢查一次、A 完成，列上從未出現錯誤', async ({ expect, shot, note }) => {
    const restoredAt = new Date().toISOString();
    await instance.updateCatalog((current) => { current.network = 'online'; });
    await page.getByTestId('offline-banner').waitFor({ state: 'detached', timeout: 30_000 });
    const state = await connectivity();
    expect(state?.state === 'online', 'health 的 connectivity 回到 online', { id: 'online.health', expected: 'online', actual: state });
    const addEnabled = !(await disabled(page, 'add-subscription'));
    expect(addEnabled, '「新增訂閱」恢復可按', { id: 'online.add-subscription', expected: true, actual: addEnabled });

    await waitFor(async () => (await apiStatus(a))?.state === 'scheduled' && (await apiStatus(b))?.state === 'scheduled', 'A and B scheduled', { timeout: 120_000 });
    await idle(instance);
    const after = await events(restoredAt);
    const resumed = after.filter((event) => event.eventType === 'collection.resumed');
    expect(resumed.length === 1 && resumed[0].pauseReason === 'offline', '記錄一筆 collection.resumed（offline）', { id: 'online.resumed-event', expected: 1, actual: resumed.length });
    const dispatched = after.filter((event) => event.eventType === 'schedule.dispatched');
    expect(dispatched.length === 1, '恢復後 schedule.dispatched 剛好一次', { id: 'online.dispatched-once', expected: 1, actual: dispatched.length });
    const sinceOffline = (await instance.api('/api/jobs?state=all&limit=100')).jobs
      .filter((job) => job.kind === 'youtube.channel' && job.source.id === b.id && job.createdAt >= offlineAt);
    expect(sinceOffline.length === 1 && sinceOffline[0].state === 'completed', 'B 在斷網後剛好一個檢查工作並完成',
      { id: 'online.b-checked-once', expected: 1, actual: sinceOffline.map((job) => job.state) });
    const failures = (await events(offlineAt)).filter((event) => ['job.failed', 'job.retry_scheduled'].includes(event.eventType)).map((event) => event.eventType);
    expect(failures.length === 0, '斷網到恢復後都沒有失敗或排定重試', { id: 'online.no-failure', expected: [], actual: failures });

    // The list reloads on the screen's next poll after the last capture.
    const documentsOf = async () => (await page.getByTestId(rowOf(a)).locator('[role="cell"].numeric').innerText()).trim();
    const count = await waitFor(async () => {
      const value = await documentsOf();
      return value === String(a.videos.length) ? value : null;
    }, 'A row documents', { timeout: 15_000 }).catch(documentsOf);
    expect(count === String(a.videos.length), `A 的列顯示 ${a.videos.length} 份文件`, { id: 'online.a.documents', expected: String(a.videos.length), actual: count });

    const statuses = await watched(page, 'status');
    const errors = Object.fromEntries(Object.entries(statuses).map(([row, samples]) => [row, samples.map((sample) => sample.value).filter((value) => value.includes('錯誤'))]));
    note('statusSequences', Object.fromEntries(Object.entries(statuses).map(([row, samples]) => [row, samples.map((sample) => sample.value)])));
    const shown = Object.values(errors).flat();
    expect(shown.length === 0, '整段期間訂閱列沒有出現「錯誤」', { id: 'rows.no-error', expected: [], actual: errors });
    const banner = (await watched(page, 'banner')).banner?.map((sample) => sample.value !== '') ?? [];
    note('bannerSequence', banner);
    await shot('recovered');
    await jobsPage?.close();
    await documentsPage?.close();
  });
}
