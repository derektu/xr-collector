// Secrets in source errors never leave the app: when a source's error carries the Agent token or a
// credential (an Authorization header, a secret URL parameter), the job error, the activity log, the
// subscription's check failure in the Vault and the HTTP error answer that the UI and the Agent read
// all show it masked, and no file the app writes outside the Agent settings holds it. Work that a
// restart resumes and that fails at once is masked too: the token is protected before the Vault opens.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectorError } from '../../src/core/collector-error.js';
import { startCollectorServer } from '../../src/server/collector-server.js';
import { UnavailableTranscriptSearch } from '../../src/search/managed-transcript-search.js';
import { withYouTube } from '../support/youtube-sources.js';
import { eventually } from '../support/wait.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const channel = { id: 'UC-masking', title: 'Masking', url: 'https://www.youtube.com/channel/UC-masking' };
const BEARER = 'leaked.bearer.value';
const PARAMETER = 'leaked-parameter-value';

/** Every file under `root` with its text, except the Agent settings, which hold the token by design. */
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
    // Soft, so that one run reports every exit that shows a secret.
    const expectMasked = (exit: string, text: string) => {
      for (const secret of secrets) expect.soft(text, exit).not.toContain(secret);
      expect.soft(text, exit).toContain('[已遮蔽]');
    };

    // A single item: the job error the Agent and the UI read.
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

    // A subscription whose check fails: the check failure the Vault's subscription file keeps.
    const added = await agent('/api/subscriptions', { method: 'POST', body: JSON.stringify({ url: channel.url }) });
    expect(added.status).toBe(202);
    const subscription = await eventually(async () => {
      const value = (await (await agent(`/api/subscriptions/youtube/${channel.id}`)).json()).subscription;
      expect(value.checkFailures).toMatchObject({ count: 1, error: { code: 'channel_not_found' } });
      return value;
    });
    expectMasked('subscription check failure', subscription.checkFailures.error.message);

    // A request answered with an error.
    for (const base of [ui, connection.url]) {
      const preview = await (base === ui
        ? fetch(`${ui}/api/subscription-previews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/@broken' }) })
        : agent('/api/subscription-previews', { method: 'POST', body: JSON.stringify({ url: 'https://www.youtube.com/@broken' }) }));
      const body = await preview.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('channel_not_found');
      expectMasked(`error answer (${base === ui ? 'UI' : 'Agent'})`, body.error.message);
    }

    // The activity the Agent reads: the failure's message and the tool output kept as its detail.
    const failedEvent = await eventually(async () => {
      const events = (await (await agent(`/api/activity?jobId=${itemJob}`)).json()).events as Array<{ eventType: string; message: string; detail?: string }>;
      const event = events.find((candidate) => candidate.eventType === 'job.failed');
      expect(event).toBeDefined();
      return event!;
    });
    expectMasked('activity message', failedEvent.message);
    expectMasked('activity detail', failedEvent.detail!);

    // Every file written to the profile and the Vault, once the job store and activity are on disk.
    await runtime.close();
    const files = await writtenFiles(root, agentSettingsFile);
    for (const [file, text] of files) {
      for (const secret of secrets) expect.soft(text.includes(secret), `${file} holds a secret`).toBe(false);
    }
    const masked = [...files].filter(([, text]) => text.includes('[已遮蔽]')).map(([file]) => file);
    // The job store, the activity day file and the Vault's subscription file.
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

    // Before the restart: a subscription and a single video that waits behind a running capture.
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

    // The restart loads a token no earlier run held, and finds the queued video and a check that is due.
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
});
