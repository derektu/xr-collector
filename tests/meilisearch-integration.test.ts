import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SavedDocument } from '../src/core/types.js';
import { ManagedTranscriptSearch } from '../src/search/managed-transcript-search.js';
import { MeilisearchBackend } from '../src/search/meilisearch-backend.js';
import {
  startMeilisearchProcess,
  type RunningMeilisearch,
} from '../src/search/meilisearch-process.js';

const roots: string[] = [];
const running = new Set<RunningMeilisearch>();
const bundledBinary = path.resolve('resources/bin/mac/meilisearch');

afterEach(async () => {
  await Promise.all([...running].map((process) => process.close()));
  running.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const document: SavedDocument = {
  id: 'youtube:dQw4w9WgXcQ',
  type: 'Transcript',
  title: '一支談本機搜尋的影片',
  sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  sourceId: 'dQw4w9WgXcQ',
  channelId: 'channel-1',
  channelTitle: '測試頻道',
  publishedAt: '2026-09-12T00:00:00.000Z',
  collectedAt: '2026-09-17T00:00:00.000Z',
  languageCode: 'zh-Hant',
  languageName: '繁體中文',
  subtitleKind: 'manual',
  bodyMarkdown: '這份字幕裡有獨特的森林觀測關鍵詞。',
};

describe.skipIf(!existsSync(bundledBinary))('bundled Meilisearch integration', () => {
  it('searches after restart and rebuilds after the local index is removed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-meili-test-'));
    roots.push(root);
    const databasePath = path.join(root, 'search-data');

    await expect(searchWithRuntime(bundledBinary, databasePath)).resolves.toBe(document.id);
    await expect(searchWithRuntime(bundledBinary, databasePath)).resolves.toBe(document.id);

    await rm(databasePath, { recursive: true, force: true });
    await expect(searchWithRuntime(bundledBinary, databasePath)).resolves.toBe(document.id);
  }, 30_000);
});

async function searchWithRuntime(binaryPath: string, databasePath: string): Promise<string> {
  const process = await startMeilisearchProcess({ binaryPath, databasePath });
  running.add(process);
  try {
    const backend = new MeilisearchBackend({
      baseUrl: process.url,
      apiKey: process.apiKey,
    });
    const search = new ManagedTranscriptSearch(backend, async () => [document]);
    await search.start();
    const result = await search.search({
      query: '森林觀測',
      channel: '測試頻道',
      publishedFrom: '2026-09-01',
      publishedTo: '2026-09-30',
    });
    return result.hits[0]?.id ?? '';
  } finally {
    running.delete(process);
    await process.close();
  }
}
