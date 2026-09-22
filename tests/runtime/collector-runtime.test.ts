import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedTranscript, TranscriptSearch } from '../../src/core/types.js';
import { Collector } from '../../src/core/collector.js';
import { CollectorRuntime, type CollectorRuntimeOptions } from '../../src/runtime/collector-runtime.js';
import { UnavailableTranscriptSearch } from '../../src/search/managed-transcript-search.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function options(capture: CollectorRuntimeOptions['workspace']['capture'], search?: TranscriptSearch) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-runtime-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const closeSearch = vi.fn(async () => undefined);
  return {
    closeSearch,
    value: {
      profilePath: root,
      workspace: {
        defaultRoot: path.join(root, 'vault'),
        capture,
        channelSource: {
          resolve: async () => ({ id: 'UC-runtime', title: 'Runtime', url: 'https://www.youtube.com/channel/UC-runtime' }),
          listVideos: async () => [],
        },
        searchBinary: 'unused', searchData: path.join(root, 'search'),
        createSearch: async () => ({ search: search ?? new UnavailableTranscriptSearch('test'), close: closeSearch }),
      },
      connectionFile: path.join(root, 'agent-connection.json'),
      skillPath: path.resolve('skills/xr-collector-agent'),
      uiPort: 0,
    } satisfies CollectorRuntimeOptions,
  };
}

