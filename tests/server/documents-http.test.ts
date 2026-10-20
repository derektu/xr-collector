import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { Collector } from '../../src/core/collector.js';
import type { SavedDocument, YouTubeChannel } from '../../src/core/types.js';
import { ManagedTranscriptSearch, type SearchBackend } from '../../src/search/managed-transcript-search.js';
import { fileSearchStateStore } from '../../src/search/runtime.js';
import { createHttpApp } from '../../src/server/app.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  videoId: string;
  publisherId?: string;
  publisher?: string;
  collectedAt: string;
  publishedAt?: string;
  body?: string;
  /** Extra frontmatter a later version or another tool may have written. */
  extra?: Record<string, unknown>;
}

/** Writes a document file in the Vault format directly, as a first-round or newer writer would. */
async function writeDocument(root: string, fixture: Fixture): Promise<void> {
  const directory = path.join(root, 'documents', 'youtube');
  await mkdir(directory, { recursive: true });
  const metadata = {
    type: 'Transcript',
    title: `影片 ${fixture.videoId}`,
    resource: `https://www.youtube.com/watch?v=${fixture.videoId}`,
    tags: [],
    collector: {
      id: `youtube:${fixture.videoId}`,
      source: 'youtube',
      source_id: fixture.videoId,
      publisher: fixture.publisher ?? '測試頻道',
      ...(fixture.publisherId ? { publisher_id: fixture.publisherId } : {}),
      ...(fixture.publishedAt ? { published_at: fixture.publishedAt } : {}),
      collected_at: fixture.collectedAt,
      content_extent: 'full',
      subtitle: { language_code: 'zh-Hant', kind: 'manual' },
      source_tags: [],
    },
    ...fixture.extra,
  };
  const body = fixture.body ?? `## 段落標題\n\n這是 **${fixture.videoId}** 的[字幕](https://example.com)正文。`;
  await writeFile(path.join(directory, `${fixture.videoId}.md`), `---\n${stringify(metadata)}---\n\n${body}\n`);
}

async function vaultRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-documents-http-'));
  roots.push(root);
  return root;
}

function channel(id: string, title: string): YouTubeChannel {
  return { id, title, url: `https://www.youtube.com/channel/${id}/videos`, enabled: true, addedAt: '2026-10-01T00:00:00.000Z' };
}

function channels(list: YouTubeChannel[]) {
  return {
    listChannels: async () => list,
    addChannel: async () => { throw new Error('unused'); },
    setChannelEnabled: async () => { throw new Error('unused'); },
    removeChannel: async () => undefined,
    startRun: async () => [],
  };
}

