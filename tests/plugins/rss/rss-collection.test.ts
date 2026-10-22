import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { fetchText } from '../../../src/plugins/rss/http.js';
import { rssPlugin, subscriptionId } from '../../../src/plugins/rss/server.js';
import type { SourcePlugin } from '../../../src/plugins/types.js';
import { MarkdownVault } from '../../../src/vault/markdown-vault.js';
import { VAULT_MARKER } from '../../../src/vault/vault-directory.js';
import { importNewVault } from '../../../src/vault/vault-import.js';
import { openPackage } from '../../../src/vault/vault-package.js';
import { VaultSelection } from '../../../src/vault/vault-selection.js';
import type { VaultWorkspace } from '../../../src/vault/workspace.js';
import { atom, page, rss2, type SyntheticArticle, SyntheticFeeds } from '../../support/synthetic-feeds.js';
import { youtubePlugins } from '../../support/youtube-sources.js';
import { cleanUp, importFile, machine, open, seed, temp, type Machine } from '../../vault/exchange-fixtures.js';

// RSS through the product's core: a workspace with the YouTube and RSS plugins over synthetic feeds
// on a local server. Subscribing, checking, removing and exchanging use the same services the
// product assembles; only the feeds are synthetic.

let feeds: SyntheticFeeds;
beforeEach(async () => { feeds = await SyntheticFeeds.start(); });
afterEach(async () => {
  await cleanUp();
  await feeds.close();
});

// RSS dates carry whole seconds.
const now = Math.floor(Date.now() / 1000) * 1000;
const ago = (days: number) => new Date(now - days * 86_400_000);
const plugins = (): SourcePlugin[] => [...youtubePlugins(), rssPlugin((url, context) => fetchText(url, context.signal)) as unknown as SourcePlugin];

const BLOG: SyntheticArticle[] = [
  { title: '【合成】全文文章', guid: 'post-3', link: '/posts/3', publishedAt: ago(1), content: '<h2>小標</h2><p>正文 <a href="/about">關於</a></p><table><tr><th>欄</th></tr><tr><td>值</td></tr></table>' },
  { title: '【合成】只有摘要', guid: 'post-2', link: '/posts/2', publishedAt: ago(3), summary: '<p>這是摘要。</p>' },
  { title: '【合成】缺 guid', link: '/posts/1', publishedAt: ago(5), summary: '<p>沒有 guid。</p>' },
  { title: '【合成】範圍外舊文', guid: 'post-0', link: '/posts/0', publishedAt: ago(90), summary: '<p>太舊。</p>' },
];

async function workspaceOf(at: Machine): Promise<VaultWorkspace> {
  await seed(at.vault);
  return open(at, { plugins: plugins() });
}

async function rssDocuments(vault: string): Promise<Array<{ front: Record<string, any>; body: string }>> {
  const folder = path.join(vault, 'documents', 'rss');
  if (!existsSync(folder)) return [];
  return Promise.all((await readdir(folder)).sort().map(async (file) => {
    const [front, body] = (await readFile(path.join(folder, file), 'utf8')).replace(/^---\n/u, '').split('\n---\n');
    return { front: parse(front!) as Record<string, any>, body: body!.trim() };
  }));
}

async function subscribe(workspace: VaultWorkspace, url: string) {
  const service = workspace.subscriptions.of('rss')!;
  const added = await workspace.jobs.whenSettled((await service.add(url)).job.id);
  expect(added).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
  return workspace.jobs.whenSettled(added.result!.followUpJobId!);
}

