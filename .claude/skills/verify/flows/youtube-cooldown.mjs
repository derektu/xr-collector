// YouTube limiting requests while channel A downloads: the YouTube request channel cools down,
// the video that met the limit waits without spending an attempt, A's row and the Jobs page say
// when collection goes on, a video submitted during the cooldown waits with it, and once the
// cooldown ends everything finishes by itself. The synthetic YouTube cools down for 30 seconds.
import { collect, idle, subscribe } from '../scripts/lib/index.mjs';
import { watch, watched } from './lib/watch.mjs';

export const name = 'youtube-cooldown';
export const title = 'YouTube 限制連線與冷卻';
export const tier = 'feature';
export const covers = ['sub-status', 'jobs-row-text'];

/** Every subscription row's status text, by row test ID; runs inside the page. */
const subscriptionStatuses = () => Object.fromEntries([...document.querySelectorAll('[data-testid^="source-row-"]')]
  .map((row) => [row.dataset.testid, (row.querySelector('.status-chip')?.textContent ?? '').trim()]));

const RETRYING = /^錯誤・\d{2}:\d{2} 重試$/u;

export async function run({ instance, page, openPage, record, waitFor }) {
  // Slower capture keeps A downloading when the limit comes.
  await instance.updateCatalog((catalog) => { catalog.youtube.captureDelayMs = 1500; });
  const catalog = await instance.catalog();
  const [a, d] = ['verify-a', 'verify-d'].map((handle) => catalog.youtube.channels.find((source) => source.handle === handle));
  const rowOf = (source) => `source-row-${source.id}`;
  const youtubeChannel = async () => (await instance.api('/api/pacing')).groups.find((group) => group.group === 'youtube');
  const apiStatus = async () => (await instance.api('/api/subscriptions')).subscriptions.find((entry) => entry.id === a.id)?.checkStatus ?? null;
  const jobs = async () => (await instance.api('/api/jobs?state=all&limit=100')).jobs;
  const checkOfA = async () => (await jobs()).find((job) => job.kind === 'youtube.channel' && job.source.id === a.id);
  const events = async (eventType) => (await instance.api(`/api/activity?limit=50&eventType=${eventType}`)).events;
  const documents = async () => (await instance.state()).vault.documents.length;
  let cooldownUntil;
  let single;

  await page.getByTestId('nav-sources').click();
  await page.getByTestId('page-sources').waitFor();
  await watch(page, 'status', subscriptionStatuses);

  await record.scenario('YC-1', '準備：訂閱頻道 A，A 下載中', async ({ expect }) => {
    await subscribe(instance, `https://www.youtube.com/@${a.handle}`);
    const downloading = await waitFor(async () => {
      const status = await apiStatus();
      return status?.state === 'downloading' && status.done >= 1 ? status : null;
    }, 'A downloaded one video', { timeout: 30_000 }).catch(() => null);
    expect(downloading !== null, 'A 下載中且已收進至少 1 支', { id: 'start.downloading', expected: 'downloading, done ≥ 1', actual: downloading ?? await apiStatus() });
  });

  await record.scenario('YC-2', 'YouTube 限流：通道冷卻，A 的列與工作頁顯示重試時間，嘗試次數不變', async ({ expect, shot }) => {
    await instance.updateCatalog((current) => { current.youtube.rateLimitNext = true; });
    const channel = await waitFor(async () => {
      const group = await youtubeChannel();
      return group?.state === 'cooldown' ? group : null;
    }, 'YouTube cooling down', { timeout: 15_000 }).catch(() => null);
    cooldownUntil = channel?.cooldownUntil ?? null;
    expect(channel !== null && cooldownUntil !== null, '/api/pacing 的 youtube 進入冷卻',
      { id: 'w2.cooldown', expected: 'cooldown', actual: channel ?? await youtubeChannel() });

    const status = await waitFor(async () => {
      const current = await apiStatus();
      return current?.state === 'retrying' ? current : null;
    }, 'A retrying', { timeout: 10_000 }).catch(() => null) ?? await apiStatus();
    expect(status?.state === 'retrying' && status.cause?.reason === 'rate_limited' && status.at === cooldownUntil,
      'A 的 API 狀態為等冷卻結束的 retrying', { id: 'w2.api-status', expected: { state: 'retrying', cause: 'rate_limited', at: cooldownUntil }, actual: status });

    const row = await waitFor(async () => {
      const text = (await watched(page, 'status'))[rowOf(a)]?.at(-1)?.value ?? '';
      return RETRYING.test(text) ? text : null;
    }, 'A row retrying', { timeout: 10_000 }).catch(async () => (await watched(page, 'status'))[rowOf(a)]?.at(-1)?.value ?? null);
    expect(RETRYING.test(row ?? ''), 'A 的列為「錯誤・HH:MM 重試」', { id: 'w2.row', expected: '錯誤・HH:MM 重試', actual: row });

    const check = await checkOfA();
    const waiting = (check?.items ?? []).filter((item) => item.wait);
    const limited = waiting.find((item) => item.state === 'queued');
    expect(waiting.length > 0 && waiting.every((item) => item.wait.reason === 'rate_limited' && item.wait.until === cooldownUntil),
      '未完成的影片都帶冷卻的 wait', { id: 'w2.item-wait', expected: { reason: 'rate_limited', until: cooldownUntil }, actual: waiting.map((item) => ({ state: item.state, wait: item.wait })) });
    expect(limited !== undefined && !limited.retry, '遇到限流的影片沒有用掉嘗試次數', { id: 'w2.attempts', expected: 'no retry', actual: limited ?? null });

    single = await collect(instance, `https://www.youtube.com/watch?v=${d.videos[0].id}`);
    const accepted = (await jobs()).find((job) => job.id === single.job.id);
    expect(accepted?.state === 'queued' && accepted.wait?.reason === 'rate_limited' && accepted.wait.until === cooldownUntil,
      '冷卻期間送出的單支影片排隊並帶 wait', { id: 'w2.single-wait', expected: { state: 'queued', until: cooldownUntil }, actual: accepted ? { state: accepted.state, wait: accepted.wait } : null });

    const jobsPage = await openPage('/jobs');
    await jobsPage.getByTestId('page-jobs').waitFor();
    const runningRow = jobsPage.getByTestId(`job-${check?.id}`);
    await runningRow.waitFor({ timeout: 15_000 }).catch(() => undefined);
    const section = await runningRow.evaluate((element) => element.closest('section')?.dataset.testid ?? null).catch(() => null);
    const reason = (await runningRow.getByTestId('job-retry-reason').innerText().catch(() => '')).trim();
    expect(section === 'jobs-running' && reason === 'YouTube 限制連線', 'A 在工作頁進行中，原因為「YouTube 限制連線」',
      { id: 'w2.jobs-row', expected: { section: 'jobs-running', reason: 'YouTube 限制連線' }, actual: { section, reason } });
    const singleSection = await jobsPage.getByTestId(`job-${single.job.id}`).evaluate((element) => element.closest('section')?.dataset.testid ?? null).catch(() => null);
    expect(singleSection === 'jobs-queued', '單支影片在工作頁排隊中', { id: 'w2.jobs-single', expected: 'jobs-queued', actual: singleSection });
    await shot('jobs-cooldown', jobsPage);
    await jobsPage.close();
    await shot('rows-cooldown');
  });

  await record.scenario('YC-3', '冷卻結束：自動繼續並完成，事件各一次', async ({ expect, shot }) => {
    await idle(instance, 120_000).catch(() => null);
    const status = await apiStatus();
    expect(status?.state === 'scheduled', 'A 回到「下次 HH:MM」', { id: 'w3.scheduled', expected: 'scheduled', actual: status });
    const finishedCheck = await checkOfA();
    expect(finishedCheck?.state === 'completed' && finishedCheck.progress?.created === 5 && finishedCheck.progress.failed === 0,
      'A 的檢查完成，5 支都收進', { id: 'w3.check', expected: { state: 'completed', created: 5, failed: 0 }, actual: finishedCheck ? { state: finishedCheck.state, progress: finishedCheck.progress } : null });
    const finishedSingle = (await jobs()).find((job) => job.id === single?.job.id);
    expect(finishedSingle?.state === 'completed' && !finishedSingle.retry, '單支影片完成，沒有重試', { id: 'w3.single', expected: 'completed', actual: finishedSingle ? { state: finishedSingle.state, retry: finishedSingle.retry ?? null } : null });
    const saved = await documents();
    expect(saved === 6, 'Vault 有 6 份文件（A 的 5 支與單支 1 支）', { id: 'w3.vault', expected: 6, actual: saved });
    const counts = {};
    for (const type of ['youtube.rate_limited', 'youtube.cooldown_ended', 'job.deferred', 'job.retry_scheduled', 'job.failed']) counts[type] = (await events(type)).length;
    expect(counts['youtube.rate_limited'] === 1 && counts['youtube.cooldown_ended'] === 1 && counts['job.deferred'] === 1,
      'youtube.rate_limited、youtube.cooldown_ended、job.deferred 各一次', { id: 'w3.events', expected: { 'youtube.rate_limited': 1, 'youtube.cooldown_ended': 1, 'job.deferred': 1 }, actual: counts });
    expect(counts['job.retry_scheduled'] === 0 && counts['job.failed'] === 0, '沒有排定重試，也沒有失敗的工作',
      { id: 'w3.no-retry', expected: { 'job.retry_scheduled': 0, 'job.failed': 0 }, actual: counts });
    const sequence = ((await watched(page, 'status'))[rowOf(a)] ?? []).map((sample) => sample.value);
    const started = sequence.findIndex((text) => text !== '排隊中');
    expect(started >= 0 && !sequence.slice(started).includes('排隊中'), 'A 開始後的列不再出現「排隊中」',
      { id: 'w3.sequence', expected: '開始後沒有排隊中', actual: [...new Set(sequence)] });
    await shot('rows-done');
  });
}