describe('documents HTTP contract', () => {
  it('reads first-round and newer documents through the shared contract', async () => {
    const root = await vaultRoot();
    await writeDocument(root, { videoId: 'legacy00001', collectedAt: '2026-09-01T00:00:00.000Z', publisher: '舊頻道' });
    await writeDocument(root, {
      videoId: 'current0001', publisherId: 'UC-a', collectedAt: '2026-10-01T00:00:00.000Z', publishedAt: '2026-09-30T00:00:00.000Z',
      extra: { aliases: ['未知欄位'], collector_extension: { note: 'kept' } },
    });
    const app = await createHttpApp({ collector: new Collector(new MarkdownVault(root)) });

    const page = (await app.inject('/api/documents?limit=20')).json();
    expect(page).toMatchObject({ total: 2, offset: 0, limit: 20, nextOffset: null });
    expect(page.documents[0]).toEqual({
      id: 'youtube:current0001',
      type: 'Transcript',
      sourceType: 'youtube',
      sourceId: 'current0001',
      sourceUrl: 'https://www.youtube.com/watch?v=current0001',
      title: '影片 current0001',
      publisher: { id: 'UC-a', name: '測試頻道' },
      publishedAt: '2026-09-30T00:00:00.000Z',
      collectedAt: '2026-10-01T00:00:00.000Z',
      youtube: { languageCode: 'zh-Hant', languageName: null, subtitleKind: 'manual' },
      excerpt: '段落標題 這是 current0001 的字幕正文。',
    });
    expect(page.documents[1]).toMatchObject({ publisher: { id: null, name: '舊頻道' }, publishedAt: null });
    for (const document of page.documents) {
      expect(document).not.toHaveProperty('channelTitle');
      expect(document).not.toHaveProperty('languageCode');
    }

    const read = (await app.inject('/api/documents/youtube%3Acurrent0001')).json().document;
    expect(read.bodyMarkdown).toContain('## 段落標題');
    expect(read).not.toHaveProperty('excerpt');
    // Reading never rewrites the file, so fields this version does not know stay on disk.
    expect(await readFile(path.join(root, 'documents', 'youtube', 'current0001.md'), 'utf8')).toContain('collector_extension');
    await app.close();
  });

  it('pages browse results newest first with ties broken by ID and an exact total', async () => {
    const root = await vaultRoot();
    const ids = Array.from({ length: 45 }, (_, index) => `page${String(index).padStart(7, '0')}`);
    // Pairs share a collection time so the ID tie-break decides their order.
    await Promise.all(ids.map((videoId, index) => writeDocument(root, {
      videoId, publisherId: 'UC-a', collectedAt: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(index / 2))).toISOString(),
    })));
    const app = await createHttpApp({ collector: new Collector(new MarkdownVault(root)) });

    const pages = await Promise.all([0, 20, 40].map(async (offset) => (await app.inject(`/api/documents?offset=${offset}&limit=20`)).json()));
    expect(pages.map((page) => [page.total, page.documents.length, page.nextOffset])).toEqual([[45, 20, 20], [45, 20, 40], [45, 5, null]]);
    const order = pages.flatMap((page) => page.documents.map((document: SavedDocument) => document.id));
    expect(new Set(order).size).toBe(45);
    const expected = [...ids].sort((left, right) => Math.floor(ids.indexOf(right) / 2) - Math.floor(ids.indexOf(left) / 2) || left.localeCompare(right));
    expect(order).toEqual(expected.map((id) => `youtube:${id}`));
    await app.close();
  });

  it('filters by stable publisher IDs and lists sources with subscription state', async () => {
    const root = await vaultRoot();
    await writeDocument(root, { videoId: 'samename001', publisherId: 'UC-a', publisher: '同名頻道', collectedAt: '2026-10-01T00:00:00.000Z' });
    await writeDocument(root, { videoId: 'samename002', publisherId: 'UC-a', publisher: '同名頻道', collectedAt: '2026-10-02T00:00:00.000Z' });
    await writeDocument(root, { videoId: 'samename003', publisherId: 'UC-b', publisher: '同名頻道', collectedAt: '2026-10-03T00:00:00.000Z' });
    await writeDocument(root, { videoId: 'removed0001', publisherId: 'UC-gone', publisher: '已移除頻道', collectedAt: '2026-10-04T00:00:00.000Z' });
    await writeDocument(root, { videoId: 'legacy00001', publisher: '舊頻道', collectedAt: '2026-10-05T00:00:00.000Z' });
    const app = await createHttpApp({
      collector: new Collector(new MarkdownVault(root)),
      channels: channels([channel('UC-a', '同名頻道'), channel('UC-b', '同名頻道'), channel('UC-empty', '沒有文件的頻道')]),
    });

    const ids = async (query: string) => (await app.inject(`/api/documents?${query}`)).json().documents.map((document: SavedDocument) => document.id);
    expect(await ids('sourceType=youtube&publisherId=UC-a')).toEqual(['youtube:samename002', 'youtube:samename001']);
    expect(await ids('sourceType=youtube&publisherId=UC-b')).toEqual(['youtube:samename003']);
    expect(await ids('sourceType=youtube&publisherId=none')).toEqual(['youtube:legacy00001']);
    expect(await ids('sourceType=youtube')).toHaveLength(5);

    expect((await app.inject('/api/documents/sources')).json().sources).toEqual({
      total: 5,
      groups: [{
        sourceType: 'youtube',
        label: 'YouTube',
        count: 5,
        publishers: [
          ...[
            { id: 'UC-a', name: '同名頻道', count: 2, subscribed: true, removed: false },
            { id: 'UC-b', name: '同名頻道', count: 1, subscribed: true, removed: false },
            { id: 'UC-gone', name: '已移除頻道', count: 1, subscribed: false, removed: false },
          ].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hant') || left.id.localeCompare(right.id)),
          { id: null, name: '未知頻道', count: 1, subscribed: null, removed: false },
        ],
      }],
    });

    for (const query of ['channel=%E5%90%8C%E5%90%8D%E9%A0%BB%E9%81%93', 'publisherId=UC-a', 'sourceType=rss', 'sourceType=youtube&publisherId=']) {
      const response = await app.inject(`/api/documents?${query}`);
      expect([response.statusCode, response.json().error.code]).toEqual([400, 'invalid_request']);
    }
    await app.close();
  });

  it('keeps browse, sources and read available while search is unavailable', async () => {
    const root = await vaultRoot();
    await writeDocument(root, { videoId: 'available01', publisherId: 'UC-a', collectedAt: '2026-10-01T00:00:00.000Z' });
    const vault = new MarkdownVault(root);
    const backend: SearchBackend = {
      initialize: async () => { throw new Error('engine stopped'); },
      count: async () => 0, isCurrent: async () => false, replaceAll: async () => undefined,
      upsert: async () => undefined, search: async () => { throw new Error('unused'); },
    };
    const search = new ManagedTranscriptSearch(backend, async () => []);
    await search.start().catch(() => undefined);
    const app = await createHttpApp({ collector: new Collector(vault), search });

    const searched = await app.inject('/api/search?q=%E5%AD%97%E5%B9%95');
    expect([searched.statusCode, searched.json().error.code]).toEqual([503, 'search_unavailable']);
    expect((await app.inject('/api/documents')).json().total).toBe(1);
    expect((await app.inject('/api/documents/sources')).json().sources.total).toBe(1);
    expect((await app.inject('/api/documents/youtube%3Aavailable01')).statusCode).toBe(200);
    expect((await app.inject('/api/search/status')).json().status).toEqual({
      state: 'error', indexedDocuments: 0, lastRebuiltAt: null, message: '無法啟動搜尋索引。', vaultDocuments: 1,
    });
    await app.close();
  });

  it('reports the index against the Vault count and keeps the rebuild time across restarts', async () => {
    const root = await vaultRoot();
    await writeDocument(root, { videoId: 'status00001', publisherId: 'UC-a', collectedAt: '2026-10-01T00:00:00.000Z' });
    await writeDocument(root, { videoId: 'status00002', publisherId: 'UC-a', collectedAt: '2026-10-02T00:00:00.000Z' });
    const vault = new MarkdownVault(root);
    const indexed = new Map<string, SavedDocument>();
    const backend: SearchBackend = {
      initialize: async () => undefined,
      count: async () => indexed.size,
      isCurrent: async (documents) => documents.length === indexed.size,
      replaceAll: async (documents) => { indexed.clear(); for (const document of documents) indexed.set(document.id, document); },
      upsert: async (document) => { indexed.set(document.id, document); },
      search: async () => ({ hits: [], total: 0, offset: 0, limit: 50 }),
    };
    const load = async () => Promise.all((await vault.list()).map(async ({ id }) => (await vault.read(id))!));
    const stateFile = path.join(root, 'search-state.json');
    const start = async (now: string) => {
      const search = new ManagedTranscriptSearch(backend, load, fileSearchStateStore(stateFile), () => new Date(now));
      await search.start();
      return createHttpApp({ collector: new Collector(vault), search });
    };

    const app = await start('2026-10-15T01:00:00.000Z');
    expect((await app.inject('/api/search/status')).json().status).toEqual({
      state: 'ready', indexedDocuments: 2, vaultDocuments: 2, lastRebuiltAt: '2026-10-15T01:00:00.000Z',
    });
    await app.close();

    const restarted = await start('2026-10-15T02:00:00.000Z');
    expect((await restarted.inject('/api/search/status')).json().status.lastRebuiltAt).toBe('2026-10-15T01:00:00.000Z');
    const rebuilt = (await restarted.inject({ method: 'POST', url: '/api/search/rebuild' })).json().status;
    expect(rebuilt).toMatchObject({ state: 'ready', vaultDocuments: 2, lastRebuiltAt: '2026-10-15T02:00:00.000Z' });
    await restarted.close();
  });
});