describe('subscribing to a feed through the core (R11-T5)', () => {
  it('subscribes through a site page and collects the newest articles within the range at the first check', async () => {
    feeds.set('/blog/feed.xml', { body: rss2('【合成】部落格', BLOG) });
    feeds.set('/blog/', { body: page('部落格', [{ href: 'feed.xml' }]), contentType: 'text/html; charset=utf-8' });
    const a = await machine('A', await temp());
    const workspace = await workspaceOf(a);
    const id = subscriptionId(feeds.url('/blog/feed.xml'));

    const preview = await workspace.subscriptions.of('rss')!.preview(feeds.url('/blog/'));
    expect(preview).toMatchObject({ type: 'rss', target: { id, title: '【合成】部落格', url: feeds.url('/blog/feed.xml') }, subscription: null });
    const check = await subscribe(workspace, feeds.url('/blog/'));
    expect(check).toMatchObject({ kind: 'rss.feed', state: 'completed', progress: { created: 3 } });

    const documents = await rssDocuments(a.vault);
    const byTitle = new Map(documents.map((document) => [document.front.title, document]));
    expect([...byTitle.keys()].sort()).toEqual(['【合成】全文文章', '【合成】只有摘要', '【合成】缺 guid']);
    expect(byTitle.get('【合成】全文文章')).toEqual({
      front: {
        type: 'Article', title: '【合成】全文文章', resource: feeds.url('/posts/3'), tags: [],
        collector: {
          id: expect.stringMatching(/^rss:[0-9a-f]{16}$/u), source: 'rss', source_id: expect.stringMatching(/^[0-9a-f]{16}$/u),
          publisher: '【合成】部落格', publisher_id: id, published_at: ago(1).toISOString(), collected_at: expect.any(String),
          content_extent: 'full', source_tags: [],
        },
      },
      body: `## 小標\n\n正文 [關於](${feeds.url('/about')})\n\n| 欄 |\n| - |\n| 值 |`,
    });
    expect(byTitle.get('【合成】只有摘要')!.front.collector.content_extent).toBe('summary');
    expect(byTitle.get('【合成】缺 guid')!.front.resource).toBe(feeds.url('/posts/1'));
    expect(JSON.parse(await readFile(path.join(a.vault, VAULT_MARKER), 'utf8')).formatVersion).toBe(2);

    const read = await workspace.collector.read(byTitle.get('【合成】只有摘要')!.front.collector.id);
    expect(read).toMatchObject({ sourceType: 'rss', type: 'Article', contentExtent: 'summary', publisher: { id, name: '【合成】部落格' } });
    const detail = await workspace.subscriptions.of('rss')!.listSubscriptions();
    expect(detail).toMatchObject([{ id, title: '【合成】部落格', url: feeds.url('/blog/feed.xml') }]);
  });

  it('collects new articles at scheduled and immediate checks, and removes the subscription with its documents', async () => {
    feeds.set('/feed.atom', { body: atom('【合成】Atom 站', BLOG.slice(0, 2), feeds.url('/')) });
    const a = await machine('A', await temp());
    const workspace = await workspaceOf(a);
    const id = subscriptionId(feeds.url('/feed.atom'));
    await subscribe(workspace, feeds.url('/feed.atom'));
    expect((await rssDocuments(a.vault)).length).toBe(2);
    const service = workspace.subscriptions.of('rss')!;

    feeds.set('/feed.atom', { body: atom('【合成】Atom 站', [{ title: '【合成】定時新文', guid: 'n1', link: '/n/1', publishedAt: ago(0.5), content: '<p>新</p>' }, ...BLOG.slice(0, 2)], feeds.url('/')) });
    const [scheduled] = await service.startRun({ trigger: 'scheduled', subscriptionIds: [id] });
    expect(await workspace.jobs.whenSettled(scheduled!.job.id)).toMatchObject({ scope: { trigger: 'scheduled' }, progress: { created: 1 } });

    feeds.set('/feed.atom', { body: atom('【合成】Atom 站', [{ title: '【合成】立即新文', guid: 'n2', link: '/n/2', publishedAt: ago(0.1), summary: '<p>摘</p>' }, { title: '【合成】定時新文', guid: 'n1', link: '/n/1', publishedAt: ago(0.5), content: '<p>新</p>' }, ...BLOG.slice(0, 2)], feeds.url('/')) });
    const [manual] = await service.startRun({ trigger: 'manual', subscriptionIds: [id] });
    expect(await workspace.jobs.whenSettled(manual!.job.id)).toMatchObject({ scope: { trigger: 'manual' }, progress: { created: 1 } });
    expect((await rssDocuments(a.vault)).map((document) => document.front.title).sort())
      .toEqual(['【合成】全文文章', '【合成】只有摘要', '【合成】定時新文', '【合成】立即新文']);

    await service.remove(id, { documents: 'delete' });
    await expect.poll(async () => (await workspace.collector.list()).filter((document) => document.sourceType === 'rss').length).toBe(0);
    expect(await service.listSubscriptions()).toEqual([]);
    expect((await workspace.collector.list()).map((document) => document.id)).toEqual(['youtube:dQw4w9WgXcQ']);
  });

  it('records a check of an unreachable feed as failed and recovers at the next check', async () => {
    feeds.set('/feed.xml', { body: rss2('【合成】站', BLOG.slice(0, 1)) });
    const a = await machine('A', await temp());
    const workspace = await workspaceOf(a);
    const id = subscriptionId(feeds.url('/feed.xml'));
    await subscribe(workspace, feeds.url('/feed.xml'));
    const service = workspace.subscriptions.of('rss')!;

    feeds.set('/feed.xml', { status: 410, body: 'gone' });
    const [failed] = await service.startRun({ trigger: 'manual', subscriptionIds: [id] });
    expect(await workspace.jobs.whenSettled(failed!.job.id)).toMatchObject({ state: 'failed', error: { code: 'feed_not_found' } });

    feeds.set('/feed.xml', { body: rss2('【合成】站', [{ title: '【合成】恢復後', guid: 'back', publishedAt: ago(0.2), summary: '回來了' }, ...BLOG.slice(0, 1)]) });
    const [next] = await service.startRun({ trigger: 'manual', subscriptionIds: [id] });
    expect(await workspace.jobs.whenSettled(next!.job.id)).toMatchObject({ state: 'completed', progress: { created: 1 } });
  });
});

