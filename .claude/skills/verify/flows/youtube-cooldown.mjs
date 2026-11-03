// YouTube limiting requests while channel A downloads: the YouTube request channel cools down,
// the video that met the limit waits without spending an attempt, A's row and the Jobs page say
// when collection goes on, a video submitted during the cooldown waits with it, and once the
// cooldown ends everything finishes by itself. A's first capture is held until the limit is set,
// so that capture meets it; the synthetic cooldown lasts until the flow ends it.
import { collect, idle, subscribe } from '../scripts/lib/index.mjs';
import { subscriptionStatuses } from './lib/status-sequence.mjs';
import { watch, watched } from './lib/watch.mjs';

export const name = 'youtube-cooldown';
export const title = 'YouTube 限制連線與冷卻';
export const covers = ['sub-status', 'jobs-row-text'];

export async function run({ instance, page, openPage, record, waitFor }) {
  await instance.updateCatalog((catalog) => { catalog.youtube.holdCaptures = true; });
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
    const held = async () => Object.keys(await instance.held()).some((key) => a.videos.some((video) => key === `capture:${video.id}`));
    const downloading = await waitFor(async () => {
      const status = await apiStatus();
      return status?.state === 'downloading' && await held() ? status : null;
    }, 'A downloading with a capture held', { timeout: 30_000 }).catch(() => null);
    expect(downloading !== null, 'A 下載中，一支影片的收集停在送出前', { id: 'start.downloading', expected: 'downloading, capture held', actual: downloading ?? await apiStatus() });
  });

  await record.scenario('YC-2', 'YouTube 限流：通道冷卻，A 的列與工作頁顯示重試時間，嘗試次數不變', async ({ expect, shot }) => {
    // One write: the released capture is the one that meets the limit.
    await instance.updateCatalog((current) => { current.youtube.rateLimitNext = true; current.youtube.holdCaptures = false; });
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
      const value = (await watched(page, 'status'))[rowOf(a)]?.at(-1)?.value ?? '';
      return value === 'retrying' ? value : null;
    }, 'A row retrying', { timeout: 10_000 }).catch(async () => (await watched(page, 'status'))[rowOf(a)]?.at(-1)?.value ?? null);
    expect(row === 'retrying', 'A 的列顯示等待重試', { id: 'w2.row', expected: 'retrying', actual: row });

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
    const reason = await runningRow.getByTestId('job-retry-reason').getAttribute('data-cause', { timeout: 5_000 }).catch(() => null);
    expect(section === 'jobs-running' && reason === 'rate_limited', 'A 在工作頁進行中，原因為 YouTube 限制連線',
      { id: 'w2.jobs-row', expected: { section: 'jobs-running', reason: 'rate_limited' }, actual: { section, reason } });
    const singleSection = await jobsPage.getByTestId(`job-${single.job.id}`).evaluate((element) => element.closest('section')?.dataset.testid ?? null).catch(() => null);
    expect(singleSection === 'jobs-queued', '單支影片在工作頁排隊中', { id: 'w2.jobs-single', expected: 'jobs-queued', actual: singleSection });
    await shot('jobs-cooldown', jobsPage);
    await jobsPage.close();
    await shot('rows-cooldown');
  });

  await record.scenario('YC-3', '冷卻結束：自動繼續並完成，事件各一次', async ({ expect, shot }) => {
    await instance.updateCatalog((current) => { current.youtube.endCooldown = true; });
    await idle(instance).catch(() => null);
    const status = await apiStatus();
    expect(status?.state === 'scheduled', 'A 回到排定下次檢查', { id: 'w3.scheduled', expected: 'scheduled', actual: status });
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
    const started = sequence.findIndex((value) => value !== 'queued');
    expect(started >= 0 && !sequence.slice(started).includes('queued'), 'A 開始後的列不再出現排隊中',
      { id: 'w3.sequence', expected: '開始後沒有排隊中', actual: [...new Set(sequence)] });
    await shot('rows-done');
  });
}
