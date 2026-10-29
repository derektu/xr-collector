// Two channels collecting at once: A (5 videos) is subscribed, and B (3) is subscribed through the
// screen while A downloads. The Subscriptions page's status sequences, the Jobs page's sections,
// the document counts once both finish, and the documents in the Vault and the search index.
import { subscribe } from '../scripts/lib/seed.mjs';
import { distinct, jobSectionChecks, subscriptionSequenceChecks } from './lib/status-sequence.mjs';
import { watch, watched } from './lib/watch.mjs';

export const name = 'subscribe-a-b';
export const title = '兩個頻道同時收集：狀態序列、工作頁分區與資料面';
export const tier = 'feature';
export const covers = ['sub-add', 'sub-status', 'jobs-sections', 'jobs-empty', 'jobs-badge'];

/** Every subscription row's status text, by row test ID; runs inside the page. */
const subscriptionStatuses = () => Object.fromEntries([...document.querySelectorAll('[data-testid^="source-row-"], [data-testid^="pending-row-"]')]
  .map((row) => [row.dataset.testid, (row.querySelector('.status-chip')?.textContent ?? '').trim()]));

/** Every Jobs page row's section and title, by job ID; runs inside the page. */
const jobSections = () => Object.fromEntries([...document.querySelectorAll('section[data-testid^="jobs-"] li[data-testid^="job-"]')]
  .map((row) => [row.dataset.testid.slice('job-'.length), JSON.stringify({
    section: row.closest('section').dataset.testid.slice('jobs-'.length),
    title: (row.querySelector('.job-name')?.textContent ?? '').trim(),
  })]));

/** The sidebar's jobs badge text, or '' when it is not shown; runs inside the page. */
const badgeText = (page) => page.evaluate(() => document.querySelector('[data-testid="jobs-badge"]')?.textContent?.trim() ?? '');

/** Meilisearch keys are the document IDs in base64url. */
const fromIndexKey = (key) => Buffer.from(key, 'base64url').toString('utf8');

const difference = (a, b) => [...a].filter((value) => !b.has(value)).sort();