describe('exchanging a Vault with YouTube and RSS (R11-T7)', () => {
  it('exports RSS at package version 2, YouTube alone at version 1, and imports, merges and replaces both types', async () => {
    feeds.set('/feed.xml', { body: rss2('【合成】部落格', BLOG.slice(0, 2)) });
    const root = await temp();
    const a = await machine('A', root);
    const b = await machine('B', root);
    const c = await machine('C', root);

    const youtubeOnly = await workspaceOf(c);
    await mkdir(c.exports, { recursive: true });
    const plain = (await youtubeOnly.exportTo(path.join(c.exports, 'youtube.zip'))).result!.exportPath!;
    const plainReader = await openPackage(plain);
    expect(plainReader.manifest.formatVersion).toBe(1);
    plainReader.close();

    const workspace = await workspaceOf(a);
    await subscribe(workspace, feeds.url('/feed.xml'));
    await mkdir(a.exports, { recursive: true });
    const file = (await workspace.exportTo(path.join(a.exports, 'both.zip'))).result!.exportPath!;
    const reader = await openPackage(file);
    expect(reader.manifest.formatVersion).toBe(2);
    expect(reader.manifest.files.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining(['settings/rss-subscriptions.json', 'settings/youtube-channels.json']));
    reader.close();
    const ids = async (vault: string) => (await new MarkdownVault(vault).list()).map((document) => document.id).sort();

    const created = await importNewVault({ packageFile: file, folder: b.vault, profilePath: b.profile, createdBy: 'XR Collector test' });
    await new VaultSelection(path.join(b.profile, 'vault-selection.json')).write(created);
    expect(await ids(created)).toEqual(await ids(a.vault));
    expect(JSON.parse(await readFile(path.join(created, VAULT_MARKER), 'utf8')).formatVersion).toBe(2);

    const { preview } = await importFile(youtubeOnly, file);
    expect(preview).toMatchObject({ merge: { documents: { added: 2 }, subscriptions: { added: 1 } } });
    expect(await ids(c.vault)).toEqual(await ids(a.vault));
    expect((await youtubeOnly.subscriptions.of('rss')!.list()).map((row) => row.title)).toEqual(['【合成】部落格']);

    const replacing = await machine('D', root);
    const fresh = await workspaceOf(replacing);
    await importFile(fresh, file, 'replace');
    expect(await ids(replacing.vault)).toEqual(await ids(a.vault));
  });
});
