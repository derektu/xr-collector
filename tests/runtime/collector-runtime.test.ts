import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSearch } from '../../src/core/types.js';
import { CollectorRuntime, type CollectorRuntimeOptions } from '../../src/runtime/collector-runtime.js';
import { writeVaultMarker } from '../../src/vault/vault-directory.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { importNewVault } from '../../src/vault/vault-import.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { JsonScheduleStore } from '../../src/subscriptions/schedule-store.js';
import { manifestOf, packageBytes, zipEntries } from '../vault/package-fixtures.js';
import { UnavailableTranscriptSearch } from '../../src/search/managed-transcript-search.js';
import { readEventFiles } from '../activity/event-files.js';
import type { CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { withYouTube, type YouTubeTestSources } from '../support/youtube-sources.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const runtimeChannel = { id: 'UC-runtime', title: 'Runtime', url: 'https://www.youtube.com/channel/UC-runtime' };

async function connectionOf(runtime: CollectorRuntime): Promise<{ url: string; token: string }> {
  const response = await fetch(`${runtime.server.url}/api/device/agent/connection`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { connection: { url: string; token: string } }).connection;
}

async function options(
  capture: NonNullable<YouTubeTestSources['capture']>,
  search?: TranscriptSearch,
  resolve: (url: string) => Promise<typeof runtimeChannel> = async () => runtimeChannel,
) {
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
      workspace: withYouTube({
        capture,
        channelSource: {
          resolve,
          listVideos: async () => [],
        },
        searchBinary: 'unused', searchData: path.join(root, 'search'), exportFolder: path.join(root, 'exports'), backupFolder: path.join(root, 'backups'),
        createSearch: async () => ({ search: search ?? new UnavailableTranscriptSearch('test'), close: closeSearch }),
      }),
      agentSettingsFile: path.join(root, 'agent-settings.json'),
      skillPath: path.resolve('skills/xr-collector-agent'),
      uiPort: 0,
    } satisfies CollectorRuntimeOptions,
  };
}

