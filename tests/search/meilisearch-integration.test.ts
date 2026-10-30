import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SavedDocument } from '../../src/core/types.js';
import { ManagedTranscriptSearch } from '../../src/search/managed-transcript-search.js';
import { MeilisearchBackend } from '../../src/search/meilisearch-backend.js';
import { loadSearchLexicon } from '../../src/search/search-lexicon.js';
import {
  startMeilisearchProcess,
  type RunningMeilisearch,
} from '../../src/search/meilisearch-process.js';

const roots: string[] = [];
const running = new Set<RunningMeilisearch>();
const bundledBinary = path.resolve('resources/bin/mac/meilisearch');
const bundledLexicon = path.resolve('resources/search/coct-main.txt');
const lexiconPromise = loadSearchLexicon(bundledLexicon);

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
  const lexicon = await lexiconPromise;
  const engine = await startMeilisearchProcess({ binaryPath: bundledBinary, databasePath });
  running.add(engine);
  try {
    let rebuilds = 0;
    const search = new ManagedTranscriptSearch(
      new MeilisearchBackend({ baseUrl: engine.url, apiKey: engine.apiKey, lexicon }),
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
      `${index % 2 === 0 ? '共同關鍵詞' : '共同关键词'} 第 ${index} 篇`,
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

  it('normalizes document and query text while returning raw metadata and snippets', async () => {
    const databasePath = await tempDatabase();
    const variants = [
      { sourceId: 'traditional', title: '台積電 ＡＩ', publisher: 'CoWoS 頻道', body: '發展 ００５０與台積電🙂 <script>raw</script>' },
      { sourceId: 'simplified0', title: '台积电 AI', publisher: 'cowos 频道', body: '发展 0050与台积电🙂 <script>raw</script>' },
      { sourceId: 'variant0000', title: '臺積電 ai', publisher: 'ＣｏＷｏＳ 頻道', body: '發展 0050與臺積電🙂 <script>raw</script>' },
    ].map(({ sourceId, title, publisher, body }) => ({
      ...transcript(sourceId, body), title, publisher: { id: 'normalization', name: publisher },
    }));

    await withSearch(databasePath, () => variants, async (search) => {
      const expectedIds = new Set(variants.map(({ id }) => id));
      for (const query of ['台積電', '台积电', '臺積電', 'ＡＩ', 'AI', 'CoWoS', 'cowos', '００５０', '0050']) {
        const result = await search.search({ query });
        expect(result.total, query).toBe(3);
        expect(new Set(result.hits.map(({ id }) => id)), query).toEqual(expectedIds);
      }
      const simplified = await search.search({ query: '台积电', limit: 10 });
      expect(simplified.hits.find(({ id }) => id === 'youtube:simplified0')).toMatchObject({
        title: '台积电 AI', publisher: { name: 'cowos 频道' },
      });
      const rawSnippet = simplified.hits.find(({ id }) => id === 'youtube:simplified0')!.snippet;
      expect(rawSnippet).toContain('<mark>台积电</mark>');
      expect(rawSnippet).toContain('🙂 <script>raw</script>');
      expect((await search.search({ query: ' \n\t　' })).total).toBe(3);
    });
  }, 30_000);

  it('applies the same projection independently to title, publisher and body', async () => {
    const databasePath = await tempDatabase();
    const inTitle = { ...transcript('fieldtitle0', '正文沒有目標'), title: '光刻机標題' };
    const inPublisher = {
      ...transcript('fieldpubl00', '正文沒有目標'),
      publisher: { id: 'field-publisher', name: '光刻機發布者' },
    };
    const inBody = transcript('fieldbody00', '正文只有這裡寫光刻機');
    const expected = new Set([inTitle.id, inPublisher.id, inBody.id]);
    await withSearch(databasePath, () => [inTitle, inPublisher, inBody], async (search) => {
      for (const query of ['光刻机', '光刻機']) {
        const result = await search.search({ query });
        expect(result.total, query).toBe(3);
        expect(new Set(result.hits.map(({ id }) => id)), query).toEqual(expected);
      }
      const simplified = await search.search({ query: '光刻机' });
      expect(simplified.hits.find(({ id }) => id === inTitle.id)?.title).toBe('光刻机標題');
      expect(simplified.hits.find(({ id }) => id === inPublisher.id)?.publisher.name).toBe('光刻機發布者');
    });
  }, 30_000);

  it('uses OpenCC phrase context without expanding regional vocabulary', async () => {
    const databasePath = await tempDatabase();
    const contextual = transcript('context0000', '发展、头发、干燥、干部；服务器與软件。');
    const regional = transcript('regional00', '發展、頭髮、乾燥、幹部；伺服器與軟體。');
    await withSearch(databasePath, () => [contextual, regional], async (search) => {
      for (const query of ['發展', '頭髮', '乾燥', '幹部']) expect((await search.search({ query })).total, query).toBe(2);
      expect((await search.search({ query: '服務器' })).hits.map(({ id }) => id)).toEqual([contextual.id]);
      expect((await search.search({ query: '伺服器' })).hits.map(({ id }) => id)).toEqual([regional.id]);
      expect((await search.search({ query: '軟件' })).hits.map(({ id }) => id)).toEqual([contextual.id]);
      expect((await search.search({ query: '軟體' })).hits.map(({ id }) => id)).toEqual([regional.id]);
    });
  }, 30_000);

  it('keeps complete words first and recalls only contiguous Chinese fragments', async () => {
    const databasePath = await tempDatabase();
    const exactWord = transcript('exactword00', '今天談股，也談別的主題。');
    const fragment = transcript('fragment000', '半導體與個股現金流量，也追蹤離岸風電。');
    const scattered = transcript('scattered00', '半年展望由導師說明，直觀分析後產品賣光；離岸市場稍後有風。');
    const crossField = { ...transcript('crossfield0', '體'), title: '半', publisher: { id: 'channel-1', name: '導' } };
    await withSearch(databasePath, () => [fragment, scattered, crossField, exactWord], async (search) => {
      expect((await search.search({ query: '股' })).hits.map(({ id }) => id)).toEqual([exactWord.id, fragment.id]);
      expect((await search.search({ query: '半導' })).hits.map(({ id }) => id)).toEqual([fragment.id]);
      expect((await search.search({ query: '導體' })).hits.map(({ id }) => id)).toEqual([fragment.id]);
      expect((await search.search({ query: '金' })).hits.map(({ id }) => id)).toEqual([fragment.id]);
      expect((await search.search({ query: '觀光' })).total).toBe(0);
      expect((await search.search({ query: '離岸風' })).hits.map(({ id }) => id)).toEqual([fragment.id]);
      expect((await search.search({ query: '"半導體與個股"' })).hits.map(({ id }) => id)).toEqual([fragment.id]);
      expect((await search.search({ query: '半導體 現金' })).hits.map(({ id }) => id)).toEqual([fragment.id]);
      const snippet = (await search.search({ query: '導體' })).hits[0]!.snippet;
      expect(snippet).toContain('半<mark>導體</mark>');
    });
  }, 30_000);

  it('leaves pure Latin and mixed-query typo and prefix matching to Meilisearch', async () => {
    const databasePath = await tempDatabase();
    const target = transcript('mixedlatin0', 'semiconductor roadmap 與半導體供應鏈');
    const wrongChinese = transcript('wrongcjk000', 'semiconductor roadmap，半年後由導師更新');
    await withSearch(databasePath, () => [target, wrongChinese], async (search) => {
      expect((await search.search({ query: 'semiconductr' })).hits.map(({ id }) => id)).toContain(target.id);
      expect((await search.search({ query: 'semicon' })).hits.map(({ id }) => id)).toContain(target.id);
      const mixed = await search.search({ query: 'semiconductr 半導' });
      expect(mixed.hits.map(({ id }) => id)).toEqual([target.id]);
      expect(mixed.hits[0]!.snippet).toContain('<mark>semiconducto</mark>r');
      expect(mixed.hits[0]!.snippet).toContain('<mark>半導</mark>');
      expect((await search.search({ query: 'semicon 半導' })).hits.map(({ id }) => id)).toEqual([target.id]);
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
