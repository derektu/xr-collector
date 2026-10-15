import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedTranscript, TranscriptSearch } from '../../src/core/types.js';
import { CollectorRuntime, type CollectorRuntimeOptions } from '../../src/runtime/collector-runtime.js';
import { writeVaultMarker } from '../../src/vault/vault-directory.js';
import { UnavailableTranscriptSearch } from '../../src/search/managed-transcript-search.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function options(capture: CollectorRuntimeOptions['workspace']['capture'], search?: TranscriptSearch) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-runtime-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const closeSearch = vi.fn(async () => undefined);
  const vaultPath = path.join(root, 'vault');
  return {
    closeSearch,
    vaultPath,
    value: {
      profilePath: root,
      explicitVaultPath: vaultPath,
      workspace: {
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

    const connection = JSON.parse(await readFile(connectionFile, 'utf8')) as {
      schemaVersion: number; instanceId: string; url: string; token: string;
    };
    expect(connection.schemaVersion).toBe(1);
    expect(connection.instanceId).toBe(runtime.instanceId);
    expect((await fetch(`${connection.url}/api/health`)).status).toBe(401);
    expect((await fetch(`${connection.url}/api/health`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const agentHealth = await fetch(`${connection.url}/api/health`, { headers: { authorization: `Bearer ${connection.token}` } });
    expect(agentHealth.status).toBe(200);
    expect(await agentHealth.json()).toMatchObject({
      status: 'unavailable', runtime: { instanceId: connection.instanceId },
    });
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
    const { explicitVaultPath: _explicit, ...selected } = setup.value;
    await writeFile(path.join(setup.value.profilePath, 'vault-selection.json'), JSON.stringify({ path: setup.vaultPath }));
    const runtime = await CollectorRuntime.start(selected);
    cleanups.push(() => runtime.close());
    expect(runtime.status()).toMatchObject({
      state: 'not_ready', vaultPath: null,
      message: expect.stringContaining('找不到先前使用的知識庫目錄'),
    });
    expect(runtime.vaultStatus()).toMatchObject({ state: 'not_ready', failure: { path: setup.vaultPath } });
    const entries = await readdir(setup.value.profilePath);
    expect(entries).toContain('vault-selection.json');
    expect(entries).not.toContain('vault');
    expect(entries.some((entry) => entry.startsWith('search'))).toBe(false);
  });

  it('shares one workspace with UI and Agent and keeps accepted collection alive after client disconnect', async () => {
    let release!: (capture: CapturedTranscript) => void;
    const waiting = new Promise<CapturedTranscript>((resolve) => { release = resolve; });
    const capture = vi.fn(async () => waiting);
    const setup = await options({ capture });
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    expect(runtime.status()).toMatchObject({ state: 'ready', profilePath: setup.value.profilePath, vaultPath: setup.vaultPath });

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
    let jobId: string;
    try {
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      await clientExited;
      // The UI submission of the same video joins the Agent's job instead of capturing again.
      const ui = await fetch(`${runtime.server.url}/api/youtube/collect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: captured.sourceUrl }),
      });
      expect(ui.status).toBe(202);
      const accepted = await ui.json() as { job: { id: string; state: string }; deduplicated: boolean };
      expect(accepted).toMatchObject({ deduplicated: true, job: { state: 'running' } });
      jobId = accepted.job.id;
    } finally {
      release(captured);
    }
    await vi.waitFor(async () => {
      const response = await fetch(`${connection.url}/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${connection.token}` } });
      expect((await response.json()).job).toMatchObject({ state: 'completed', result: { outcome: 'created', saved: true } });
    });
    expect(capture).toHaveBeenCalledOnce();
    const documents = await fetch(`${connection.url}/api/documents`, { headers: { authorization: `Bearer ${connection.token}` } });
    expect((await documents.json()).documents).toHaveLength(1);

    expect((await fetch(`${runtime.server.url}/api/documents`)).status).toBe(200);
    await runtime.close();
    expect(runtime.status().state).toBe('stopped');
    expect(setup.closeSearch).toHaveBeenCalledOnce();
  });

  it('waits for running captures on close and shows queued work as interrupted after restart', async () => {
    const releases: Array<() => void> = [];
    const capture = vi.fn(async (video: { videoId: string; canonicalUrl: string }) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        videoId: video.videoId, sourceUrl: video.canonicalUrl, title: `Video ${video.videoId}`, channelId: null,
        channelTitle: 'Runtime', publishedAt: null, languageCode: 'en', languageName: 'English',
        subtitleKind: 'manual' as const, bodyMarkdown: 'Body.',
      };
    });
    const setup = await options({ capture });
    const first = await CollectorRuntime.start(setup.value);
    const submit = async (id: string) => (await (await fetch(`${first.server.url}/api/youtube/submissions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}` }),
    })).json()).job.id as string;
    const ids = [await submit('restart0001'), await submit('restart0002'), await submit('restart0003')];
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));

    const closing = first.close();
    for (const release of releases) release();
    await closing;
    expect(capture).toHaveBeenCalledTimes(2);

    const second = await CollectorRuntime.start(setup.value);
    cleanups.push(() => second.close());
    const page = await (await fetch(`${second.server.url}/api/jobs?state=all`)).json() as { jobs: Array<{ id: string; state: string }> };
    expect(Object.fromEntries(page.jobs.map((job) => [job.id, job.state]))).toEqual({
      [ids[0]!]: 'completed', [ids[1]!]: 'completed', [ids[2]!]: 'interrupted',
    });
    expect((await (await fetch(`${second.server.url}/api/documents`)).json()).documents).toHaveLength(2);
    const events = await readFile(path.join(setup.value.profilePath, 'jobs', 'events.jsonl'), 'utf8');
    expect(events).toContain('"eventType":"job.interrupted"');
  });

  it('closes the workspace when a later listener fails to start', async () => {
    const setup = await options({ capture: vi.fn() });
    await expect(CollectorRuntime.start({ ...setup.value, uiPort: -1 })).rejects.toThrow();
    expect(setup.closeSearch).toHaveBeenCalledOnce();
  });

  it('publishes a new authenticated runtime identity when the same profile restarts', async () => {
    const setup = await options({ capture: vi.fn() });
    const first = await CollectorRuntime.start(setup.value);
    const firstConnection = JSON.parse(await readFile(setup.value.connectionFile, 'utf8')) as {
      schemaVersion: number; instanceId: string; url: string; token: string;
    };
    await first.close();

    const second = await CollectorRuntime.start(setup.value);
    cleanups.push(() => second.close());
    const secondConnection = JSON.parse(await readFile(setup.value.connectionFile, 'utf8')) as typeof firstConnection;
    expect(secondConnection).toMatchObject({ schemaVersion: 1, instanceId: second.instanceId });
    expect(secondConnection.instanceId).not.toBe(firstConnection.instanceId);
    expect(secondConnection.token).not.toBe(firstConnection.token);

    const health = await fetch(`${secondConnection.url}/api/health`, {
      headers: { authorization: `Bearer ${secondConnection.token}` },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ runtime: { instanceId: secondConnection.instanceId } });
    expect((await fetch(`${secondConnection.url}/api/health`, {
      headers: { authorization: `Bearer ${firstConnection.token}` },
    })).status).toBe(401);
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
    expect(added.status).toBe(202);
    const addJob = (await added.json()).job.id as string;
    await vi.waitFor(async () => {
      expect((await (await agent(`/api/jobs/${addJob}`)).json()).job).toMatchObject({ state: 'completed', result: { channelId: 'UC-runtime' } });
    });
    // Adding a channel starts its first collection job; the channel reads 'tracking' once that job settles.
    const uiChannels = await vi.waitFor(async () => {
      const channels = (await (await fetch(`${runtime.server.url}/api/youtube/channels`)).json()).channels;
      expect(channels).toMatchObject([{ id: 'UC-runtime', enabled: true, status: 'tracking', documentCount: 0 }]);
      return channels;
    });
    // The Agent reads the same subscriptions and previews through the same service.
    expect((await (await agent('/api/youtube/channels')).json()).channels).toEqual(uiChannels);
    const preview = await agent('/api/youtube/channel-previews', { method: 'POST', body: JSON.stringify({ url: '@runtime' }) });
    expect((await preview.json()).preview).toMatchObject({
      channel: { id: 'UC-runtime' }, subscription: { enabled: true }, policy: { enabled: true, intervalMinutes: 30, backfillWindow: '1m', backfillMaxItems: 10 },
    });
    expect((await agent('/api/youtube/channels/UC-runtime', {
      method: 'PATCH', body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);
    expect((await agent('/api/youtube/schedule', {
      method: 'PUT', body: JSON.stringify({ enabled: false, intervalMinutes: 30 }),
    })).status).toBe(200);
    const pausedRun = await agent('/api/youtube/channel-runs', {
      method: 'POST', body: JSON.stringify({ channelIds: ['UC-runtime'] }),
    });
    expect(pausedRun.status).toBe(409);
    expect((await pausedRun.json()).error.code).toBe('channel_paused');
    const resumed = await agent('/api/youtube/channels/UC-runtime', {
      method: 'PATCH', body: JSON.stringify({ enabled: true }),
    });
    expect(resumed.status).toBe(200);
    const runId = (await resumed.json()).submission.job.id as string;
    await vi.waitFor(async () => {
      const current = await agent(`/api/jobs/${encodeURIComponent(runId)}`);
      expect((await current.json()).job).toMatchObject({ state: 'completed', result: { outcome: 'empty' } });
    });
    expect((await agent('/api/youtube/channels/UC-runtime', { method: 'DELETE' })).status).toBe(200);
    expect((await (await fetch(`${runtime.server.url}/api/youtube/channels`)).json()).channels).toEqual([]);
  });

  it('closes search when workspace schedule startup fails', async () => {
    const setup = await options({ capture: vi.fn() });
    const settings = path.join(setup.vaultPath, 'settings');
    await mkdir(settings, { recursive: true });
    await writeVaultMarker(setup.vaultPath, 'XR Collector test');
    await writeFile(path.join(settings, 'youtube-schedule.json'), '[]');
    await expect(CollectorRuntime.start(setup.value)).rejects.toThrow();
    expect(setup.closeSearch).toHaveBeenCalledOnce();
  });

  it('waits for an accepted rebuild after its Agent client disconnects', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rebuild = vi.fn(async () => held);
    const search: TranscriptSearch = {
      status: () => ({ state: 'ready', indexedDocuments: 0, lastRebuiltAt: null, message: '' }),
      search: async () => ({ hits: [], total: 0, offset: 0, limit: 50 }),
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

describe('CollectorRuntime Vault setup', () => {
  async function selected(capture = vi.fn()) {
    const setup = await options({ capture });
    const { explicitVaultPath: _explicit, ...value } = setup.value;
    return { ...setup, value, suggested: path.join(setup.value.profilePath, 'Suggested') };
  }
  async function agentClient(connectionFile: string) {
    const connection = JSON.parse(await readFile(connectionFile, 'utf8')) as { url: string; token: string };
    return (route: string, body?: unknown) => fetch(`${connection.url}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('lets an Agent create a Vault while Not Ready, serves the UI immediately and reopens it after restart', async () => {
    const setup = await selected();
    const runtime = await CollectorRuntime.start({ ...setup.value, suggestedVaultPath: setup.suggested });
    const agent = await agentClient(setup.value.connectionFile);
    expect((await (await agent('/api/vault/setup')).json()).vault).toEqual({
      state: 'not_ready', vaultPath: null, suggestedPath: setup.suggested, failure: null,
    });
    expect((await fetch(`${runtime.server.url}/api/documents`)).status).toBe(503);
    expect((await fetch(`${new URL(runtime.agentAccess.info.url)}api/vault/setup`, { method: 'POST' })).status).toBe(401);

    expect((await (await agent('/api/vault/inspect', { path: setup.vaultPath })).json()).inspection)
      .toEqual({ kind: 'empty', path: setup.vaultPath, exists: false });
    const created = await agent('/api/vault/setup', { action: 'create', path: setup.vaultPath });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      vault: { state: 'ready', vaultPath: setup.vaultPath, suggestedPath: setup.suggested, failure: null }, documentCount: 0,
    });
    expect(runtime.status()).toMatchObject({ state: 'ready', vaultPath: setup.vaultPath });
    expect((await fetch(`${runtime.server.url}/api/documents`)).status).toBe(200);
    expect((await fetch(`${runtime.server.url}/api/vault/setup`)).status).toBe(200);
    const again = await fetch(`${runtime.server.url}/api/vault/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'open', path: setup.vaultPath }),
    });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('vault_already_set');
    expect(JSON.parse(await readFile(path.join(setup.value.profilePath, 'vault-selection.json'), 'utf8'))).toEqual({ path: setup.vaultPath });

    const added = await fetch(`${runtime.server.url}/api/youtube/channels`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/@runtime' }),
    });
    expect(added.status).toBe(202);
    const addJob = (await added.json()).job.id as string;
    await vi.waitFor(async () => {
      expect((await (await fetch(`${runtime.server.url}/api/jobs/${addJob}`)).json()).job.state).toBe('completed');
    });
    await runtime.close();

    const restarted = await CollectorRuntime.start(setup.value);
    cleanups.push(() => restarted.close());
    expect(restarted.status()).toMatchObject({ state: 'ready', vaultPath: setup.vaultPath });
    expect((await (await fetch(`${restarted.server.url}/api/youtube/channels`)).json()).channels).toMatchObject([{ id: 'UC-runtime' }]);
  });

  it('opens only valid Vaults and leaves rejected directories untouched', async () => {
    const setup = await selected();
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    const ui = (body: unknown) => fetch(`${runtime.server.url}/api/vault/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const other = path.join(setup.value.profilePath, 'other');
    await mkdir(other);
    await writeFile(path.join(other, 'notes.txt'), 'keep');
    for (const body of [{ action: 'open', path: other }, { action: 'create', path: other }, { action: 'open', path: setup.vaultPath }]) {
      const response = await ui(body);
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe('vault_invalid');
    }
    expect((await ui({ action: 'open', path: 'relative' })).status).toBe(400);
    expect((await ui({ action: 'move', path: other })).status).toBe(400);
    expect(await readdir(other)).toEqual(['notes.txt']);
    await expect(readdir(setup.vaultPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(setup.value.profilePath, 'vault-selection.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runtime.status().state).toBe('not_ready');

    const existing = path.join(setup.value.profilePath, 'existing');
    await mkdir(path.join(existing, 'documents', 'youtube'), { recursive: true });
    await writeVaultMarker(existing, 'XR Collector test');
    await writeFile(path.join(existing, 'documents', 'youtube', 'video.md'), '---\n---\n');
    const opened = await ui({ action: 'open', path: existing });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ vault: { state: 'ready', vaultPath: existing }, documentCount: 1 });
  });

  it('recovers from an unavailable selection by choosing another Vault', async () => {
    const setup = await selected();
    await writeFile(path.join(setup.value.profilePath, 'vault-selection.json'), JSON.stringify({ path: setup.vaultPath }));
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    expect((await (await fetch(`${runtime.server.url}/api/vault/setup`)).json()).vault).toMatchObject({
      state: 'not_ready', failure: { path: setup.vaultPath, reason: expect.stringContaining('找不到') },
    });
    const replacement = path.join(setup.value.profilePath, 'replacement');
    const created = await fetch(`${runtime.server.url}/api/vault/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', path: replacement }),
    });
    expect(created.status).toBe(200);
    expect((await created.json()).vault).toMatchObject({ state: 'ready', vaultPath: replacement, failure: null });
    expect(JSON.parse(await readFile(path.join(setup.value.profilePath, 'vault-selection.json'), 'utf8'))).toEqual({ path: replacement });
    await expect(readdir(setup.vaultPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a damaged selection file or Vault as Not Ready', async () => {
    const setup = await selected();
    await writeFile(path.join(setup.value.profilePath, 'vault-selection.json'), '{');
    const damagedSelection = await CollectorRuntime.start(setup.value);
    expect(damagedSelection.vaultStatus()).toMatchObject({ state: 'not_ready', failure: { reason: expect.stringContaining('損壞') } });
    await damagedSelection.close();

    await mkdir(path.join(setup.vaultPath, 'settings'), { recursive: true });
    await writeVaultMarker(setup.vaultPath, 'XR Collector test');
    await writeFile(path.join(setup.vaultPath, 'settings', 'youtube-channels.json'), '{');
    await writeFile(path.join(setup.value.profilePath, 'vault-selection.json'), JSON.stringify({ path: setup.vaultPath }));
    const damagedVault = await CollectorRuntime.start(setup.value);
    cleanups.push(() => damagedVault.close());
    expect(damagedVault.vaultStatus()).toMatchObject({ state: 'not_ready', failure: { path: setup.vaultPath, reason: expect.stringContaining('格式錯誤') } });
    expect(setup.closeSearch).not.toHaveBeenCalled();
  });

  it('creates an explicit empty Vault but never adopts unrecognized content', async () => {
    const setup = await options({ capture: vi.fn() });
    const runtime = await CollectorRuntime.start(setup.value);
    expect(runtime.status()).toMatchObject({ state: 'ready', vaultPath: setup.vaultPath });
    expect(await readdir(setup.vaultPath)).toContain('xr-collector-vault.json');
    await runtime.close();

    const unrecognized = path.join(setup.value.profilePath, 'unrecognized');
    await mkdir(path.join(unrecognized, 'documents'), { recursive: true });
    const refused = await CollectorRuntime.start({ ...setup.value, explicitVaultPath: unrecognized });
    cleanups.push(() => refused.close());
    expect(refused.status()).toMatchObject({ state: 'not_ready', message: expect.stringContaining('無法辨識') });
    expect(await readdir(unrecognized)).toEqual(['documents']);
  });
});