describe('CollectorRuntime', () => {
  it('serves authenticated Not Ready status without creating Vault services', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-runtime-not-ready-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const connectionFile = path.join(root, 'agent-connection.json');
    const runtime = await CollectorRuntime.start({
      profilePath: root, workspace: null, connectionFile,
      skillPath: path.resolve('skills/xr-collector-agent'), uiPort: 0,
    });
    cleanups.push(() => runtime.close());
    expect(runtime.status()).toMatchObject({
      state: 'not_ready', vaultPath: null,
      message: expect.stringContaining('Onboarding'),
    });
    const uiHealth = await fetch(`${runtime.server.url}/api/health?probe=1`);
    expect(uiHealth.status).toBe(200);
    expect(await uiHealth.json()).toMatchObject({ status: 'unavailable', runtime: { state: 'not_ready', vaultPath: null } });
    expect((await fetch(`${runtime.server.url}/api/documents`)).status).toBe(503);
    expect((await fetch(`${runtime.server.url}/api/agent/connection`)).status).toBe(200);

    const connection = JSON.parse(await readFile(connectionFile, 'utf8')) as { url: string; token: string };
    expect((await fetch(`${connection.url}/api/health`)).status).toBe(401);
    expect((await fetch(`${connection.url}/api/health`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const agentHealth = await fetch(`${connection.url}/api/health`, { headers: { authorization: `Bearer ${connection.token}` } });
    expect(agentHealth.status).toBe(200);
    expect((await agentHealth.json()).status).toBe('unavailable');
    const blocked = await fetch(`${connection.url}/api/youtube/collect`, {
      method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=runtime0001' }),
    });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ error: { code: 'vault_not_ready', message: expect.stringContaining('Onboarding') } });
    expect(await readdir(root)).toEqual(['agent-connection.json']);
  });

  it('reports a missing selected Vault as Not Ready without falling back', async () => {
    const setup = await options({ capture: vi.fn() });
    await writeFile(`${setup.value.workspace.defaultRoot}.active.json`, JSON.stringify({ name: 'vault-missing' }));
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    expect(runtime.status()).toMatchObject({
      state: 'not_ready', vaultPath: null,
      message: expect.stringContaining('不存在'),
    });
    const entries = await readdir(setup.value.profilePath);
    expect(entries).toContain('vault.active.json');
    expect(entries).not.toContain('vault');
    expect(entries).not.toContain('search');
  });

  it('shares one workspace with UI and Agent and keeps accepted collection alive after client disconnect', async () => {
    let release!: (capture: CapturedTranscript) => void;
    const waiting = new Promise<CapturedTranscript>((resolve) => { release = resolve; });
    const capture = vi.fn(async () => waiting);
    const collectCalls = vi.spyOn(Collector.prototype, 'collect');
    const setup = await options({ capture });
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    expect(runtime.status()).toMatchObject({ state: 'ready', profilePath: setup.value.profilePath, vaultPath: setup.value.workspace.defaultRoot });

    const connection = JSON.parse(await readFile(setup.value.connectionFile, 'utf8')) as { url: string; token: string };
    const client = spawn(process.execPath, ['-e', `
      const target = new URL(${JSON.stringify(`${connection.url}/api/youtube/collect`)});
      const body = JSON.stringify({url:'https://www.youtube.com/watch?v=runtime0001'});
      const request = require('node:http').request(target, {method:'POST', headers:{authorization:${JSON.stringify(`Bearer ${connection.token}`)},'content-type':'application/json','content-length':Buffer.byteLength(body)}});
      request.on('finish', () => setTimeout(() => process.exit(0), 10));
      request.end(body);
    `], { stdio: 'ignore' });
    const clientExited = new Promise<void>((resolve, reject) => {
      client.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`client exited ${code}`)));
      client.once('error', reject);
    });
    const captured: CapturedTranscript = {
      videoId: 'runtime0001', sourceUrl: 'https://www.youtube.com/watch?v=runtime0001',
      title: 'Disconnected client', channelId: null, channelTitle: 'Runtime', publishedAt: null,
      languageCode: 'en', languageName: 'English', subtitleKind: 'manual', bodyMarkdown: 'Completed after disconnect.',
    };
    let uiCollection: Promise<Response> | null = null;
    try {
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      uiCollection = fetch(`${runtime.server.url}/api/youtube/collect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: captured.sourceUrl }),
      });
      await vi.waitFor(() => expect(collectCalls).toHaveBeenCalledTimes(2));
      expect(capture).toHaveBeenCalledOnce();
      await clientExited;
    } finally {
      release(captured);
    }
    expect((await uiCollection!).status).toBe(200);
    expect(capture).toHaveBeenCalledOnce();
    await vi.waitFor(async () => {
      const response = await fetch(`${connection.url}/api/documents`, { headers: { authorization: `Bearer ${connection.token}` } });
      expect((await response.json()).documents).toHaveLength(1);
    });

    expect((await fetch(`${runtime.server.url}/api/documents`)).status).toBe(200);
    await runtime.close();
    expect(runtime.status().state).toBe('stopped');
    expect(setup.closeSearch).toHaveBeenCalledOnce();
  });

  it('closes the workspace when a later listener fails to start', async () => {
    const setup = await options({ capture: vi.fn() });
    await expect(CollectorRuntime.start({ ...setup.value, uiPort: -1 })).rejects.toThrow();
    expect(setup.closeSearch).toHaveBeenCalledOnce();
  });

  it('wires Agent channel and schedule operations to the UI workspace', async () => {
    const setup = await options({ capture: vi.fn() });
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    const connection = JSON.parse(await readFile(setup.value.connectionFile, 'utf8')) as { url: string; token: string };
    const agent = async (route: string, init?: RequestInit) => fetch(`${connection.url}${route}`, {
      ...init,
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    const added = await agent('/api/youtube/channels', {
      method: 'POST', body: JSON.stringify({ url: 'https://www.youtube.com/@runtime' }),
    });
    expect(added.status).toBe(200);
    expect((await (await fetch(`${runtime.server.url}/api/youtube/channels`)).json()).channels).toMatchObject([
      { id: 'UC-runtime', enabled: true },
    ]);
    expect((await agent('/api/youtube/channels/UC-runtime', {
      method: 'PATCH', body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);
    expect((await agent('/api/youtube/schedule', {
      method: 'PUT', body: JSON.stringify({ enabled: false, intervalMinutes: 30 }),
    })).status).toBe(200);
    const run = await agent('/api/youtube/channel-runs', {
      method: 'POST', body: JSON.stringify({ channelIds: ['UC-runtime'] }),
    });
    expect(run.status).toBe(202);
    const runId = (await run.json()).run.id as string;
    await vi.waitFor(async () => {
      const current = await agent(`/api/youtube/channel-runs/${encodeURIComponent(runId)}`);
      expect((await current.json()).run.status).toBe('completed');
    });
    expect((await agent('/api/youtube/channels/UC-runtime', { method: 'DELETE' })).status).toBe(200);
    expect((await (await fetch(`${runtime.server.url}/api/youtube/channels`)).json()).channels).toEqual([]);
  });

  it('closes search when workspace schedule startup fails', async () => {
    const setup = await options({ capture: vi.fn() });
    const settings = path.join(setup.value.workspace.defaultRoot, 'settings');
    await mkdir(settings, { recursive: true });
    await writeFile(path.join(settings, 'youtube-schedule.json'), '{broken');
    await expect(CollectorRuntime.start(setup.value)).rejects.toThrow();
    expect(setup.closeSearch).toHaveBeenCalledOnce();
  });

  it('waits for an accepted rebuild after its Agent client disconnects', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rebuild = vi.fn(async () => held);
    const search: TranscriptSearch = {
      status: () => ({ state: 'ready', indexedDocuments: 0, message: '' }),
      search: async () => ({ hits: [], estimatedTotalHits: 0 }),
      index: async () => undefined,
      rebuild,
    };
    const setup = await options({ capture: vi.fn() }, search);
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    const connection = JSON.parse(await readFile(setup.value.connectionFile, 'utf8')) as { url: string; token: string };
    const client = spawn(process.execPath, ['-e', `
      const request = require('node:http').request(${JSON.stringify(`${connection.url}/api/search/rebuild`)}, {method:'POST', headers:{authorization:${JSON.stringify(`Bearer ${connection.token}`)}}});
      request.on('finish', () => setTimeout(() => process.exit(0), 10));
      request.end();
    `], { stdio: 'ignore' });
    const clientExited = new Promise<void>((resolve, reject) => {
      client.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`client exited ${code}`)));
      client.once('error', reject);
    });
    try {
      await vi.waitFor(() => expect(rebuild).toHaveBeenCalledOnce());
      await clientExited;
      let closed = false;
      const closing = runtime.close().then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      release();
      await closing;
      expect(runtime.status().state).toBe('stopped');
    } finally {
      release();
    }
  });
});
