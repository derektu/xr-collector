// Broken, the Agent token or a credential reaches the UI, the Agent or a file on disk unmasked.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectorError } from '../../../src/shared/lib/collector-error.js';
import { protectSecret } from '../../../src/shared/lib/redact.js';
import type { DeviceUpdateStatus } from '../../../src/shared/api/update-types.js';
import type { UpdateAccess } from '../../../src/domain/updates/types.js';
import { startCollectorServer } from '../../../src/transport/server/collector-server.js';
import { UnavailableTranscriptSearch } from '../../../src/domain/search/managed-transcript-search.js';
import { withYouTube } from '../../support/youtube-sources.js';
import { eventually } from '../../support/wait.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';
import { QUIET_OUTPUT, recordingLog } from '../../support/log.js';
import { openCollectorLog } from '../../../src/domain/log/index.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const channel = { id: 'UC-masking', title: 'Masking', url: 'https://www.youtube.com/channel/UC-masking' };
const BEARER = 'leaked.bearer.value';
const PARAMETER = 'leaked-parameter-value';

async function writtenFiles(root: string, except: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (file !== except) files.set(path.relative(root, file), await readFile(file, 'utf8'));
  }
  return files;
}

describe('secrets in source errors', () => {
  it('are masked in job errors, activity, Vault subscription files and HTTP error answers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-secret-masking-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const profilePath = path.join(root, 'profile');
    await mkdir(profilePath);
    const agentSettingsFile = path.join(root, 'agent-settings.json');
    let token = '';
    const leak = () => `ERROR: agent ${token} Authorization: Bearer ${BEARER} https://cdn.test/v?id=1&access_token=${PARAMETER}`;
    const runtime = await startCollectorServer({
      log: recordingLog(),
      sources: PRODUCT_SOURCES,
      profilePath,
      explicitVaultPath: path.join(root, 'vault'),
      workspace: withYouTube({
        capture: { capture: async () => { throw new CollectorError('video_unavailable', `無法取得字幕：${leak()}`, { detail: leak() }); } },
        channelSource: {
          resolve: async (url) => {
            if (url.includes('@broken')) throw new CollectorError('channel_not_found', `找不到頻道：${leak()}`);
            return channel;
          },
          listVideos: async () => { throw new CollectorError('channel_not_found', `無法列出影片：${leak()}`); },
        },
        searchBinary: 'unused', searchLexicon: 'unused', searchData: path.join(root, 'search'), exportFolder: path.join(root, 'exports'), backupFolder: path.join(root, 'backups'),
        createSearch: async () => ({ search: new UnavailableTranscriptSearch('test'), close: async () => undefined }),
      }),
      agentSettingsFile,
      skillPath: path.resolve('skills/xr-collector-agent'),
      uiPort: 0,
    });
    cleanups.push(() => runtime.close());
    const ui = runtime.listeners.ui.url;
    const connection = ((await (await fetch(`${ui}/api/device/agent/connection`)).json()) as { connection: { url: string; token: string } }).connection;
    token = connection.token;
    const agent = (route: string, init?: RequestInit) => fetch(`${connection.url}${route}`, {
      ...init, headers: { authorization: `Bearer ${token}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    });
    const secrets = [token, BEARER, PARAMETER];
    const expectMasked = (exit: string, text: string) => {
      for (const secret of secrets) expect.soft(text, exit).not.toContain(secret);
      expect.soft(text, exit).toContain('[已遮蔽]');
    };

    const item = await agent('/api/items', { method: 'POST', body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=iiiiiiiiiii' }) });
    expect(item.status).toBe(202);
    const itemJob = (await item.json()).job.id as string;
    const failed = await eventually(async () => {
      const job = (await (await agent(`/api/jobs/${itemJob}`)).json()).job;
      expect(job.state).toBe('failed');
      return job;
    });
    expect(failed.error.code).toBe('video_unavailable');
    expectMasked('job error (Agent)', failed.error.message);
    expectMasked('job error (UI)', JSON.stringify((await (await fetch(`${ui}/api/jobs/${itemJob}`)).json()).job.error));

    const added = await agent('/api/subscriptions', { method: 'POST', body: JSON.stringify({ url: channel.url }) });
    expect(added.status).toBe(202);
    const subscription = await eventually(async () => {
      const value = (await (await agent(`/api/subscriptions/youtube/${channel.id}`)).json()).subscription;
      expect(value.checkFailures).toMatchObject({ count: 1, error: { code: 'channel_not_found' } });
      return value;
    });
    expectMasked('subscription check failure', subscription.checkFailures.error.message);

    for (const base of [ui, connection.url]) {
      const preview = await (base === ui
        ? fetch(`${ui}/api/subscription-previews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/@broken' }) })
        : agent('/api/subscription-previews', { method: 'POST', body: JSON.stringify({ url: 'https://www.youtube.com/@broken' }) }));
      const body = await preview.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('channel_not_found');
      expectMasked(`error answer (${base === ui ? 'UI' : 'Agent'})`, body.error.message);
    }

    const failedEvent = await eventually(async () => {
      const events = (await (await agent(`/api/activity?jobId=${itemJob}`)).json()).events as Array<{ eventType: string; message: string; detail?: string }>;
      const event = events.find((candidate) => candidate.eventType === 'job.failed');
      expect(event).toBeDefined();
      return event!;
    });
    expectMasked('activity message', failedEvent.message);
    expectMasked('activity detail', failedEvent.detail!);

    await runtime.close();
    const files = await writtenFiles(root, agentSettingsFile);
    for (const [file, text] of files) {
      for (const secret of secrets) expect.soft(text.includes(secret), `${file} holds a secret`).toBe(false);
    }
    const masked = [...files].filter(([, text]) => text.includes('[已遮蔽]')).map(([file]) => file);
    expect(masked.some((file) => file.startsWith(`profile${path.sep}jobs`) && !file.endsWith('.jsonl'))).toBe(true);
    expect(masked.some((file) => file.endsWith('.jsonl'))).toBe(true);
    expect(masked.some((file) => file.startsWith(`vault${path.sep}`))).toBe(true);
  });

  it('are masked in work that fails as soon as a restart resumes it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-secret-masking-start-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const profilePath = path.join(root, 'profile');
    await mkdir(profilePath);
    const agentSettingsFile = path.join(root, 'agent-settings.json');
    const leak = (token: string) => `ERROR: agent ${token}`;
    let behavior: 'hold' | 'leak' = 'hold';
    let token = '';
    const releases: Array<() => void> = [];
    const capture = async (video: { videoId: string; canonicalUrl: string }) => {
      if (behavior === 'leak') throw new CollectorError('video_unavailable', `無法取得字幕：${leak(token)}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        videoId: video.videoId, sourceUrl: video.canonicalUrl, title: `Video ${video.videoId}`, channelId: null,
        channelTitle: 'Masking', publishedAt: null, languageCode: 'en', languageName: 'English',
        subtitleKind: 'manual' as const, bodyMarkdown: 'Body.',
      };
    };
    const runtimeOptions = {
      profilePath,
      log: recordingLog(),
      sources: PRODUCT_SOURCES,
      explicitVaultPath: path.join(root, 'vault'),
      workspace: withYouTube({
        capture: { capture },
        channelSource: {
          resolve: async () => channel,
          listVideos: async () => {
            if (behavior === 'leak') throw new CollectorError('channel_not_found', `無法列出影片：${leak(token)}`);
            return [];
          },
        },
        searchBinary: 'unused', searchLexicon: 'unused', searchData: path.join(root, 'search'), exportFolder: path.join(root, 'exports'), backupFolder: path.join(root, 'backups'),
        createSearch: async () => ({ search: new UnavailableTranscriptSearch('test'), close: async () => undefined }),
      }),
      agentSettingsFile,
      skillPath: path.resolve('skills/xr-collector-agent'),
      uiPort: 0,
    };

    const first = await startCollectorServer(runtimeOptions);
    const post = (route: string, body: unknown) => fetch(`${first.listeners.ui.url}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const addJob = (await (await post('/api/subscriptions', { url: channel.url })).json()).job.id as string;
    await eventually(async () => {
      expect((await (await fetch(`${first.listeners.ui.url}/api/jobs/${addJob}`)).json()).job.state).toBe('completed');
      const subscription = (await (await fetch(`${first.listeners.ui.url}/api/subscriptions/youtube/${channel.id}`)).json()).subscription;
      expect(subscription.lastCheckedAt).not.toBeNull();
    });
    await post('/api/items', { url: 'https://www.youtube.com/watch?v=runningvid1' });
    const queued = (await (await post('/api/items', { url: 'https://www.youtube.com/watch?v=queuedvid01' })).json()).job.id as string;
    await eventually(() => expect(releases).toHaveLength(1));
    const closing = first.close();
    for (const release of releases.splice(0)) release();
    await closing;

    token = 'c0ffee'.repeat(10) + 'beef';
    await writeFile(agentSettingsFile, `${JSON.stringify({ schemaVersion: 1, token, port: { mode: 'auto' } })}\n`, { mode: 0o600 });
    const channels = path.join(root, 'vault', 'settings', 'youtube-channels.json');
    const saved = JSON.parse(await readFile(channels, 'utf8')) as Record<string, unknown>;
    const records = Object.values(saved).find((value) => Array.isArray(value) && value.some((entry) => entry?.id === channel.id)) as Array<{ nextCheckAt: string | null }>;
    for (const subscription of records) subscription.nextCheckAt = '2000-01-01T00:00:00.000Z';
    await writeFile(channels, `${JSON.stringify(saved, null, 2)}\n`);
    behavior = 'leak';
    const second = await startCollectorServer(runtimeOptions);
    cleanups.push(() => second.close());
    await eventually(async () => {
      expect((await (await fetch(`${second.listeners.ui.url}/api/jobs/${queued}`)).json()).job.state).toBe('failed');
      const subscription = (await (await fetch(`${second.listeners.ui.url}/api/subscriptions/youtube/${channel.id}`)).json()).subscription;
      expect(subscription.checkFailures).toMatchObject({ count: 1, error: { code: 'channel_not_found' } });
    });
    await second.close();

    const files = await writtenFiles(root, agentSettingsFile);
    for (const file of [`profile${path.sep}jobs${path.sep}jobs.json`, `vault${path.sep}settings${path.sep}youtube-channels.json`]) {
      expect.soft(files.get(file), file).toContain('agent [已遮蔽]');
      expect.soft(files.get(file)?.includes(token), `${file} holds the token`).toBe(false);
    }
  });

  it('are masked in the update and Vault operation status the UI and the Agent read, and in the program log that keeps a search engine start failure out of the search status', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-secret-masking-status-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const profilePath = path.join(root, 'profile');
    await mkdir(profilePath);
    const agentSettingsFile = path.join(root, 'agent-settings.json');
    const token = 'feed'.repeat(12);
    await writeFile(agentSettingsFile, `${JSON.stringify({ schemaVersion: 1, token, port: { mode: 'auto' } })}\n`, { mode: 0o600 });
    const searchKey = 'search-engine-key-296';
    protectSecret(searchKey);
    const leak = `agent ${token} search ${searchKey}`;
    const listeners = new Set<() => void>();
    let update = { phase: 'idle', message: '' } as unknown as DeviceUpdateStatus;
    const updates: UpdateAccess = {
      status: () => update,
      check: async () => {
        update = { ...update, phase: 'error', message: `無法檢查更新：${leak}`, errorCode: 'update_check_failed' };
        for (const listener of listeners) listener();
        return update;
      },
      download: async () => update, apply: async () => update, cancel: async () => update,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const runtime = await startCollectorServer({
      log: openCollectorLog({ folder: path.join(profilePath, 'logs'), output: QUIET_OUTPUT }),
      sources: PRODUCT_SOURCES,
      profilePath,
      explicitVaultPath: path.join(root, 'vault'),
      workspace: withYouTube({
        capture: { capture: async () => { throw new CollectorError('video_unavailable', 'unused'); } },
        channelSource: { resolve: async () => channel, listVideos: async () => [] },
        searchBinary: 'unused', searchLexicon: path.join(root, `lexicon ${leak}.txt`), searchData: path.join(root, 'search'), exportFolder: path.join(root, 'exports'), backupFolder: path.join(root, 'backups'),
      }),
      updates,
      agentSettingsFile,
      skillPath: path.resolve('skills/xr-collector-agent'),
      uiPort: 0,
    });
    cleanups.push(() => runtime.close());
    const ui = runtime.listeners.ui.url;
    const agentUrl = runtime.listeners.agent!.url;
    const read = async (base: string, route: string, init: RequestInit = {}) => {
      const response = await fetch(`${base}${route}`, { ...init, headers: {
        ...(base === agentUrl ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}),
      } });
      return response.text();
    };
    const expectMasked = (exit: string, text: string) => {
      for (const secret of [token, searchKey]) expect.soft(text, exit).not.toContain(secret);
      expect.soft(text, exit).toContain('[已遮蔽]');
    };
    const announced = async (kind: string, revision: string) => {
      const answer = JSON.parse(await read(agentUrl, `/api/changes?after=${revision}&kind=${kind}&wait=10`)) as { batches: unknown[]; revision: string };
      expect(answer.batches.length).toBeGreaterThan(0);
      return answer.revision;
    };
    let revision = (JSON.parse(await read(agentUrl, '/api/changes')) as { revision: string }).revision;

    await read(ui, '/api/device/updates/check', { method: 'POST' });
    revision = await announced('update', revision);
    for (const base of [ui, agentUrl]) expectMasked(`update status (${base === ui ? 'UI' : 'Agent'})`, await read(base, '/api/device/updates'));

    const folder = path.join(root, `exports ${leak}`);
    await mkdir(folder, { recursive: true });
    await read(agentUrl, '/api/vault/export', { method: 'POST', body: JSON.stringify({ path: path.join(folder, 'export.zip'), overwrite: false }) });
    await eventually(async () => expect(JSON.parse(await read(ui, '/api/vault/status')).state).toBe('completed'));
    revision = await announced('vault', revision);
    for (const base of [ui, agentUrl]) expectMasked(`Vault operation status (${base === ui ? 'UI' : 'Agent'})`, await read(base, '/api/vault/status'));

    for (const base of [ui, agentUrl]) {
      const status = await read(base, '/api/search/status');
      for (const secret of [token, searchKey, '[已遮蔽]']) expect.soft(status, `search status (${base === ui ? 'UI' : 'Agent'})`).not.toContain(secret);
    }
    expectMasked('program log', await read(agentUrl, '/api/device/logs?level=error'));
  });
});
