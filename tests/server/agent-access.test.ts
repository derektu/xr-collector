import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collector } from '../../src/core/collector.js';
import type { CapturedTranscript } from '../../src/core/types.js';
import { UnavailableTranscriptSearch, ManagedTranscriptSearch } from '../../src/search/managed-transcript-search.js';
import { MeilisearchBackend } from '../../src/search/meilisearch-backend.js';
import { startMeilisearchProcess } from '../../src/search/meilisearch-process.js';
import { createHttpApp } from '../../src/server/app.js';
import { startAgentAccess } from '../../src/server/agent-access.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-agent-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const vault = new MarkdownVault(path.join(root, 'vault'));
  for (const id of ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']) {
    const capture: CapturedTranscript = {
      videoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}`,
      title: `Agent fixture ${id}`, channelId: null, channelTitle: 'Integration channel',
      publishedAt: '2026-09-18T00:00:00.000Z', languageCode: 'en', languageName: 'English',
      subtitleKind: 'manual', bodyMarkdown: 'Orchard observatory has a unique telescope.\n\nPreserve the complete source text.',
    };
    await vault.add(capture);
  }
  const capture = vi.fn();
  const collector = new Collector({ capture }, vault);
  return { root, vault, collector, capture };
}

describe('Agent read-only HTTP access', () => {
  it('requires credentials on every route and refuses all writes before side effects', async () => {
    const { collector, capture } = await fixture();
    const search = new UnavailableTranscriptSearch('索引尚未完成');
    const rebuild = vi.spyOn(search, 'rebuild');
    const app = await createHttpApp({ collector, search, agentToken: 'test-secret' });
    cleanup.push(() => app.close());
    for (const url of ['/api/health', '/api/documents', '/api/search', '/api/search/status', '/api/documents/youtube:aaaaaaaaaaa', '/']) {
      for (const authorization of ['', 'Bearer wrong', 'Bearer test-secreX']) {
        const response = await app.inject({ url, headers: { authorization } });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('unauthorized');
      }
    }
    const headers = { authorization: 'Bearer test-secret' };
    for (const [method, url] of [
      ['POST', '/api/youtube/collect'], ['POST', '/api/search/rebuild'],
      ['PUT', '/api/youtube/schedule'], ['PATCH', '/api/youtube/channels/channel'],
      ['DELETE', '/api/documents/youtube:aaaaaaaaaaa'], ['POST', '/api/youtube/channel-runs'],
      ['GET', '/api/agent/connection'], ['GET', '/'],
    ] as const) {
      const response = await app.inject({ method, url, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('read_only');
    }
    expect(capture).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect((await app.inject({ url: '/api/health', headers })).statusCode).toBe(200);
  });

  it('paginates without omissions, validates bounds, and reads the same full document as UI', async () => {
    const { collector } = await fixture();
    const agent = await createHttpApp({ collector, agentToken: 'secret' });
    const ui = await createHttpApp({ collector });
    cleanup.push(() => agent.close(), () => ui.close());
    const headers = { authorization: 'Bearer secret' };
    const ids: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const response = await agent.inject({ url: `/api/documents?offset=${offset}&limit=1`, headers });
      expect(response.json()).toMatchObject({ total: 3, offset, limit: 1, nextOffset: offset < 2 ? offset + 1 : null });
      ids.push(response.json().documents[0].id);
    }
    const uiList = (await ui.inject('/api/documents')).json().documents;
    expect(new Set(ids)).toEqual(new Set(uiList.map((d: { id: string }) => d.id)));
    expect((await agent.inject({ url: '/api/documents?offset=99', headers })).json().documents).toEqual([]);
    expect((await agent.inject({ url: '/api/documents', headers })).json()).toMatchObject({ total: 3, offset: 0, limit: 50 });
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=1000001', 'offset=NaN', 'limit=1&limit=2']) {
      expect((await agent.inject({ url: `/api/documents?${query}`, headers })).statusCode).toBe(400);
    }
    const url = `/api/documents/${encodeURIComponent(ids[0]!)}`;
    const read = await agent.inject({ url, headers });
    expect(read.json()).toEqual((await ui.inject(url)).json());
    expect(read.json().document).toMatchObject({ sourceUrl: expect.stringContaining('youtube.com'), bodyMarkdown: expect.stringContaining('Preserve the complete source text.') });
    const missing = await agent.inject({ url: '/api/documents/youtube:zzzzzzzzzzz', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('document_not_found');
  });

  it('reports incomplete indexing while browse/read remain available', async () => {
    const { collector } = await fixture();
    const backend = { initialize: vi.fn(), count: vi.fn(), replaceAll: vi.fn(), upsert: vi.fn(), search: vi.fn() };
    const search = new ManagedTranscriptSearch(backend, async () => []);
    const app = await createHttpApp({ collector, search, agentToken: 'secret' });
    cleanup.push(() => app.close());
    const headers = { authorization: 'Bearer secret' };
    expect((await app.inject({ url: '/api/search/status', headers })).json().status.state).toBe('starting');
    const result = await app.inject({ url: '/api/search?q=orchard', headers });
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('search_unavailable');
    expect((await app.inject({ url: '/api/documents', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/documents/youtube:aaaaaaaaaaa', headers })).statusCode).toBe(200);
    expect(backend.search).not.toHaveBeenCalled();
  });

  it.skipIf(!existsSync('resources/bin/mac/meilisearch'))('serves the platform-neutral HTTP contract, rotates credentials, and closes the listener', async () => {
    const { root, vault, collector } = await fixture();
    const engine = await startMeilisearchProcess({ binaryPath: path.resolve('resources/bin/mac/meilisearch'), databasePath: path.join(root, 'search') });
    cleanup.push(() => engine.close());
    const search = new ManagedTranscriptSearch(new MeilisearchBackend({ baseUrl: engine.url, apiKey: engine.apiKey }),
      async () => Promise.all((await vault.list()).map((d) => collector.read(d.id))));
    await search.start();
    const connectionFile = path.join(root, 'agent-connection.json');
    const options = { collector, search, connectionFile, skillPath: path.resolve('skills/xr-collector-agent') };
    const access = await startAgentAccess(options);
    cleanup.push(() => access.close());
    const config = JSON.parse(await readFile(connectionFile, 'utf8'));
    expect((await stat(connectionFile)).mode & 0o777).toBe(0o600);
    expect(new URL(config.url).hostname).toBe('127.0.0.1');
    // The development test runner is the HTTP client; no client-side helper is distributed.
    const get = async (route: string) => {
      const current = JSON.parse(await readFile(connectionFile, 'utf8'));
      const response = await fetch(`${current.url}${route}`, {
        headers: { Authorization: `Bearer ${current.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain(current.token);
      return JSON.parse(body);
    };
    const browse = await get('/api/documents?limit=1');
    expect(browse.total).toBe(3);
    const first = await get('/api/search?q=orchard&limit=1&offset=0&channel=Integration%20channel&publishedFrom=2026-09-18');
    const second = await get('/api/search?q=orchard&limit=1&offset=1');
    expect(first.hits).toHaveLength(1);
    expect(second.hits).toHaveLength(1);
    expect(first.hits[0].id).not.toBe(second.hits[0].id);
    const ui = await createHttpApp({ collector, search });
    cleanup.push(() => ui.close());
    for (const query of ['limit=101', 'offset=-1', 'q=first&q=second', 'publishedFrom=2026-02-30']) {
      expect((await ui.inject(`/api/search?${query}`)).statusCode).toBe(400);
    }
    expect(first.hits[0]).toEqual((await ui.inject('/api/search?q=orchard')).json().hits[0]);
    const read = await get(`/api/documents/${encodeURIComponent(first.hits[0].id)}`);
    expect(read).toEqual((await ui.inject(`/api/documents/${encodeURIComponent(first.hits[0].id)}`)).json());
    expect((await get('/api/search?q=nonexistentkeyword')).hits).toEqual([]);
    expect((await get('/api/search/status')).status.state).toBe('ready');
    await access.close();
    await expect(get('/api/documents')).rejects.toThrow('fetch failed');
    await chmod(connectionFile, 0o644);
    const restarted = await startAgentAccess(options);
    cleanup.push(() => restarted.close());
    const nextConfig = JSON.parse(await readFile(connectionFile, 'utf8'));
    expect(nextConfig.token).not.toBe(config.token);
    expect((await stat(connectionFile)).mode & 0o777).toBe(0o600);
    expect((await fetch(`${nextConfig.url}/api/documents`, { headers: { Authorization: `Bearer ${config.token}` } })).status).toBe(401);
    expect((await get('/api/documents')).total).toBe(3);
  }, 30_000);
});
