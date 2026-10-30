#!/usr/bin/env node
// CI smoke for an already packaged app. It uses an isolated Vault seeded before launch, so hosted
// runner networking and YouTube rate limits do not decide the result. The real bundled Meilisearch
// must index and search the fixture, and the bundled yt-dlp and Deno executables must report versions.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { recorder } from './lib/drive.mjs';
import { launchElectron } from './lib/electron.mjs';
import { checkoutRoot } from './lib/paths.mjs';
import { exe } from './lib/platform.mjs';
import { desktopTarget } from './lib/target.mjs';
import { waitFor } from './lib/wait.mjs';

const { values: options } = parseArgs({ options: {
  app: { type: 'string' }, evidence: { type: 'string' }, issue: { type: 'string', default: '119' }, label: { type: 'string', default: 'packaged-offline' },
  checkout: { type: 'string' },
} });
if (!options.app) throw new Error('smoke-packaged-offline.mjs needs --app <.app or .exe>');
if (!options.evidence) throw new Error('smoke-packaged-offline.mjs needs --evidence <empty directory>');

const checkout = options.checkout ? path.resolve(options.checkout) : checkoutRoot();
const keyword = '離線打包驗收關鍵詞';
const id = 'ci119test01';
const distractorId = 'ci119noise1';

let desktop;
let programs;
try {
  desktop = await launchElectron({
    issue: options.issue, label: options.label, evidence: options.evidence, app: options.app, checkout, vault: 'selected',
    prepareVault: async ({ vault }) => {
      const folder = path.join(vault, 'documents', 'youtube');
      await mkdir(folder, { recursive: true });
      for (const fixture of [
        { id, title: 'CI 離線打包驗收文件', content: `${keyword}。這份文件只存在於本次隔離 smoke。` },
        { id: distractorId, title: 'CI 對照文件', content: '這是另一份不符合搜尋條件的內容。' },
      ]) {
        const metadata = {
          type: 'Transcript', title: fixture.title, resource: `https://www.youtube.com/watch?v=${fixture.id}`, tags: [],
          collector: { id: `youtube:${fixture.id}`, source: 'youtube', source_id: fixture.id, publisher: 'CI fixture',
            collected_at: '2026-10-25T00:00:00.000Z', content_extent: 'full', subtitle: { language_code: 'zh-Hant', kind: 'manual' }, source_tags: [] },
        };
        await writeFile(path.join(folder, `${fixture.id}.md`), `---\n${stringify(metadata)}---\n\n${fixture.content}\n`);
      }
    },
  });
  const target = desktopTarget({ checkout, app: options.app });
  const bin = path.join(target.resources, 'bin');
  programs = { ytdlp: path.join(bin, 'yt-dlp', exe('yt-dlp')), deno: path.join(bin, exe('deno')) };
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

if (desktop) {
const record = recorder(desktop, () => desktop.window);
let error;
try {
  await record.scenario('CI-119-05', '打包 App 使用隨附 runtime 搜尋隔離文件', async ({ expect, note, shot }) => {
    const versions = Object.fromEntries(Object.entries(programs).map(([name, file]) => [name,
      execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim()]));
    const build = (await desktop.api('/api/device/build-info')).buildInfo;
    const expectedTarget = process.platform === 'darwin' ? 'darwin-arm64' : 'win32-x64';
    note('buildInfo', build);
    note('runtimeVersions', versions);
    expect(build.kind === 'packaged' && build.sourceDirty === false
      && build.commit === desktop.commit && build.target === expectedTarget && desktop.target.arch === process.arch,
    `BuildInfo 對應受測 checkout、平台與架構：${JSON.stringify({ build, checkoutCommit: desktop.commit, appArch: desktop.target.arch })}`);
    expect(Boolean(versions.ytdlp) && Boolean(versions.deno), `隨附 yt-dlp 與 Deno 可執行：${JSON.stringify(versions)}`);

    const search = await waitFor(async () => {
      const result = await desktop.api(`/api/search?q=${encodeURIComponent(keyword)}`);
      return result.total === 1 ? result : null;
    }, 'packaged Meilisearch indexed the offline fixture', { timeout: 60_000 });
    expect(search.hits[0]?.id === `youtube:${id}`, `搜尋 API 找到隔離文件：${search.hits[0]?.id ?? '無'}`);

    await desktop.window.getByTestId('nav-documents').click();
    await waitFor(async () => await desktop.window.locator('.document-row').count() === 2 || null,
      'documents UI lists both offline fixtures before filtering');
    expect(await desktop.window.locator('.document-row').count() === 2, '搜尋前畫面列出兩份隔離文件');
    await desktop.window.getByTestId('documents-search').fill(keyword);
    await desktop.window.getByTestId('documents-search').press('Enter');
    const rows = desktop.window.locator('.document-row');
    await waitFor(async () => {
      if (await rows.count() !== 1) return null;
      return (await rows.first().textContent())?.includes('CI 離線打包驗收文件') || null;
    }, 'documents UI filters to the matching offline fixture');
    expect(await rows.count() === 1
      && Boolean((await rows.first().textContent())?.includes('CI 離線打包驗收文件')), '搜尋畫面只列出符合的隔離文件');
    await shot('search-result');
  });
} catch (caught) {
  error = caught;
} finally {
  await desktop.close().catch((caught) => { error ??= caught; });
}
const passed = await record.finish({ ...(error ? { error: String(error.stack ?? error) } : {}) });
console.log(`${passed && !error ? 'PASS' : 'FAIL'} packaged offline smoke; results in ${desktop.evidence}/results.json`);
if (error) console.error(error);
process.exitCode = passed && !error ? 0 : 1;
}