export async function run({ instance, page, openPage, record, waitFor, sleep }) {
  // Slower capture keeps A downloading while B is subscribed, so 下載中 is always sampled.
  await instance.updateCatalog((catalog) => { catalog.youtube.captureDelayMs = 1500; });
  const catalog = await instance.catalog();
  const [a, b] = ['verify-a', 'verify-b'].map((handle) => catalog.youtube.channels.find((source) => source.handle === handle));
  const rowOf = (source) => `source-row-${source.id}`;
  const statusOf = async (source) => (await watched(page, 'status'))[rowOf(source)]?.at(-1)?.value ?? null;
  // The flow waits on the API's status, so a wrong text on screen reaches the assertions instead of a timeout.
  const apiStatus = async (source) => (await instance.api('/api/subscriptions')).subscriptions.find((entry) => entry.id === source.id)?.checkStatus ?? null;
  let jobsPage;

  /** 新增訂閱 → YouTube 頻道 → 頻道網址 → 訂閱, then the dialog closes on the Subscriptions page. */
  const subscribeThroughDialog = async (source) => {
    await waitFor(async () => (await page.getByTestId('notice').count()) === 0, 'no toast over the page', { timeout: 15_000 });
    await page.getByTestId('add-subscription').click();
    await page.getByTestId('add-item-youtube-channel').click();
    await page.getByTestId('add-dialog').waitFor();
    await page.getByTestId('add-url').fill(`https://www.youtube.com/@${source.handle}`);
    const confirm = page.getByTestId('add-confirm');
    await waitFor(async () => (await confirm.innerText()).trim() === '訂閱' && await confirm.isEnabled(), 'subscribe enabled', { timeout: 15_000 });
    await confirm.click();
    await page.getByTestId('add-dialog').waitFor({ state: 'detached', timeout: 10_000 });
  };

  await page.getByTestId('nav-sources').click();
  await page.getByTestId('page-sources').waitFor();
  await watch(page, 'status', subscriptionStatuses);

  await record.scenario('SUBAB-1', '頻道 A 開始收集，列出現在訂閱頁', async ({ expect, shot }) => {
    // core-journey proves subscribing to one channel through the dialog; here A only has to be collecting.
    await subscribe(instance, `https://www.youtube.com/@${a.handle}`);
    await page.getByTestId(rowOf(a)).waitFor({ timeout: 15_000 });
    const listed = await page.getByTestId(rowOf(a)).count();
    expect(listed === 1, 'A 的訂閱列出現', { id: 'A.row.listed', expected: 1, actual: listed });
    await shot('a-subscribed');
  });

  await record.scenario('SUBAB-2', 'A 下載中時經畫面訂閱頻道 B，工作頁的分區', async ({ expect, shot }) => {
    await waitFor(async () => {
      const status = await apiStatus(a);
      return status?.state === 'downloading' && status.done >= 1;
    }, 'A downloading', { timeout: 60_000 });
    const downloading = await statusOf(a);
    await subscribeThroughDialog(b);
    await page.getByTestId(rowOf(b)).waitFor({ timeout: 15_000 });
    await shot('b-subscribed');

    // The Jobs page opens while work is running, so it polls at the active rate from the start.
    jobsPage = await openPage('/jobs');
    await jobsPage.getByTestId('page-jobs').waitFor();
    await watch(jobsPage, 'jobs', jobSections);
    const now = async () => Object.values(await watched(jobsPage, 'jobs')).map((samples) => JSON.parse(samples.at(-1).value));
    const rows = await waitFor(async () => {
      const current = await now();
      const find = (source) => current.find((row) => row.title === source.title);
      return find(a) && find(b) ? { a: find(a), b: find(b), all: current } : null;
    }, 'A and B on the Jobs page', { timeout: 30_000 });
    expect(rows.a.section === 'running', `A 下載中（${downloading}）時在工作頁的進行中`, { id: 'jobs.a.running', expected: 'running', actual: rows.a.section });
    expect(['running', 'queued'].includes(rows.b.section), 'B 在進行中或排隊中', { id: 'jobs.b.section', expected: 'running 或 queued', actual: rows.b.section });
    const failed = await jobsPage.getByTestId('jobs-failed').count();
    expect(failed === 0, '工作頁沒有失敗區', { id: 'jobs.failed.none', expected: 0, actual: failed });
    await shot('jobs', jobsPage);
  });

  await record.scenario('SUBAB-3', '兩者完成：狀態序列、文件數、工作頁與徽章', async ({ expect, shot, note }) => {
    await waitFor(async () => (await apiStatus(a))?.state === 'scheduled' && (await apiStatus(b))?.state === 'scheduled', 'A and B scheduled', { timeout: 120_000 });
    // An unchanged row can still be waiting for the next poll. Wait for the terminal render,
    // retaining the checks below on timeout so stale rows fail with their observed text.
    await waitFor(async () => [await statusOf(a), await statusOf(b)].every((text) => /^下次 /u.test(text ?? '')),
      'rows show the completed checks', { timeout: 30_000 }).catch(() => undefined);
    const statuses = await watched(page, 'status');
    for (const [source, label] of [[a, 'A'], [b, 'B']]) {
      const sequence = distinct(statuses[rowOf(source)] ?? []);
      note(`${label}.sequence`, sequence);
      for (const check of subscriptionSequenceChecks(label, sequence, { total: source.videos.length })) expect(check.ok, check.text, check);
    }
    // Rows of a subscription request in progress are recorded but not judged.
    note('pendingRows', Object.fromEntries(Object.entries(statuses).filter(([key]) => key.startsWith('pending-row-')).map(([key, samples]) => [key, distinct(samples)])));

    for (const [source, label] of [[a, 'A'], [b, 'B']]) {
      const count = (await page.getByTestId(rowOf(source)).locator('[role="cell"].numeric').innerText()).trim();
      expect(count === String(source.videos.length), `${label} 的列顯示 ${source.videos.length} 份文件`, { id: `${label}.row.documents`, expected: String(source.videos.length), actual: count });
    }
    await shot('done');

    await jobsPage.getByTestId('jobs-empty').waitFor({ timeout: 30_000 });
    const empty = (await jobsPage.getByTestId('jobs-empty').innerText()).trim();
    expect(empty === '沒有進行中的工作', '工作頁顯示「沒有進行中的工作」', { id: 'jobs.empty', expected: '沒有進行中的工作', actual: empty });
    const jobs = await watched(jobsPage, 'jobs');
    const sections = Object.fromEntries(Object.entries(jobs).map(([jobId, samples]) => {
      const rows = samples.map((sample) => JSON.parse(sample.value));
      return [jobId, { title: rows[0].title, sections: distinct(rows.map((row) => ({ value: row.section }))) }];
    }));
    note('jobSections', sections);
    for (const [source, label] of [[a, 'A'], [b, 'B']]) {
      const job = Object.values(sections).filter((entry) => entry.title === source.title).flatMap((entry) => entry.sections);
      for (const check of jobSectionChecks(label, job)) expect(check.ok, check.text, check);
    }
    await shot('jobs-empty', jobsPage);

    // The badge is judged only once every job has ended and the screen has stayed the same for 3 s.
    const stable = await waitFor(async () => {
      const seen = new Set();
      for (let sample = 0; sample < 6; sample += 1) { seen.add(await badgeText(page)); await sleep(500); }
      return seen.size === 1 ? { value: [...seen][0] } : null;
    }, 'badge stable', { timeout: 30_000 });
    expect(stable.value === '', '工作全部結束後側欄沒有工作徽章', { id: 'jobs.badge.none', expected: '', actual: stable.value });
  });

  await record.scenario('SUBAB-4', '資料面：Vault、API、索引與工作紀錄', async ({ expect, note }) => {
    const state = await instance.state();
    const vaultDocuments = state.vault.documents ?? [];
    const vaultIds = new Set(vaultDocuments.map((document) => document.frontmatter?.collector?.id));
    const total = a.videos.length + b.videos.length;
    expect(vaultDocuments.length === total, `Vault 有 ${total} 份文件`, { id: 'vault.documents', expected: total, actual: vaultDocuments.length });
    for (const [source, label] of [[a, 'A'], [b, 'B']]) {
      const count = vaultDocuments.filter((document) => document.frontmatter?.collector?.publisher_id === source.id).length;
      expect(count === source.videos.length, `Vault 中頻道 ${label} 的文件 ${source.videos.length} 份`, { id: `vault.documents.${label}`, expected: source.videos.length, actual: count });
    }

    const apiIds = new Set((state.api.documents?.documents ?? []).map((document) => document.id));
    const api = { onlyInApi: difference(apiIds, vaultIds), onlyInVault: difference(vaultIds, apiIds) };
    expect(!api.onlyInApi.length && !api.onlyInVault.length, 'API 的文件與 Vault 的文件一一對應', { id: 'api.matches-vault', expected: { onlyInApi: [], onlyInVault: [] }, actual: api });

    const index = state.index.indexes?.find((entry) => ['documents_v3', 'documents_v2'].includes(entry.uid)) ?? state.index.indexes?.[0];
    const indexIds = new Set((index?.keys ?? []).map(fromIndexKey));
    const searchable = { onlyInIndex: difference(indexIds, vaultIds), onlyInVault: difference(vaultIds, indexIds) };
    expect(index !== undefined && !searchable.onlyInIndex.length && !searchable.onlyInVault.length, '索引的文件與 Vault 的文件一一對應',
      { id: 'index.matches-vault', expected: { onlyInIndex: [], onlyInVault: [] }, actual: index ? searchable : state.index });

    const jobs = state.profile.files?.['jobs/jobs.json']?.jobs;
    const unfinished = (jobs ?? []).filter((job) => job.state === 'queued' || job.state === 'running').map((job) => `${job.kind} ${job.state}`);
    expect(Array.isArray(jobs) && unfinished.length === 0, 'profile 的 jobs.json 沒有未結束的工作', { id: 'profile.jobs.finished', expected: [], actual: jobs ? unfinished : 'jobs.json 讀不到' });
    note('vaultPaths', vaultDocuments.map((document) => document.path));
  });
}