describe('CollectorRuntime', () => {
  it('serves authenticated Not Ready status without creating Vault services', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-runtime-not-ready-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const agentSettingsFile = path.join(root, 'agent-settings.json');
    let loginEnabled = false;
    const loginStartup = {
      status: async () => ({ supported: true, enabled: loginEnabled, state: loginEnabled ? 'enabled' as const : 'disabled' as const, message: 'test' }),
      update: async (enabled: boolean) => { loginEnabled = enabled; return loginStartup.status(); },
    };
    const runtime = await CollectorRuntime.start({
      profilePath: root, workspace: null, agentSettingsFile,
      skillPath: path.resolve('skills/xr-collector-agent'), uiPort: 0, loginStartup,
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
    expect((await fetch(`${runtime.server.url}/api/device/agent/connection`)).status).toBe(200);
    // Pacing reads without a Vault; no source type has loaded yet, so there is no request channel.
    const pacing = await fetch(`${runtime.server.url}/api/pacing`);
    expect(pacing.status).toBe(200);
    expect(await pacing.json()).toEqual({ groups: [] });

    const connection = await connectionOf(runtime);
    expect((await fetch(`${connection.url}/api/health`)).status).toBe(401);
    expect((await fetch(`${connection.url}/api/health`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const agentHealth = await fetch(`${connection.url}/api/health`, { headers: { authorization: `Bearer ${connection.token}` } });
    expect(agentHealth.status).toBe(200);
    expect(await agentHealth.json()).toMatchObject({
      status: 'unavailable', runtime: { instanceId: runtime.instanceId },
    });
    const uiLogin = await fetch(`${runtime.server.url}/api/device/login-startup`);
    expect(await uiLogin.json()).toMatchObject({ loginStartup: { enabled: false, state: 'disabled' } });
    const agentLogin = await fetch(`${connection.url}/api/device/login-startup`, {
      method: 'PUT', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(await agentLogin.json()).toMatchObject({ loginStartup: { enabled: true, state: 'enabled' } });
    expect(await (await fetch(`${runtime.server.url}/api/device/login-startup`)).json()).toMatchObject({ loginStartup: { enabled: true } });
    const blocked = await fetch(`${connection.url}/api/items`, {
      method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=runtime0001' }),
    });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ error: { code: 'vault_not_ready', message: expect.stringContaining('Onboarding') } });
    expect(await readdir(root)).toEqual(['agent-settings.json']);
  });

  it('acquires and releases the device update exclusion without a Vault', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-runtime-update-no-vault-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const runtime = await CollectorRuntime.start({ profilePath: root, workspace: null,
      agentSettingsFile: path.join(root, 'agent-settings.json'), skillPath: path.resolve('skills/xr-collector-agent'), uiPort: 0 });
    cleanups.push(() => runtime.close());
    const lease = await runtime.prepareUpdate(new AbortController().signal);
    await expect(runtime.prepareUpdate(new AbortController().signal)).rejects.toMatchObject({ code: 'update_busy' });
    lease.cancel();
    const next = await runtime.prepareUpdate(new AbortController().signal);
    next.cancel();
  });

  it('refuses update preparation while Onboarding is setting up a Vault', async () => {
    const setup = await options({ capture: vi.fn() });
    const { explicitVaultPath: _explicit, ...notReady } = setup.value;
    const originalCreateSearch = notReady.workspace!.createSearch!;
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const runtime = await CollectorRuntime.start({ ...notReady, workspace: { ...notReady.workspace!,
      createSearch: async (root) => { entered(); await held; return originalCreateSearch(root); },
    } });
    cleanups.push(() => runtime.close());
    const settingUp = fetch(`${runtime.server.url}/api/vault/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', path: setup.vaultPath }),
    });
    await started;
    await expect(runtime.prepareUpdate(new AbortController().signal)).rejects.toMatchObject({ code: 'vault_busy' });
    release(); expect((await settingUp).status).toBe(200);
  });

  it('refuses update preparation while a Vault move or import owns the operation lock', async () => {
    const base = await options({ capture: vi.fn() }); const { explicitVaultPath: _explicit, ...value } = base.value;
    await writeVaultMarker(await mkdir(base.vaultPath, { recursive: true }).then(() => base.vaultPath), 'XR Collector test');
    await writeFile(path.join(value.profilePath, 'vault-selection.json'), JSON.stringify({ path: base.vaultPath }));
    let entered!: () => void; const moving = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    let importEntered!: () => void; const importing = new Promise<void>((resolve) => { importEntered = resolve; });
    let releaseImport!: () => void; const importHeld = new Promise<void>((resolve) => { releaseImport = resolve; });
    const runtime = await CollectorRuntime.start({ ...value, workspace: { ...value.workspace!,
      moveFaults: async (phase) => { if (phase === 'copying') { entered(); await held; } },
      importFaults: async (phase) => { if (phase === 'staged') { importEntered(); await importHeld; } },
    } });
    cleanups.push(() => runtime.close());
    const target = path.join(value.profilePath, '..', `${path.basename(value.profilePath)}-update-move`);
    cleanups.push(() => rm(target, { recursive: true, force: true }));
    await runtime.workspace!.move(target); await moving;
    await expect(runtime.prepareUpdate(new AbortController().signal)).rejects.toMatchObject({ code: 'vault_busy' });
    release(); await runtime.workspace!.operationFinished();

    const source = path.join(value.profilePath, 'incoming-vault');
    await new MarkdownVault(source).add(transcriptDocument({
      videoId: 'updatehold1', sourceUrl: 'https://www.youtube.com/watch?v=updatehold1', title: 'Import hold',
      channelId: 'UC-runtime', channelTitle: 'Runtime', publishedAt: null, languageCode: 'en', languageName: 'English',
      subtitleKind: 'manual', bodyMarkdown: 'Imported while update waits.',
    }));
    await new JsonScheduleStore(source).save({ enabled: true });
    const packageFile = path.join(value.profilePath, 'incoming.zip'); await writeFile(packageFile, await packageBytes(source));
    const preview = await runtime.workspace!.previewImport(packageFile);
    runtime.workspace!.applyImport(preview.id, 'merge'); await importing;
    await expect(runtime.prepareUpdate(new AbortController().signal)).rejects.toMatchObject({ code: 'vault_busy' });
    releaseImport(); await runtime.workspace!.operationFinished();
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

  it('records login launch and setting changes as device-wide activity', async () => {
    const setup = await options({ capture: vi.fn() });
    let enabled = false;
    const loginStartup = {
      status: async () => ({ supported: true, enabled, state: enabled ? 'enabled' as const : 'disabled' as const, message: 'test' }),
      update: async (next: boolean) => { enabled = next; return loginStartup.status(); },
    };
    const runtime = await CollectorRuntime.start({ ...setup.value, loginStartup, startedAtLogin: true });
    cleanups.push(() => runtime.close());
    const changed = await fetch(`${runtime.server.url}/api/device/login-startup`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    expect(changed.status).toBe(200);
    await vi.waitFor(async () => {
      const activity = await (await fetch(`${runtime.server.url}/api/activity?limit=20`)).json() as { events: Array<{ eventType: string; vaultPath: string | null; jobId: string | null }> };
      const deviceEvents = activity.events.filter((event) => event.eventType.startsWith('device.login_startup'));
      expect(deviceEvents.map((event) => event.eventType)).toEqual(expect.arrayContaining([
        'device.login_startup_launched', 'device.login_startup_enabled',
      ]));
      expect(deviceEvents.every((event) => event.vaultPath === null && event.jobId === null)).toBe(true);
    });
  });

  it('shares one workspace with UI and Agent and keeps accepted collection alive after client disconnect', async () => {
    let release!: (capture: CapturedTranscript) => void;
    const waiting = new Promise<CapturedTranscript>((resolve) => { release = resolve; });
    const capture = vi.fn(async () => waiting);
    const setup = await options({ capture });
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    expect(runtime.status()).toMatchObject({ state: 'ready', profilePath: setup.value.profilePath, vaultPath: setup.vaultPath });

    const connection = await connectionOf(runtime);
    const client = spawn(process.execPath, ['-e', `
      const target = new URL(${JSON.stringify(`${connection.url}/api/items`)});
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
      const ui = await fetch(`${runtime.server.url}/api/items`, {
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

  it('waits for running captures on close and resumes queued work after restart', async () => {
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
    const submit = async (id: string) => (await (await fetch(`${first.server.url}/api/submissions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}` }),
    })).json()).job.id as string;
    const ids = [await submit('restart0001'), await submit('restart0002'), await submit('restart0003')];
    // One capture runs at a time; the other two wait in the queue.
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));

    const closing = first.close();
    for (const release of releases.splice(0)) release();
    await closing;
    expect(capture).toHaveBeenCalledTimes(1);

    const second = await CollectorRuntime.start(setup.value);
    cleanups.push(() => second.close());
    await vi.waitFor(async () => {
      for (const release of releases.splice(0)) release();
      expect(capture).toHaveBeenCalledTimes(3);
      const page = await (await fetch(`${second.server.url}/api/jobs?state=all`)).json() as { jobs: Array<{ id: string; state: string }> };
      expect(Object.fromEntries(page.jobs.map((job) => [job.id, job.state]))).toEqual({
        [ids[0]!]: 'completed', [ids[1]!]: 'completed', [ids[2]!]: 'completed',
      });
    });
    const resumed = (await (await fetch(`${second.server.url}/api/jobs/${ids[2]!}`)).json()).job;
    expect(resumed).toMatchObject({ result: { outcome: 'created' }, recovery: { resumedCount: 1, uncleanStops: 0 } });
    expect(resumed).not.toHaveProperty('checkpoint');
    expect((await (await fetch(`${second.server.url}/api/documents`)).json()).documents).toHaveLength(3);
    await vi.waitFor(async () => {
      const events = (await readEventFiles(path.join(setup.value.profilePath, 'jobs')))
        .filter((event) => event.jobId === ids[2]).map((event) => event.eventType);
      expect(events.indexOf('job.interrupted')).toBeLessThan(events.indexOf('job.resumed'));
      expect(events.at(-1)).toBe('job.completed');
    });
  });

  it('resumes the work of a killed process without capturing saved videos again', async () => {
    const profile = await mkdtemp(path.join(tmpdir(), 'xr-runtime-kill-'));
    cleanups.push(() => rm(profile, { recursive: true, force: true }));
    const vaultPath = path.join(profile, 'vault');
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/runtime/fixtures/killed-runtime.ts'), profile, vaultPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('holding')) resolve();
      });
      child.once('exit', (code) => reject(new Error(`fixture exited ${code}: ${output}`)));
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const [savedJob, heldJob] = JSON.parse(output.split('\n').find((line) => line.startsWith('jobs '))!.slice(5)) as [string, string];

    const capture = vi.fn(async (video: { videoId: string; canonicalUrl: string }) => ({
      videoId: video.videoId, sourceUrl: video.canonicalUrl, title: `Video ${video.videoId}`, channelId: null,
      channelTitle: 'Runtime', publishedAt: null, languageCode: 'en', languageName: 'English',
      subtitleKind: 'manual' as const, bodyMarkdown: 'Body.',
    }));
    const setup = await options({ capture });
    const runtime = await CollectorRuntime.start({ ...setup.value, profilePath: profile, explicitVaultPath: vaultPath });
    cleanups.push(() => runtime.close());
    await vi.waitFor(async () => {
      const job = (await (await fetch(`${runtime.server.url}/api/jobs/${heldJob}`)).json()).job;
      expect(job).toMatchObject({ state: 'completed', result: { outcome: 'created' }, recovery: { resumedCount: 1, uncleanStops: 1 } });
    });
    expect((await (await fetch(`${runtime.server.url}/api/jobs/${savedJob}`)).json()).job).toMatchObject({ state: 'completed' });
    expect(capture.mock.calls.map(([video]) => video.videoId)).toEqual(['killheld001']);
    expect((await (await fetch(`${runtime.server.url}/api/documents`)).json()).documents).toHaveLength(2);
  });

  it('closes the workspace when a later listener fails to start', async () => {
    const setup = await options({ capture: vi.fn() });
    await expect(CollectorRuntime.start({ ...setup.value, uiPort: -1 })).rejects.toThrow();
    expect(setup.closeSearch).toHaveBeenCalledOnce();
  });

  it('keeps its private Agent credential when the same profile restarts', async () => {
    const setup = await options({ capture: vi.fn() });
    const first = await CollectorRuntime.start(setup.value);
    const firstConnection = await connectionOf(first);
    await first.close();

    const second = await CollectorRuntime.start(setup.value);
    cleanups.push(() => second.close());
    const secondConnection = await connectionOf(second);
    expect(secondConnection.token).toBe(firstConnection.token);

    const health = await fetch(`${secondConnection.url}/api/health`, {
      headers: { authorization: `Bearer ${secondConnection.token}` },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ runtime: { instanceId: second.instanceId } });
    expect((await fetch(`${secondConnection.url}/api/health`, {
      headers: { authorization: `Bearer ${firstConnection.token}` },
    })).status).toBe(200);
  });

  it('adds a previewed channel with the target its preview resolved, and resolves an address nobody previewed', async () => {
    const resolve = vi.fn(async () => runtimeChannel);
    const setup = await options({ capture: vi.fn() }, undefined, resolve);
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    const post = (route: string, body: unknown) => fetch(`${runtime.server.url}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const addAndWait = async (url: string) => {
      const job = (await (await post('/api/subscriptions', { url })).json()).job.id as string;
      await vi.waitFor(async () => {
        expect((await (await fetch(`${runtime.server.url}/api/jobs/${job}`)).json()).job.state).toBe('completed');
      });
    };

    // The UI and the Agent subscribe with the address the preview returned.
    const preview = (await (await post('/api/subscription-previews', { url: '@runtime' })).json()).preview;
    await addAndWait(preview.target.url);
    expect(resolve).toHaveBeenCalledTimes(1);

    await addAndWait('https://www.youtube.com/@another');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('names a previewed channel from acceptance while it waits behind another subscription request', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const other = { id: 'UC-other', title: 'Other', url: 'https://www.youtube.com/channel/UC-other' };
    const resolve = vi.fn(async (url: string) => {
      if (!url.includes('@other')) return runtimeChannel;
      await held;
      return other;
    });
    const setup = await options({ capture: vi.fn() }, undefined, resolve);
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(async () => { release(); await runtime.close(); });
    const post = (route: string, body: unknown) => fetch(`${runtime.server.url}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const preview = (await (await post('/api/subscription-previews', { url: '@runtime' })).json()).preview;
    // A request nobody previewed resolves in the single discovery slot, so the previewed one waits in the queue.
    const blocking = (await (await post('/api/subscriptions', { url: 'https://www.youtube.com/@other' })).json()).job.id as string;
    await vi.waitFor(async () => {
      expect((await (await fetch(`${runtime.server.url}/api/jobs/${blocking}`)).json()).job.state).toBe('running');
    });
    const accepted = await post('/api/subscriptions', { url: preview.target.url });
    expect(accepted.status).toBe(202);
    const job = (await accepted.json()).job;
    expect(job).toMatchObject({ state: 'queued', source: { title: 'Runtime' } });
    const { overview } = await (await fetch(`${runtime.server.url}/api/jobs/overview`)).json();
    expect(overview.running).toEqual([expect.objectContaining({ jobId: blocking, title: null })]);
    expect(overview.queued).toEqual([expect.objectContaining({ jobId: job.id, role: 'add', title: 'Runtime' })]);
    // The stored event names the channel itself, not only once the log reads it next to the job.
    await vi.waitFor(async () => {
      const events = await readEventFiles(path.join(setup.value.profilePath, 'jobs'));
      expect(events.find((event) => event.jobId === job.id && event.eventType === 'job.accepted')).toMatchObject({ sourceTitle: 'Runtime' });
    });

    release();
    await vi.waitFor(async () => {
      expect((await (await fetch(`${runtime.server.url}/api/jobs/${job.id}`)).json()).job).toMatchObject({
        state: 'completed', result: { subscriptionId: 'UC-runtime' },
      });
    });
    expect(resolve.mock.calls.map(([url]) => url)).toEqual(['https://www.youtube.com/@runtime', 'https://www.youtube.com/@other']);
  });

  it('wires Agent channel and schedule operations to the UI workspace', async () => {
    const setup = await options({ capture: vi.fn() });
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    const connection = await connectionOf(runtime);
    const agent = async (route: string, init?: RequestInit) => fetch(`${connection.url}${route}`, {
      ...init,
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    const added = await agent('/api/subscriptions', {
      method: 'POST', body: JSON.stringify({ url: 'https://www.youtube.com/@runtime' }),
    });
    expect(added.status).toBe(202);
    const addJob = (await added.json()).job.id as string;
    await vi.waitFor(async () => {
      expect((await (await agent(`/api/jobs/${addJob}`)).json()).job).toMatchObject({ state: 'completed', result: { subscriptionId: 'UC-runtime' } });
    });
    // Adding a channel starts its first collection job. Wait for that check to record its end and
    // leave the job board before comparing complete UI and Agent snapshots.
    const uiChannels = await vi.waitFor(async () => {
      const channels = (await (await fetch(`${runtime.server.url}/api/subscriptions?type=youtube`)).json()).subscriptions;
      expect(channels).toMatchObject([{
        id: 'UC-runtime', enabled: true, status: 'tracking', documentCount: 0, lastCheckedAt: expect.any(String),
      }]);
      expect((await (await fetch(`${runtime.server.url}/api/jobs/overview`)).json()).overview).toMatchObject({
        running: [], queued: [],
      });
      return channels;
    });
    // The Agent reads the same subscriptions and previews through the same service.
    expect((await (await agent('/api/subscriptions?type=youtube')).json()).subscriptions).toEqual(uiChannels);
    const preview = await agent('/api/subscription-previews', { method: 'POST', body: JSON.stringify({ url: '@runtime' }) });
    expect((await preview.json()).preview).toMatchObject({
      type: 'youtube', target: { id: 'UC-runtime' }, subscription: { enabled: true, settings: { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 } },
      settings: { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 }, autoCollection: true,
    });
    expect((await agent('/api/subscriptions/youtube/UC-runtime', {
      method: 'PATCH', body: JSON.stringify({ settings: { intervalMinutes: 60 } }),
    })).status).toBe(200);
    expect((await (await fetch(`${runtime.server.url}/api/subscriptions?type=youtube`)).json()).subscriptions[0].settings).toEqual({
      intervalMinutes: 60, backfillDays: 30, backfillMaxItems: 10,
    });
    expect((await agent('/api/subscriptions/youtube/UC-runtime', {
      method: 'PATCH', body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);
    expect((await agent('/api/schedule', {
      method: 'PUT', body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);
    expect((await (await fetch(`${runtime.server.url}/api/schedule`)).json()).schedule).toMatchObject({ enabled: false, nextCheck: null });
    const pausedRun = await agent('/api/subscription-checks', {
      method: 'POST', body: JSON.stringify({ subscriptions: [{ type: 'youtube', id: 'UC-runtime' }] }),
    });
    expect(pausedRun.status).toBe(409);
    expect((await pausedRun.json()).error.code).toBe('subscription_paused');
    const resumed = await agent('/api/subscriptions/youtube/UC-runtime', {
      method: 'PATCH', body: JSON.stringify({ enabled: true }),
    });
    expect(resumed.status).toBe(200);
    const runId = (await resumed.json()).submission.job.id as string;
    await vi.waitFor(async () => {
      const current = await agent(`/api/jobs/${encodeURIComponent(runId)}`);
      expect((await current.json()).job).toMatchObject({ state: 'completed', result: { outcome: 'empty' } });
    });
    expect((await agent('/api/subscriptions/youtube/UC-runtime', { method: 'DELETE' })).status).toBe(200);
    expect((await (await fetch(`${runtime.server.url}/api/subscriptions?type=youtube`)).json()).subscriptions).toEqual([]);
  });

  it('closes search when workspace schedule startup fails', async () => {
    const setup = await options({ capture: vi.fn() });
    const settings = path.join(setup.vaultPath, 'settings');
    await mkdir(settings, { recursive: true });
    await writeVaultMarker(setup.vaultPath, 'XR Collector test');
    // The Vault passes inspection; its schedule file goes bad once search has started, so the scheduler fails to load it.
    const createSearch = setup.value.workspace.createSearch;
    setup.value.workspace.createSearch = async (root) => {
      await writeFile(path.join(settings, 'youtube-schedule.json'), JSON.stringify({ version: 2, enabled: 'bad' }));
      return createSearch(root);
    };
    await expect(CollectorRuntime.start(setup.value)).rejects.toThrow();
    expect(setup.closeSearch).toHaveBeenCalledOnce();
  });

  it('keeps an accepted rebuild running after its Agent disconnects and its key is reset', async () => {
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
    const connection = await connectionOf(runtime);
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
      const reset = await fetch(`${runtime.server.url}/api/device/agent/key/reset`, { method: 'POST' });
      expect(reset.status).toBe(200);
      const next = (await reset.json()).connection as { url: string; token: string };
      expect(next.token).not.toBe(connection.token);
      expect((await fetch(`${connection.url}/api/health`, { headers: { authorization: `Bearer ${connection.token}` } })).status).toBe(401);
      expect((await fetch(`${next.url}/api/health`, { headers: { authorization: `Bearer ${next.token}` } })).status).toBe(200);
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
  async function agentClient(runtime: CollectorRuntime) {
    const connection = await connectionOf(runtime);
    return (route: string, body?: unknown) => fetch(`${connection.url}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('keeps device-only login and Agent settings outside Vault export, switch and import (L33-A2)', async () => {
    const search: TranscriptSearch = {
      status: () => ({ state: 'ready', indexedDocuments: 0 }), index: async () => undefined, remove: async () => undefined,
      rebuild: async () => undefined, search: async () => ({ hits: [], total: 0, offset: 0, limit: 20 }),
    };
    const base = await options({ capture: vi.fn() }, search);
    const { explicitVaultPath: _explicit, ...value } = base.value;
    const setup = { ...base, value };
    await new MarkdownVault(setup.vaultPath).add(transcriptDocument({
      videoId: 'loginstart1', sourceUrl: 'https://www.youtube.com/watch?v=loginstart1', title: 'Device setting boundary',
      channelId: 'UC-runtime', channelTitle: 'Runtime', publishedAt: null, languageCode: 'en', languageName: 'English',
      subtitleKind: 'manual', bodyMarkdown: 'Body.',
    }));
    await writeVaultMarker(setup.vaultPath, 'XR Collector test');
    await new VaultSelection(path.join(setup.value.profilePath, 'vault-selection.json')).write(setup.vaultPath);
    await writeFile(path.join(setup.value.profilePath, 'login-startup.json'), '{"deviceOnly":true}\n');
    let enabled = true;
    const loginStartup = {
      status: async () => ({ supported: true, enabled, state: enabled ? 'enabled' as const : 'disabled' as const, message: 'test' }),
      update: async (next: boolean) => { enabled = next; return loginStartup.status(); },
    };
    const runtime = await CollectorRuntime.start({ ...setup.value, loginStartup });
    cleanups.push(() => runtime.close());
    const loginStatus = async () => (await (await fetch(`${runtime.server.url}/api/device/login-startup`)).json()).loginStartup;
    const agentStatus = async () => (await (await fetch(`${runtime.server.url}/api/device/agent`)).json()).agent;
    expect(await loginStatus()).toMatchObject({ enabled: true });
    const originalAgent = await connectionOf(runtime);
    const configured = await fetch(`${runtime.server.url}/api/device/agent/port`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'fixed', port: 65431 }),
    });
    expect(configured.status).toBe(200);
    expect(await agentStatus()).toMatchObject({ configured: { mode: 'fixed', port: 65431 }, restartRequired: true });
    const savedAgentSettings = await readFile(setup.value.agentSettingsFile, 'utf8');

    const exported = path.join(path.dirname(setup.value.profilePath), `${path.basename(setup.value.profilePath)}-vault-export.zip`);
    cleanups.push(() => rm(exported, { force: true }));
    const exportResponse = await fetch(`${runtime.server.url}/api/vault/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: exported, overwrite: false }),
    });
    expect(exportResponse.status).toBe(200);
    const exportedBytes = await readFile(exported);
    const entries = await zipEntries(exportedBytes);
    const manifest = await manifestOf(exportedBytes);
    const payload = Buffer.concat([...entries.values()]);
    const names = [...entries.keys()];
    const packageLeaks = {
      loginSettingsName: names.some((name) => name.includes('login-startup.json')),
      agentSettingsName: names.some((name) => name.includes('agent-settings.json')),
      loginSettingValue: payload.includes(Buffer.from('deviceOnly')),
      agentToken: payload.includes(Buffer.from(originalAgent.token)),
      agentPort: payload.includes(Buffer.from('65431')),
    };
    expect(manifest.files.map((file) => file.path)).not.toContain('login-startup.json');
    expect(manifest.files.map((file) => file.path)).not.toContain('agent-settings.json');
    expect(packageLeaks).toEqual({
      loginSettingsName: false, agentSettingsName: false, loginSettingValue: false, agentToken: false, agentPort: false,
    });
    expect(await loginStatus()).toMatchObject({ enabled: true });

    const other = path.join(path.dirname(setup.value.profilePath), `${path.basename(setup.value.profilePath)}-other-vault`);
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    await writeVaultMarker(await mkdir(other, { recursive: true }).then(() => other), 'XR Collector test');
    const opened = await fetch(`${runtime.server.url}/api/vault/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: other }),
    });
    expect(opened.status).toBe(202);
    await expect.poll(async () => (await (await fetch(`${runtime.server.url}/api/vault/status`)).json()).state).toBe('completed');
    expect(await loginStatus()).toMatchObject({ enabled: true });
    expect(await agentStatus()).toMatchObject({ configured: { mode: 'fixed', port: 65431 }, restartRequired: true });
    expect((await connectionOf(runtime)).token).toBe(originalAgent.token);
    expect(await readFile(setup.value.agentSettingsFile, 'utf8')).toBe(savedAgentSettings);

    const preview = await fetch(`${runtime.server.url}/api/vault/import/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: exported }),
    });
    expect(preview.status).toBe(200);
    const comparison = await preview.json() as { id: string };
    const applied = await fetch(`${runtime.server.url}/api/vault/import/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: comparison.id, mode: 'replace' }),
    });
    expect(applied.status).toBe(202);
    await expect.poll(async () => (await (await fetch(`${runtime.server.url}/api/vault/status`)).json()).state).toBe('completed');
    expect(await loginStatus()).toMatchObject({ enabled: true });
    expect(await agentStatus()).toMatchObject({ configured: { mode: 'fixed', port: 65431 }, restartRequired: true });
    expect((await connectionOf(runtime)).token).toBe(originalAgent.token);
    expect(await readFile(setup.value.agentSettingsFile, 'utf8')).toBe(savedAgentSettings);
  }, 20_000);

  it('lets an Agent create a Vault while Not Ready, serves the UI immediately and reopens it after restart', async () => {
    const setup = await selected();
    const runtime = await CollectorRuntime.start({ ...setup.value, suggestedVaultPath: setup.suggested });
    const agent = await agentClient(runtime);
    expect((await (await agent('/api/vault/setup')).json()).vault).toEqual({
      state: 'not_ready', vaultPath: null, suggestedPath: setup.suggested, failure: null,
    });
    expect((await fetch(`${runtime.server.url}/api/documents`)).status).toBe(503);
    const activeConnection = await connectionOf(runtime);
    expect((await fetch(`${activeConnection.url}/api/vault/setup`, { method: 'POST' })).status).toBe(401);

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

    const added = await fetch(`${runtime.server.url}/api/subscriptions`, {
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
    expect((await (await fetch(`${restarted.server.url}/api/subscriptions?type=youtube`)).json()).subscriptions).toMatchObject([{ id: 'UC-runtime' }]);
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

  it('creates a Vault from an export file while Not Ready, with the export\'s collection switch, and refuses an invalid file leaving the folder as it was (X77-A15)', async () => {
    const setup = await selected();
    const source = path.join(setup.value.profilePath, 'source');
    await new MarkdownVault(source).add(transcriptDocument({
      videoId: 'runtime0001', sourceUrl: 'https://www.youtube.com/watch?v=runtime0001', title: 'Runtime', channelId: 'UC-runtime', channelTitle: 'Runtime',
      publishedAt: null, languageCode: 'en', languageName: 'English', subtitleKind: 'manual', bodyMarkdown: 'Body.',
    }));
    await new JsonScheduleStore(source).save({ enabled: true });
    const file = path.join(setup.value.profilePath, 'export.zip');
    await writeFile(file, await packageBytes(source));
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    const ui = (body: unknown) => fetch(`${runtime.server.url}/api/vault/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const empty = path.join(setup.value.profilePath, 'Empty');
    await mkdir(empty);
    for (const [body, code] of [
      [{ action: 'import', path: empty }, 'invalid_request'],
      [{ action: 'import', path: empty, packagePath: path.join(setup.value.profilePath, 'none.zip') }, 'invalid_request'],
      [{ action: 'import', path: empty, packagePath: path.join(setup.value.profilePath, 'export.xr-vault') }, 'invalid_request'],
    ] as const) {
      const response = await ui(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(code);
    }
    expect(await readdir(empty)).toEqual([]);
    expect(runtime.status().state).toBe('not_ready');

    const imported = await ui({ action: 'import', path: empty, packagePath: file });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ vault: { state: 'ready', vaultPath: empty }, documentCount: 1 });
    expect(JSON.parse(await readFile(path.join(setup.value.profilePath, 'vault-selection.json'), 'utf8'))).toEqual({ path: empty });
    expect((await (await fetch(`${runtime.server.url}/api/schedule`)).json()).schedule.enabled).toBe(true);
    expect(await readdir(empty)).not.toContain('xr-collector-sync.json');
    await expect(readFile(path.join(setup.value.profilePath, 'vault-import-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('takes back a Vault an import from Onboarding left before the selection named it', async () => {
    const setup = await selected();
    const source = path.join(setup.value.profilePath, 'source');
    await mkdir(source);
    await writeVaultMarker(source, 'XR Collector test');
    const file = path.join(setup.value.profilePath, 'export.zip');
    await writeFile(file, await packageBytes(source));
    const target = path.join(setup.value.profilePath, 'Imported');
    await importNewVault({ packageFile: file, folder: target, profilePath: setup.value.profilePath, createdBy: 'XR Collector test' });
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    expect(runtime.status().state).toBe('not_ready');
    await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(setup.value.profilePath, 'vault-import-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('takes back the imported Vault when its search cannot start or its location cannot be saved (X77-A15)', async () => {
    const setup = await selected();
    const source = path.join(setup.value.profilePath, 'source');
    await mkdir(source);
    await writeVaultMarker(source, 'XR Collector test');
    const file = path.join(setup.value.profilePath, 'export.zip');
    await writeFile(file, await packageBytes(source));
    const target = path.join(setup.value.profilePath, 'Imported');
    let searchFails = true;
    const createSearch = setup.value.workspace.createSearch;
    const runtime = await CollectorRuntime.start({
      ...setup.value,
      workspace: {
        ...setup.value.workspace,
        createSearch: async (root: string) => {
          if (searchFails && root === target) throw new Error('search stopped');
          return createSearch(root);
        },
      },
    });
    cleanups.push(() => runtime.close());
    const journal = path.join(setup.value.profilePath, 'vault-import-journal.json');
    const selection = path.join(setup.value.profilePath, 'vault-selection.json');
    const importing = () => fetch(`${runtime.server.url}/api/vault/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import', path: target, packagePath: file }),
    });

    const failedSearch = await importing();
    expect(failedSearch.status).toBe(422);
    expect((await failedSearch.json()).error.message).toContain('無法啟動');
    await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });

    searchFails = false;
    const write = vi.spyOn(VaultSelection.prototype, 'write').mockRejectedValueOnce(new Error('disk full'));
    const failedSelection = await importing();
    expect(failedSelection.status).toBe(422);
    expect((await failedSelection.json()).error.message).toContain('無法保存知識庫位置');
    write.mockRestore();
    await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(selection)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runtime.status().state).toBe('not_ready');

    const imported = await importing();
    expect(imported.status).toBe(200);
    expect(runtime.status()).toMatchObject({ state: 'ready', vaultPath: target });
    await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets an Agent move the Vault, reopens the new location after restart and keeps the Agent entry (A-11)', async () => {
    const search: TranscriptSearch = {
      status: () => ({ state: 'ready', indexedDocuments: 0 }), index: async () => undefined, remove: async () => undefined,
      rebuild: async () => undefined, search: async () => ({ hits: [], total: 0, offset: 0, limit: 20 }),
    };
    const base = await options({ capture: vi.fn() }, search);
    const { explicitVaultPath: _explicit, ...value } = base.value;
    const setup = { ...base, value };
    await writeVaultMarker(await mkdir(setup.vaultPath, { recursive: true }).then(() => setup.vaultPath), 'XR Collector test');
    await writeFile(path.join(setup.value.profilePath, 'vault-selection.json'), JSON.stringify({ path: setup.vaultPath }));
    const first = await CollectorRuntime.start(setup.value);
    const agent = await agentClient(first);
    const firstConnection = await connectionOf(first);
    const fixedPort = Number(new URL(firstConnection.url).port);
    const configured = await fetch(`${first.server.url}/api/device/agent/port`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'fixed', port: fixedPort }),
    });
    expect(configured.status).toBe(200);
    const savedAgentSettings = await readFile(setup.value.agentSettingsFile, 'utf8');
    const target = path.join(setup.value.profilePath, '..', `${path.basename(setup.value.profilePath)}-moved`);
    cleanups.push(() => rm(target, { recursive: true, force: true }));
    const moved = await agent('/api/vault/move', { targetPath: target });
    expect(moved.status).toBe(202);
    await expect.poll(async () => (await (await agent('/api/vault/status')).json()).state, { timeout: 10_000 }).toBe('completed');
    expect((await (await agent('/api/health')).json()).runtime.vaultPath).toBe(path.resolve(target));
    expect((await connectionOf(first)).token).toBe(firstConnection.token);
    expect(await readFile(setup.value.agentSettingsFile, 'utf8')).toBe(savedAgentSettings);
    await first.close();

    const second = await CollectorRuntime.start(setup.value);
    cleanups.push(() => second.close());
    expect(second.status()).toMatchObject({ state: 'ready', vaultPath: path.resolve(target) });
    const again = await agentClient(second);
    expect((await (await again('/api/health')).json()).runtime).toMatchObject({ instanceId: second.instanceId, vaultPath: path.resolve(target) });
    const secondConnection = await connectionOf(second);
    expect(secondConnection).toEqual({ url: `http://127.0.0.1:${fixedPort}`, token: firstConnection.token });
    expect(await readFile(setup.value.agentSettingsFile, 'utf8')).toBe(savedAgentSettings);
    await expect(readdir(setup.vaultPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('refuses to move or switch a Vault the app was started with (A-10)', async () => {
    const setup = await options({ capture: vi.fn() });
    const runtime = await CollectorRuntime.start(setup.value);
    cleanups.push(() => runtime.close());
    const status = await (await fetch(`${runtime.server.url}/api/vault/status`)).json();
    expect(status.relocationUnavailable).toMatchObject({ code: 'vault_location_fixed' });
    const refused = await fetch(`${runtime.server.url}/api/vault/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: setup.value.profilePath }),
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('vault_location_fixed');
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
