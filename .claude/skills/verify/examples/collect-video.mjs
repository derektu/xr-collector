// Example ticket flow: collect one synthetic video through the Documents page and read it.
// A ticket copies this file to .local/ticket-artifacts/<issue>/scripts/flow.mjs in its own worktree,
// keeps the launch/record/stop frame and replaces the scenarios with its own. Run from the ticket's
// worktree; evidence goes to its .local/ticket-artifacts/<issue>[/<label>]/:
//   node .claude/skills/verify/examples/collect-video.mjs [--issue <N>] [--label <name>] [--keep]
//   node .claude/skills/verify/examples/collect-video.mjs --checkout <main checkout> --label baseline
//   node .claude/skills/verify/examples/collect-video.mjs --run <runDir>
// --checkout picks the version under test (default: the worktree the command runs in); the library
// comes from that checkout's own skill, so it matches the src/ it drives. --run drives an instance
// verify.mjs launch started and leaves it running. --keep leaves an instance this flow launched
// running for manual inspection. Stop either with verify.mjs stop --run <dir>.
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({ options: {
  issue: { type: 'string', default: 'verify-skill' }, label: { type: 'string' }, checkout: { type: 'string' },
  run: { type: 'string' }, keep: { type: 'boolean' },
} });
const checkout = path.resolve(o.checkout ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const { apiState, attach, launchWeb, openPage, recorder, waitFor } = await import(
  pathToFileURL(path.join(checkout, '.claude', 'skills', 'verify', 'scripts', 'lib', 'index.mjs')).href);
const instance = o.run ? attach(o.run) : await launchWeb({ issue: o.issue, label: o.label, checkout });
console.log(`run ${instance.runDir} at ${instance.url}`);
const { page, consoleErrors, close } = await openPage(instance, { route: '/documents' });
const record = recorder(instance, page);
const catalog = await instance.catalog();
const video = catalog.youtube.channels.find((source) => source.handle === 'verify-d').videos[0];

try {
  await record.scenario('COLLECT-01', '從文件頁以網址加入單支影片', async ({ expect, shot }) => {
    await page.getByTestId('add-document').click();
    await page.getByTestId('add-item-url').click();
    await page.getByTestId('add-dialog').waitFor();
    await page.getByTestId('add-url').fill(`https://www.youtube.com/watch?v=${video.id}`);
    const confirm = page.getByTestId('add-confirm');
    await waitFor(async () => (await confirm.innerText()).trim() === '加入' && await confirm.isEnabled(), 'add enabled', { timeout: 15_000 });
    await shot('dialog');
    await confirm.click();
    await page.getByTestId('add-dialog').waitFor({ state: 'detached', timeout: 5_000 });
    expect(await page.getByTestId('page-documents').count() === 1, '對話框關閉後留在文件頁');
    const list = page.getByTestId('document-list');
    await waitFor(async () => (await list.innerText()).includes(video.title), 'document listed', { timeout: 30_000 });
    expect(true, `文件列表出現「${video.title}」`);
    await shot('listed');
  });

  await record.scenario('COLLECT-02', '開啟閱讀頁，文件寫入 Vault', async ({ expect, shot, note }) => {
    await page.getByTestId('document-list').getByText(video.title).first().click();
    await page.getByTestId('reader-body').waitFor();
    const body = await page.getByTestId('reader-body').innerText();
    expect(body.includes('【合成字幕】'), '閱讀頁顯示字幕內文');
    const href = await page.getByTestId('reader-source-link').getAttribute('href');
    expect(href?.includes(video.id), `原始影片連結 ${href}`);
    await shot('reader');
    // Side effect: a Markdown file in the run's Vault carries the video ID.
    const vault = path.join(instance.runDir, 'vault');
    const saved = [];
    for (const file of (await readdir(vault, { recursive: true })).filter((name) => name.endsWith('.md'))) {
      if ((await readFile(path.join(vault, file), 'utf8')).includes(video.id)) saved.push(file);
    }
    note('vaultFiles', saved);
    expect(saved.length === 1, `Vault 內有一份含 ${video.id} 的 Markdown：${saved.join('、') || '無'}`);
    const { documents } = await instance.api('/api/documents?limit=100');
    expect(documents.some((document) => document.title === video.title), 'API 的文件清單有這份文件');
  });
} finally {
  const passed = await record.finish({ consoleErrors, state: await apiState(instance) });
  await close();
  if (!o.run && !o.keep) await instance.stop();
  console.log(`${passed ? 'PASSED' : 'FAILED'}; evidence in ${instance.evidence}`);
  process.exitCode = passed ? 0 : 1;
}
