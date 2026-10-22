// Real-data smoke: one real YouTube video (yt-dlp) and one real RSS feed, through the same screens
// as the synthetic flows. It needs the network and resources/bin/mac from npm run download:runtime;
// YouTube may rate-limit, which shows as a failed job, not as a harness error. Run from the checkout:
//   node .claude/skills/verify/examples/smoke-real.mjs [--issue <N>] [--label <name>] [--video <url>] [--feed <url>] [--keep]
import { parseArgs } from 'node:util';
import { apiState, launchWeb, openPage, REAL, recorder, waitFor } from '../scripts/lib/index.mjs';

const { values: o } = parseArgs({ options: {
  issue: { type: 'string', default: 'smoke' }, label: { type: 'string' }, video: { type: 'string', default: REAL.video },
  feed: { type: 'string', default: REAL.feed }, keep: { type: 'boolean' },
} });
const instance = await launchWeb({ issue: o.issue, label: o.label, data: 'real' });
console.log(`run ${instance.runDir} at ${instance.url}`);
const { page, consoleErrors, close } = await openPage(instance, { route: '/documents' });
const record = recorder(instance, page, { file: 'smoke-results.json' });
const documents = async () => (await instance.api('/api/documents?limit=100')).documents;

try {
  await record.scenario('SMOKE-VIDEO', '真實 YouTube 影片：加入、閱讀', async ({ expect, shot, note }) => {
    await page.getByTestId('add-document').click();
    await page.getByTestId('add-item-url').click();
    await page.getByTestId('add-url').fill(o.video);
    const confirm = page.getByTestId('add-confirm');
    await waitFor(async () => (await confirm.innerText()).trim() === '加入' && await confirm.isEnabled(), 'add enabled', { timeout: 15_000 });
    await confirm.click();
    const id = new URL(o.video).searchParams.get('v');
    const saved = await waitFor(async () => (await documents()).find((document) => document.sourceUrl?.includes(id)), 'video collected', { timeout: 240_000, interval: 2_000 });
    note('title', saved.title);
    await page.reload();
    await page.getByTestId('document-list').getByText(saved.title).first().click();
    await page.getByTestId('reader-body').waitFor();
    expect((await page.getByTestId('reader-body').innerText()).length > 200, `閱讀頁有字幕內文：${saved.title}`);
    await shot('reader');
  });

  await record.scenario('SMOKE-FEED', '真實 RSS feed：訂閱並收進文章', async ({ expect, shot, note }) => {
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('add-subscription').click();
    await page.getByTestId('add-item-rss-feed').click();
    await page.getByTestId('add-url').fill(o.feed);
    const confirm = page.getByTestId('add-confirm');
    await waitFor(async () => (await confirm.innerText()).trim() === '訂閱' && await confirm.isEnabled(), 'subscribe enabled', { timeout: 30_000 });
    await confirm.click();
    const articles = await waitFor(async () => {
      const found = (await documents()).filter((document) => document.sourceType === 'rss');
      return found.length > 0 ? found : null;
    }, 'articles collected', { timeout: 180_000, interval: 2_000 });
    note('articles', articles.map((article) => article.title));
    expect(true, `收進 ${articles.length} 篇文章`);
    await shot('sources');
  });
} finally {
  const passed = await record.finish({ consoleErrors, sources: { video: o.video, feed: o.feed }, state: await apiState(instance) });
  await close();
  if (!o.keep) await instance.stop();
  console.log(`${passed ? 'PASSED' : 'FAILED'}; evidence in ${instance.evidence}`);
  process.exitCode = passed ? 0 : 1;
}
