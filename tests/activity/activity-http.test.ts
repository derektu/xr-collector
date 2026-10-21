import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import { CollectorError, type CollectionJob, type SavedDocument } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { CollectorRuntime } from '../../src/runtime/collector-runtime.js';
import { UnavailableTranscriptSearch } from '../../src/search/managed-transcript-search.js';
import { createHttpApp, type ActivityAccess, type HttpAppOptions } from '../../src/server/app.js';
import type { CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import { transcriptOf } from '../support/youtube-documents.js';
import { withYouTube } from '../support/youtube-sources.js';

// The activity and job query routes: device data readable while an import holds the Vault and before
// one is chosen, the same contract for the UI and Agents, and parameter validation.

const VAULT = '/vaults/http';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function services(failures: CollectorError[] = []) {
  let saved: SavedDocument | null = null;
  const vault: DocumentVault = {
    getByKey: async () => saved,
    add: async (document) => {
      const input = transcriptOf(document);
      saved = {
        id: `youtube:${input.videoId}`, type: 'Transcript', sourceType: 'youtube', title: input.title, sourceUrl: input.sourceUrl,
        sourceId: input.videoId, publisher: { id: null, name: null }, publishedAt: null, collectedAt: '2026-10-15T00:00:00.000Z',
        youtube: { languageCode: 'zh-Hant', languageName: null, subtitleKind: 'manual' }, bodyMarkdown: input.bodyMarkdown,
      };
      return saved;
    },
    list: async () => [],
    read: async () => saved,
  };
  const store = JobStore.memory();
  const collector = new Collector(vault, { index: async () => undefined });
  const jobs = new JobManager({
    vaultPath: VAULT, store, documents: collector,
    plugins: [youtubePlugin({
      resolveChannel: async () => { throw new CollectorError('invalid_channel', '無法辨認'); },
      discover: async () => [],
      capture: async (video) => {
        const failure = failures.shift();
        if (failure) throw failure;
        return {
          videoId: video.videoId, sourceUrl: video.canonicalUrl, title: 'HTTP 影片', channelId: null, channelTitle: null,
          publishedAt: null, languageCode: 'zh-Hant', languageName: null, subtitleKind: 'manual', bodyMarkdown: '正文',
        };
      },
    })],
    subscriptions: { youtube: { list: async () => [], add: async (channel) => channel, remove: async () => false, setEnabled: async () => null, update: async () => null } as never },
  });
  const activity: ActivityAccess = {
    query: (query) => store.activity.query(query, { vaultPath: VAULT }),
    health: () => store.activity.health(),
  };
  return { collector, jobs, store, activity };
}

async function settled(app: Awaited<ReturnType<typeof createHttpApp>>, id: string, headers: Record<string, string> = {}): Promise<CollectionJob> {
  for (;;) {
    const job = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers })).json().job as CollectionJob;
    if (job.state !== 'queued' && job.state !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('activity and job routes (A-T8, A-T10)', () => {
  it('stays readable while an import holds the Vault, and before a Vault is chosen', async () => {
    const { collector, jobs, activity } = services();
    const transfer = {
      assertReadable: () => { throw new CollectorError('vault_busy', '正在合併或復原資料，請稍後再讀取。'); },
      enterWrite: () => () => undefined,
    } as unknown as HttpAppOptions['transfer'];
    const merging = await createHttpApp({ collector, jobs, activity, ...(transfer ? { transfer } : {}) });
    cleanups.push(() => merging.close());
    expect((await merging.inject({ method: 'GET', url: '/api/documents' })).statusCode).toBe(409);
    for (const url of ['/api/activity', '/api/jobs', '/api/jobs/summary?since=2026-10-15T00:00:00%2B08:00']) {
      expect((await merging.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }

    const notReady = await createHttpApp({ collector, jobs, activity, notReady: () => '尚未設定 Vault。' });
    cleanups.push(() => notReady.close());
    expect((await notReady.inject({ method: 'GET', url: '/api/documents' })).statusCode).toBe(503);
    expect((await notReady.inject({ method: 'GET', url: '/api/activity' })).statusCode).toBe(200);
    const health = (await notReady.inject({ method: 'GET', url: '/api/health' })).json();
    expect(health.activityLog).toMatchObject({ state: 'ok', pending: 0, dropped: 0 });
  });

  it('answers Agents with the same activity, summary and retry contract, and rejects malformed queries', async () => {
    const { collector, jobs, activity } = services([new CollectorError('no_subtitles', '這支影片沒有可取得的既有字幕。')]);
    const app = await createHttpApp({ collector, jobs, activity, agentToken: 'agent-token-for-tests' });
    cleanups.push(() => app.close());
    const headers = { authorization: 'Bearer agent-token-for-tests' };
    expect((await app.inject({ method: 'GET', url: '/api/activity' })).statusCode).toBe(401);

    const submitted = (await app.inject({ method: 'POST', url: '/api/youtube/collect', headers, payload: { url: 'https://youtu.be/kkkkkkkkkkk' } })).json();
    const failed = await settled(app, submitted.job.id, headers);
    expect(failed.state).toBe('failed');
    const retry = await app.inject({ method: 'POST', url: `/api/jobs/${failed.id}/retry`, headers });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ deduplicated: false, job: { retryOf: failed.id } });
    await settled(app, retry.json().job.id, headers);
    const again = await app.inject({ method: 'POST', url: `/api/jobs/${failed.id}/retry`, headers });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('job_not_retryable');
    expect((await app.inject({ method: 'POST', url: '/api/jobs/nope/retry', headers })).statusCode).toBe(404);

    const page = (await app.inject({ method: 'GET', url: `/api/activity?jobId=${failed.id}&limit=2`, headers })).json();
    expect(page.events).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page).toMatchObject({ retentionDays: 30, log: { state: 'ok' } });
    const next = (await app.inject({ method: 'GET', url: `/api/activity?jobId=${failed.id}&limit=2&cursor=${page.nextCursor}`, headers })).json();
    expect(next.events.map((event: { eventId: string }) => event.eventId)).not.toContain(page.events[0].eventId);
    const errors = (await app.inject({ method: 'GET', url: '/api/activity?severity=warning,error', headers })).json();
    expect(errors.events.map((event: { eventType: string }) => event.eventType)).toEqual(['job.failed']);
    const summary = (await app.inject({ method: 'GET', url: '/api/jobs/summary?since=2000-01-01T00:00:00Z', headers })).json();
    expect(summary.summary).toMatchObject({ active: 0, completed: 1, failed: 0 });

    for (const query of ['severity=fatal', 'severity=', 'eventType=Bad-Type', 'since=2026-10-15', 'until=yesterday', 'limit=0', 'limit=101', 'unknown=1', 'cursor=garbage', `jobId=${'x'.repeat(201)}`, 'severity=info&severity=error']) {
      const response = await app.inject({ method: 'GET', url: `/api/activity?${query}`, headers });
      expect(response.statusCode, query).toBe(400);
      expect(response.json().error.code).toBe('invalid_request');
    }
    expect((await app.inject({ method: 'GET', url: '/api/jobs/summary?since=today', headers })).statusCode).toBe(400);
  });

  it('serves every device event from a runtime with no Vault yet, masking the Agent token', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-activity-runtime-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const runtime = await CollectorRuntime.start({
      profilePath: root,
      workspace: withYouTube({
        capture: { capture: async () => { throw new Error('unused'); } } as never,
        channelSource: { resolve: async () => { throw new Error('unused'); }, listVideos: async () => [] },
        searchBinary: 'unused', searchData: path.join(root, 'search'), exportFolder: path.join(root, 'exports'), backupFolder: path.join(root, 'backups'),
        createSearch: async () => ({ search: new UnavailableTranscriptSearch('test'), close: async () => undefined }),
      }),
      connectionFile: path.join(root, 'agent-connection.json'),
      skillPath: path.resolve('skills/xr-collector-agent'), uiPort: 0,
    });
    cleanups.push(() => runtime.close());
    const { token, url } = JSON.parse(await readFile(path.join(root, 'agent-connection.json'), 'utf8')) as { token: string; url: string };
    const today = new Date().toISOString();
    await mkdir(path.join(root, 'jobs', 'events'), { recursive: true });
    await writeFile(path.join(root, 'jobs', 'events', `${today.slice(0, 10)}.jsonl`), `${JSON.stringify({
      eventId: 'old-vault', timestamp: today, severity: 'error', eventType: 'vault.transfer_failed',
      message: `合併失敗 token ${token}`, vaultPath: '/vaults/elsewhere', jobId: null,
    })}\n`);

    const ui = await fetch(`${runtime.server.url}/api/activity`);
    expect(ui.status).toBe(200);
    const body = await ui.json() as { events: Array<{ eventId: string; message: string }> };
    expect(body.events.map((event) => event.eventId)).toEqual(['old-vault']);
    expect(body.events[0]!.message).not.toContain(token);
    const agent = await fetch(`${url}/api/activity`, { headers: { authorization: `Bearer ${token}` } });
    expect(agent.status).toBe(200);
  });
});
