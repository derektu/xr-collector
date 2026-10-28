import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collector } from '../../src/core/collector.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { UnavailableTranscriptSearch, ManagedTranscriptSearch } from '../../src/search/managed-transcript-search.js';
import { MeilisearchBackend } from '../../src/search/meilisearch-backend.js';
import { loadSearchLexicon } from '../../src/search/search-lexicon.js';
import { startMeilisearchProcess } from '../../src/search/meilisearch-process.js';
import { createHttpApp } from '../../src/server/app.js';
import { startAgentAccess } from '../../src/server/agent-access.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import type { CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';
import { zipEntries } from '../vault/package-fixtures.js';

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
    await vault.add(transcriptDocument(capture));
  }
  const capture = vi.fn();
  const collector = new Collector(vault);
  const jobs = new JobManager({
    vaultPath: path.join(root, 'vault'), store: JobStore.memory(), documents: collector,
    plugins: [youtubePlugin({ capture, resolveChannel: vi.fn(), discover: vi.fn() })],
  });
  return { root, vault, collector, capture, jobs };
}

describe('Agent authenticated HTTP access', () => {
  it('requires credentials on every route and permits existing business writes', async () => {
    const { collector, capture, jobs } = await fixture();
    const search = {
      status: () => ({ state: 'ready' as const, indexedDocuments: 3, lastRebuiltAt: null, message: '' }),
      search: vi.fn(async () => ({ hits: [], total: 0, offset: 0, limit: 50 })),
      index: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
    };
    const rebuild = search.rebuild;
    const schedule = {
      getSchedule: vi.fn(async () => ({ enabled: false, intervalMinutes: 60 })),
      updateSchedule: vi.fn(async (value) => value),
    };
    const channels = {
      type: 'youtube', list: vi.fn(async () => []), add: vi.fn(), setEnabled: vi.fn(),
      remove: vi.fn(), startRun: vi.fn(),
    };
    const app = await createHttpApp({ collector, jobs, search, schedule, subscriptions: [channels], agentToken: 'test-secret' });
    cleanup.push(() => app.close());
    for (const url of ['/api/health', '/api/documents', '/api/search', '/api/search/status', '/api/documents/youtube:aaaaaaaaaaa', '/api/jobs', '/']) {
      for (const authorization of ['', 'Bearer wrong', 'Bearer test-secreX']) {
        const response = await app.inject({ url, headers: { authorization } });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('unauthorized');
      }
    }
    const headers = { authorization: 'Bearer test-secret' };
    const rebuildResponse = await app.inject({ method: 'POST', url: '/api/search/rebuild', headers });
    expect(rebuildResponse.statusCode).toBe(200);
    expect(rebuild).toHaveBeenCalledOnce();
    const scheduleResponse = await app.inject({
      method: 'PUT', url: '/api/schedule', headers,
      payload: { enabled: true },
    });
    expect(scheduleResponse.statusCode).toBe(200);
    expect(schedule.updateSchedule).toHaveBeenCalledWith({ enabled: true });
    expect((await app.inject({ method: 'POST', url: '/api/items', headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/submissions', payload: { url: '@agent' } })).statusCode).toBe(401);
    expect(capture).not.toHaveBeenCalled();
    expect((await app.inject({ url: '/api/jobs', headers })).json()).toEqual({ jobs: [], nextCursor: null });
    expect((await app.inject({ url: '/api/agent/connection', headers })).statusCode).toBe(404);
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

  it('deletes a document for an authorized Agent with the same results the UI sees (A7)', async () => {
    const { collector } = await fixture();
    const agent = await createHttpApp({ collector, agentToken: 'secret' });
    const ui = await createHttpApp({ collector });
    cleanup.push(() => agent.close(), () => ui.close());
    const headers = { authorization: 'Bearer secret' };
    const url = `/api/documents/${encodeURIComponent('youtube:aaaaaaaaaaa')}`;

    expect((await agent.inject({ method: 'DELETE', url })).statusCode).toBe(401);
    const deleted = await agent.inject({ method: 'DELETE', url, headers });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      deleted: { id: 'youtube:aaaaaaaaaaa', sourceType: 'youtube', sourceId: 'aaaaaaaaaaa', title: 'Agent fixture aaaaaaaaaaa', deletedAt: expect.any(String) },
      indexed: false,
    });
    for (const app of [agent, ui]) {
      const options = app === agent ? { headers } : {};
      const read = await app.inject({ url, ...options });
      expect([read.statusCode, read.json().error.code]).toEqual([404, 'document_deleted']);
      const again = await app.inject({ method: 'DELETE', url, ...options });
      expect([again.statusCode, again.json().error.code]).toEqual([404, 'document_deleted']);
      expect((await app.inject({ url: '/api/documents', ...options })).json().total).toBe(2);
    }
    const missing = await ui.inject({ method: 'DELETE', url: '/api/documents/youtube:zzzzzzzzzzz' });
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, 'document_not_found']);
  });

  it('reports incomplete indexing while browse/read remain available', async () => {
    const { collector } = await fixture();
    const backend = { initialize: vi.fn(), count: vi.fn(), isCurrent: vi.fn(), replaceAll: vi.fn(), upsert: vi.fn(), search: vi.fn() };
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

  it.skipIf(!existsSync('resources/bin/mac/meilisearch'))('serves the platform-neutral HTTP contract and keeps credentials across restart', async () => {
    const { root, vault, collector } = await fixture();
    const lexiconPath = path.resolve('resources/search/coct-main.txt');
    const engine = await startMeilisearchProcess({ binaryPath: path.resolve('resources/bin/mac/meilisearch'), databasePath: path.join(root, 'search'), lexiconPath });
    cleanup.push(() => engine.close());
    const search = new ManagedTranscriptSearch(new MeilisearchBackend({ baseUrl: engine.url, apiKey: engine.apiKey, lexicon: await loadSearchLexicon(lexiconPath) }),
      async () => Promise.all((await vault.list()).map((d) => collector.read(d.id))));
    await search.start();
    const settingsFile = path.join(root, 'agent-settings.json');
    const options = {
      collector, search, settingsFile, preferredPort: 7232,
      skillPath: path.resolve('skills/xr-collector-agent'),
    };
    const access = await startAgentAccess(options);
    cleanup.push(() => access.close());
    const config = access.connection();
    if (process.platform !== 'win32') expect((await stat(settingsFile)).mode & 0o777).toBe(0o600);
    expect(new URL(config.url).hostname).toBe('127.0.0.1');
    // The development test runner is the HTTP client; no client-side helper is distributed.
    const get = async (route: string) => {
      const current = access.connection();
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
    const first = await get('/api/search?q=orchard&limit=1&offset=0&sourceType=youtube&publisherId=none&publishedFrom=2026-09-18');
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
    expect((await get('/api/search/status')).status).toMatchObject({ state: 'ready', indexedDocuments: 3, vaultDocuments: 3 });
    expect((await get('/api/documents/sources')).sources).toEqual((await ui.inject('/api/documents/sources')).json().sources);
    await access.close();
    await expect(get('/api/documents')).rejects.toThrow();
    const restarted = await startAgentAccess(options);
    cleanup.push(() => restarted.close());
    const nextConfig = restarted.connection();
    expect(nextConfig.token).toBe(config.token);
    expect((await fetch(`${nextConfig.url}/api/documents`, { headers: { Authorization: `Bearer ${config.token}` } })).status).toBe(200);
  }, 30_000);

  it('listens on the preferred port, or the next free one when it is taken, and records the port it uses', async () => {
    const { root, collector } = await fixture();
    const settingsFile = path.join(root, 'agent-settings.json');
    const options = { collector, settingsFile, preferredPort: 7232, skillPath: path.resolve('skills/xr-collector-agent') };
    const blocker = await listenOnFreePort();
    cleanup.push(() => new Promise((resolve) => blocker.close(resolve)));
    const taken = (blocker.address() as { port: number }).port;

    const moved = await startAgentAccess({ ...options, preferredPort: taken });
    const movedPort = Number(new URL(moved.connection().url).port);
    expect(movedPort).toBeGreaterThan(taken);
    expect(movedPort).toBeLessThan(taken + 10);
    expect(new URL(moved.connection().url).port).toBe(String(movedPort));
    const originalToken = moved.connection().token;
    for (const port of [0, 65_536]) {
      const invalid = await fetch(`${moved.connection().url}/api/device/agent/port`, { method: 'PUT',
        headers: { authorization: `Bearer ${originalToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'fixed', port }) });
      expect(invalid.status).toBe(400);
    }
    expect(moved.status()).toMatchObject({ configured: { mode: 'auto' }, restartRequired: false });
    const configured = await fetch(`${moved.connection().url}/api/device/agent/port`, { method: 'PUT',
      headers: { authorization: `Bearer ${originalToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fixed', port: taken }) });
    expect(configured.status).toBe(200);
    const pending = (await configured.json()).agent;
    expect(pending).toMatchObject({ activePort: movedPort, configured: { mode: 'fixed', port: taken }, restartRequired: true });
    await moved.close();

    await new Promise((resolve) => blocker.close(resolve));
    const preferred = await startAgentAccess({ ...options, preferredPort: taken });
    cleanup.push(() => preferred.close());
    const config = preferred.connection();
    expect(new URL(config.url).port).toBe(String(taken));
    expect(config.token).toBe(originalToken);
    expect(preferred.status()).toMatchObject({ configured: { mode: 'fixed', port: taken }, restartRequired: false });
    expect((await fetch(`${config.url}/api/documents`, { headers: { Authorization: `Bearer ${config.token}` } })).status).toBe(200);
    const before = config.token;
    const reset = await fetch(`${config.url}/api/device/agent/key/reset`, { method: 'POST', headers: { authorization: `Bearer ${before}` } });
    expect(reset.status).toBe(200);
    const rotated = (await reset.json()).connection;
    expect(rotated.token).not.toBe(before);
    expect((await fetch(`${config.url}/api/documents`, { headers: { Authorization: `Bearer ${before}` } })).status).toBe(401);
    expect((await fetch(`${config.url}/api/documents`, { headers: { Authorization: `Bearer ${rotated.token}` } })).status).toBe(200);
    if (process.platform !== 'win32') expect((await stat(settingsFile)).mode & 0o777).toBe(0o600);
    const files = await zipEntries(await preferred.download());
    expect([...files.keys()]).toEqual(['xr-collector-agent/SKILL.md', 'xr-collector-agent/connection.json']);
    const bundled = JSON.parse(files.get('xr-collector-agent/connection.json')!.toString());
    expect(bundled).toEqual({ schemaVersion: 1, ...rotated });
    expect(JSON.stringify(bundled)).not.toContain(root);
    expect(bundled).not.toHaveProperty('runtimeId');
    const skill = files.get('xr-collector-agent/SKILL.md')!.toString();
    expect(skill).toContain('同一資料夾內的 `connection.json`');
    expect(skill).not.toContain('agent-connection.json');
  });

  it('serializes a port update and key reset without losing either saved field', async () => {
    const { root, collector } = await fixture();
    const settingsFile = path.join(root, 'agent-settings.json');
    const access = await startAgentAccess({ collector, settingsFile, preferredPort: 7232, skillPath: path.resolve('skills/xr-collector-agent') });
    cleanup.push(() => access.close());
    const before = access.connection();

    const [configured, reset] = await Promise.all([access.configure({ mode: 'fixed', port: 65431 }), access.resetKey()]);

    expect(configured.configured).toEqual({ mode: 'fixed', port: 65431 });
    expect(reset.token).not.toBe(before.token);
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({
      schemaVersion: 1, token: reset.token, port: { mode: 'fixed', port: 65431 },
    });
    expect((await fetch(`${before.url}/api/health`, { headers: { authorization: `Bearer ${before.token}` } })).status).toBe(401);
    expect((await fetch(`${before.url}/api/health`, { headers: { authorization: `Bearer ${reset.token}` } })).status).toBe(200);
  });

  it('keeps the app usable when its configured fixed port cannot bind', async () => {
    const { root, collector } = await fixture();
    const blocker = await listenOnFreePort();
    cleanup.push(() => new Promise((resolve) => blocker.close(resolve)));
    const fixed = (blocker.address() as { port: number }).port;
    const settingsFile = path.join(root, 'agent-settings.json');
    await writeFile(settingsFile, JSON.stringify({ schemaVersion: 1, token: 'persistent-test-key', port: { mode: 'fixed', port: fixed } }));
    const access = await startAgentAccess({ collector, settingsFile, preferredPort: 7232, skillPath: path.resolve('skills/xr-collector-agent') });
    cleanup.push(() => access.close());
    expect(access.status()).toMatchObject({ state: 'unavailable', activeUrl: null, configured: { mode: 'fixed', port: fixed } });
    expect(() => access.connection()).toThrow('無法使用');
    await expect(access.resetKey()).rejects.toThrow('無法使用');
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).token).toBe('persistent-test-key');
    await access.configure({ mode: 'auto' });
    expect(access.status()).toMatchObject({ state: 'unavailable', configured: { mode: 'auto' }, restartRequired: true });
    expect((await collector.listDocuments({}, { offset: 0, limit: 1 })).total).toBe(3);
  });

  it('keeps the current key when saving a reset fails', async () => {
    const { root, collector } = await fixture();
    const settingsFile = path.join(root, 'agent-settings.json');
    const access = await startAgentAccess({ collector, settingsFile, preferredPort: 7232, skillPath: path.resolve('skills/xr-collector-agent') });
    cleanup.push(() => access.close());
    const current = access.connection();
    await rm(settingsFile);
    await mkdir(settingsFile);
    await expect(access.resetKey()).rejects.toThrow();
    expect(access.connection().token).toBe(current.token);
    expect((await fetch(`${current.url}/api/health`, { headers: { authorization: `Bearer ${current.token}` } })).status).toBe(200);
  });

  it('keeps the UI API usable when the first private key cannot be saved', async () => {
    const { root, collector } = await fixture();
    // A trailing separator makes the initial read report ENOENT, then makes the first temporary
    // write target a missing directory. This reaches the save failure rather than a read failure.
    const missingParent = path.join(root, 'missing-settings-parent');
    const settingsFile = `${missingParent}${path.sep}`;
    const access = await startAgentAccess({ collector, settingsFile, preferredPort: 7232, skillPath: path.resolve('skills/xr-collector-agent') });
    cleanup.push(() => access.close());
    const ui = await createHttpApp({ collector, agentConnection: access });
    cleanup.push(() => ui.close());

    expect((await ui.inject('/api/health')).statusCode).toBe(200);
    const status = await ui.inject('/api/device/agent');
    expect(status.statusCode).toBe(200);
    expect(status.json().agent).toMatchObject({ state: 'unavailable', activeUrl: null, message: expect.stringContaining('無法讀取或保存') });
    expect((await ui.inject('/api/documents')).json().total).toBe(3);
    expect((await ui.inject('/api/device/agent/connection')).statusCode).toBe(409);
    expect(existsSync(missingParent)).toBe(false);
  });
});

function listenOnFreePort(): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve(server));
  });
}
