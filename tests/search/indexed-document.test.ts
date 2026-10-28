import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';
import { MeilisearchBackend } from '../../src/search/meilisearch-backend.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** The documents a full rebuild sends to the index. */
async function indexed(vault: MarkdownVault): Promise<Array<{ id: string; contentHash: string; youtube: unknown }>> {
  const bodies: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PUT' && typeof init.body === 'string') bodies.push(init.body);
    return Response.json(String(url).includes('/tasks/') ? { status: 'succeeded' } : { taskUid: 1 });
  };
  const documents = await Promise.all((await vault.list()).map(async (entry) => (await vault.read(entry.id))!));
  await new MeilisearchBackend({ baseUrl: 'http://search.invalid', apiKey: 'key', fetch: fetch as typeof globalThis.fetch })
    .replaceAll(documents);
  return JSON.parse(bodies[0]!) as Array<{ id: string; contentHash: string; youtube: unknown }>;
}

describe('the indexed form of a YouTube document', () => {
  // The digest is pinned: any change to the indexed form of a YouTube document makes every index
  // already on disk look stale, and starting the search would then rebuild it.
  it('keeps the content hash of an existing index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-indexed-'));
    roots.push(root);
    const vault = new MarkdownVault(root, { now: () => new Date('2026-10-15T04:00:00.000Z') });
    await vault.add(transcriptDocument({
      videoId: 'aaaaaaaaaa1', sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaa1', title: '人工字幕',
      channelId: 'UC111', channelTitle: '頻道一', publishedAt: '2026-10-01T08:00:00.000Z',
      languageCode: 'zh-TW', languageName: '中文（台灣）', subtitleKind: 'manual', bodyMarkdown: '第一段。\n\n第二段。',
    }));

    expect(await indexed(vault)).toMatchObject([{
      id: 'youtube:aaaaaaaaaa1',
      youtube: { languageCode: 'zh-TW', languageName: '中文（台灣）', subtitleKind: 'manual' },
      contentHash: '681c159c500b4cb52377b9c6c0e0e9b72de6b4861e89b52dd99a73b362aada98',
    }]);
  });
});
