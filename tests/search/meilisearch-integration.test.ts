import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SavedDocument } from '../../src/core/types.js';
import { ManagedTranscriptSearch } from '../../src/search/managed-transcript-search.js';
import { MeilisearchBackend } from '../../src/search/meilisearch-backend.js';
import {
  startMeilisearchProcess,
  type RunningMeilisearch,
} from '../../src/search/meilisearch-process.js';

const roots: string[] = [];
const running = new Set<RunningMeilisearch>();
const bundledBinary = path.resolve('resources/bin/mac/meilisearch');

afterEach(async () => {
  await Promise.all([...running].map((process) => process.close()));
  running.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function transcript(sourceId: string, body: string, publisherId: string | null = 'channel-1'): SavedDocument {
  return {
    id: `youtube:${sourceId}`,
    type: 'Transcript',
    sourceType: 'youtube',
    sourceId,
    sourceUrl: `https://www.youtube.com/watch?v=${sourceId}`,
    title: `影片 ${sourceId}`,
    publisher: { id: publisherId, name: publisherId ? '測試頻道' : '舊頻道' },
    publishedAt: '2026-09-12T00:00:00.000Z',
    collectedAt: '2026-09-17T00:00:00.000Z',
    youtube: { languageCode: 'zh-Hant', languageName: '繁體中文', subtitleKind: 'manual' },
    bodyMarkdown: body,
  };
}

const document = transcript('dQw4w9WgXcQ', '這份字幕裡有獨特的森林觀測關鍵詞。');

async function tempDatabase(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-meili-test-'));
  roots.push(root);
  return path.join(root, 'search-data');
}

/** Starts the engine on a database, runs the managed startup check, and hands both to the callback. */
async function withSearch<T>(
  databasePath: string,
  documents: () => SavedDocument[],
  use: (search: ManagedTranscriptSearch, engine: RunningMeilisearch, rebuilds: number) => Promise<T>,
): Promise<T> {
  const engine = await startMeilisearchProcess({ binaryPath: bundledBinary, databasePath });
  running.add(engine);
  try {
    let rebuilds = 0;
    const search = new ManagedTranscriptSearch(
      new MeilisearchBackend({ baseUrl: engine.url, apiKey: engine.apiKey }),
      async () => documents(),
      { load: async () => ({ lastRebuiltAt: null }), save: async () => { rebuilds += 1; } },
    );
    await search.start();
    return await use(search, engine, rebuilds);
  } finally {
    running.delete(engine);
    await engine.close();
  }
}

async function engineRequest(engine: RunningMeilisearch, pathName: string, init?: RequestInit): Promise<Response> {
  return fetch(`${engine.url}${pathName}`, {
    ...init,
    headers: { Authorization: `Bearer ${engine.apiKey}`, 'Content-Type': 'application/json' },
  });
}

describe.skipIf(!existsSync(bundledBinary))('bundled Meilisearch integration', () => {
  it('searches after restart and rebuilds after the local index is removed', async () => {
    const databasePath = await tempDatabase();
    const firstHit = (search: ManagedTranscriptSearch) => search.search({
      query: '森林觀測', sourceType: 'youtube', publisherId: 'channel-1', publishedFrom: '2026-09-01', publishedTo: '2026-09-30',
    }).then((result) => result.hits[0]?.id);

    await expect(withSearch(databasePath, () => [document], firstHit)).resolves.toBe(document.id);
    await expect(withSearch(databasePath, () => [document], async (search, _engine, rebuilds) => {
      expect(rebuilds).toBe(0);
      return firstHit(search);
    })).resolves.toBe(document.id);

    await rm(databasePath, { recursive: true, force: true });
    await expect(withSearch(databasePath, () => [document], firstHit)).resolves.toBe(document.id);
  }, 30_000);

  it('rebuilds at startup when the Vault has the same count but different content or identity', async () => {
    const databasePath = await tempDatabase();
    const original = [transcript('aaaaaaaaaaa', '原本的沙漠內容'), transcript('bbbbbbbbbbb', '第二篇的海洋內容')];
    await withSearch(databasePath, () => original, async () => undefined);

    // Same two documents: one body edited, one replaced by a different video.
    const changed = [transcript('aaaaaaaaaaa', '改寫後的冰河內容'), transcript('ccccccccccc', '新來的火山內容')];
    await withSearch(databasePath, () => changed, async (search, _engine, rebuilds) => {
      expect(rebuilds).toBe(1);
      expect((await search.search({ query: '冰河' })).hits.map(({ id }) => id)).toEqual(['youtube:aaaaaaaaaaa']);
      expect((await search.search({ query: '火山' })).hits.map(({ id }) => id)).toEqual(['youtube:ccccccccccc']);
      expect((await search.search({ query: '沙漠' })).total).toBe(0);
      expect((await search.search({ query: '海洋' })).total).toBe(0);
    });

    await withSearch(databasePath, () => changed, async (_search, _engine, rebuilds) => {
      expect(rebuilds).toBe(0);
    });
  }, 30_000);

  it('replaces an index written by the earlier schema with a fully rebuilt one', async () => {
    const databasePath = await tempDatabase();
    await withSearch(databasePath, () => [document], async (_search, engine) => {
      const created = await engineRequest(engine, '/indexes', { method: 'POST', body: JSON.stringify({ uid: 'transcripts', primaryKey: 'key' }) });
      expect(created.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await withSearch(databasePath, () => [document], async (search, engine) => {
      expect((await engineRequest(engine, '/indexes/transcripts')).status).toBe(404);
      expect((await search.search({ query: '森林觀測' })).hits[0]?.id).toBe(document.id);
    });
  }, 30_000);

  it('pages hits with an exact total and filters documents without a publisher ID', async () => {
    const databasePath = await tempDatabase();
    const documents = Array.from({ length: 30 }, (_, index) => transcript(
      `page${String(index).padStart(7, '0')}`,
      `共同關鍵詞 第 ${index} 篇`,
      index < 3 ? null : 'channel-1',
    ));
    await withSearch(databasePath, () => documents, async (search) => {
      const pages = await Promise.all([0, 20].map((offset) => search.search({ query: '共同關鍵詞', offset, limit: 20 })));
      expect(pages.map((page) => [page.total, page.hits.length])).toEqual([[30, 20], [30, 10]]);
      expect(new Set(pages.flatMap((page) => page.hits.map(({ id }) => id))).size).toBe(30);
      expect(pages[0]!.hits[0]!.snippet).toContain('<mark>');

      const legacy = await search.search({ query: '共同關鍵詞', sourceType: 'youtube', publisherId: 'none' });
      expect(legacy.total).toBe(3);
      expect(legacy.hits.every((hit) => hit.publisher.id === null)).toBe(true);
    });
  }, 30_000);

  it('stops returning a deleted document as soon as its removal is requested', async () => {
    const databasePath = await tempDatabase();
    const kept = transcript('keep0000000', '共同的草原內容，保留下來。');
    const deleted = transcript('gone0000000', '共同的草原內容，只有這篇有獨特的峽谷字。');
    let vault = [kept, deleted];
    await withSearch(databasePath, () => vault, async (search, engine) => {
      expect((await search.search({ query: '草原' })).total).toBe(2);
      // The exclusion filter a pending removal uses, against the real engine.
      const backend = new MeilisearchBackend({ baseUrl: engine.url, apiKey: engine.apiKey });
      const excluded = await backend.search({ query: '草原' }, [deleted.id]);
      expect([excluded.total, excluded.hits.map(({ id }) => id)]).toEqual([1, [kept.id]]);
      vault = [kept];
      await search.remove(deleted.id);
      expect((await search.search({ query: '峽谷' })).total).toBe(0);
      const common = await search.search({ query: '草原' });
      expect(common.hits.map(({ id }) => id)).toEqual([kept.id]);
      expect(common.total).toBe(1);
    });
    // The engine no longer holds it, so a restart needs no rebuild.
    await withSearch(databasePath, () => vault, async (search, _engine, rebuilds) => {
      expect(rebuilds).toBe(0);
      expect((await search.search({ query: '峽谷' })).total).toBe(0);
    });
  }, 30_000);
});
