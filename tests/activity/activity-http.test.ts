import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import { CollectorError } from '../../src/core/collector-error.js';
import type { CollectionJob } from '../../src/core/job-types.js';
import type { SavedDocument } from '../../src/core/document-types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { memoryJobRecords } from '../../src/runtime/job-records.js';
import { CollectorRuntime } from '../../src/runtime/collector-runtime.js';
import { UnavailableTranscriptSearch } from '../../src/search/managed-transcript-search.js';
import { createHttpApp, type ActivityAccess, type HttpAppOptions } from '../../src/server/app.js';
import type { CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import { transcriptOf } from '../support/youtube-documents.js';
import { withYouTube } from '../support/youtube-sources.js';
import { eventually } from '../support/wait.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';

// The activity and job query routes: device data readable while an import holds the Vault and before
// one is chosen, the summary and retry contract, and parameter validation.

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
  const records = memoryJobRecords(PRODUCT_SOURCES);
  const store = records.jobs;
  const collector = new Collector(vault, { index: async () => undefined });
  const jobs = new JobManager({
    vaultPath: VAULT, store, sources: PRODUCT_SOURCES, documents: collector,
    plugins: [youtubePlugin({
      resolveChannel: async () => { throw new CollectorError('invalid_subscription', '無法辨認'); },
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
    query: (query) => records.views.query(query, { vaultPath: VAULT }),
    summary: (query) => records.views.summary(query, { vaultPath: VAULT }),
    group: (groupId, limit, cursor, severity) => records.views.group(groupId, { vaultPath: VAULT }, limit, cursor, severity),
    health: () => records.views.health(),
  };
  return { collector, jobs, store, activity };
}

async function settled(app: Awaited<ReturnType<typeof createHttpApp>>, id: string, headers: Record<string, string> = {}): Promise<CollectionJob> {
  return eventually(async () => {
    const job = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers })).json().job as CollectionJob;
    expect(job.state).not.toMatch(/^(queued|running)$/u);
    return job;
  });
}

describe('activity and job routes (A-T8, A-T10)', () => {
  it('serves the summary and exact group detail (A4-A5)', async () => {
    const { collector, jobs, store, activity } = services();
    for (let index = 0; index < 2; index += 1) {
      store.event({
        severity: 'debug', eventType: 'job.started', message: '開始。', vaultPath: VAULT, jobId: `check-${index}`,
        sourceType: 'youtube', sourceId: 'UC-summary', subscriptionId: 'UC-summary', sourceTitle: '摘要頻道', trigger: 'scheduled',
      });
      store.event({
        severity: 'info', eventType: 'job.completed', message: '沒有新影片。', vaultPath: VAULT, jobId: `check-${index}`,
        sourceType: 'youtube', sourceId: 'UC-summary', subscriptionId: 'UC-summary', sourceTitle: '摘要頻道', trigger: 'scheduled', outcome: 'empty',
        check: { trigger: 'scheduled', result: 'empty', created: 0, existing: 5, failed: 0, skipped: 0 },
      });
    }
    const ui = await createHttpApp({ sources: PRODUCT_SOURCES, collector, jobs, activity });
    cleanups.push(() => ui.close());
    const query = '/api/activity?view=summary&sourceType=youtube&subscriptionId=UC-summary&limit=1';
    const uiPage = (await ui.inject({ method: 'GET', url: query })).json();
    expect(uiPage.entries[0]).toMatchObject({ kind: 'check', count: 2, existing: 5, result: 'empty' });
    const groupId = uiPage.entries[0].groupId;
    const detail = await ui.inject({ method: 'GET', url: `/api/activity/groups/${encodeURIComponent(groupId)}?limit=1` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ checks: [{ events: expect.any(Array) }], nextCursor: expect.any(String) });
    expect(detail.json().checks[0].events.map((event: { eventType: string }) => event.eventType).sort()).toEqual(['job.completed', 'job.started']);
    const next = await ui.inject({ method: 'GET', url: `/api/activity/groups/${encodeURIComponent(groupId)}?limit=1&cursor=${encodeURIComponent(detail.json().nextCursor)}` });
    expect(next.json().checks).toHaveLength(1);
    expect((await ui.inject({ method: 'GET', url: '/api/activity?view=bogus' })).statusCode).toBe(400);
    expect((await ui.inject({ method: 'GET', url: '/api/activity?view=summary&cursor=bogus' })).statusCode).toBe(400);
    expect((await ui.inject({ method: 'GET', url: '/api/activity/groups/unknown' })).statusCode).toBe(410);
    const filteredSummary = (await ui.inject({ method: 'GET', url: '/api/activity?view=summary&eventType=job.completed' })).json();
    expect(filteredSummary.entries).toEqual([]);
    expect(filteredSummary.events).toBeUndefined();
    const debugDetail = (await ui.inject({ method: 'GET', url: `/api/activity/groups/${encodeURIComponent(uiPage.entries[0].groupId)}?severity=debug` })).json();
    expect(debugDetail.group.count).toBe(2);
    expect(debugDetail.checks).toHaveLength(2);
    expect(debugDetail.checks.every((check: { events: Array<{ eventType: string }> }) => check.events.map((event) => event.eventType).join() === 'job.started')).toBe(true);
    const rawAll = (await ui.inject({ method: 'GET', url: '/api/activity?limit=10' })).json();
    expect(rawAll.events.map((event: { severity: string }) => event.severity)).toContain('debug');
    const infoUp = (await ui.inject({ method: 'GET', url: '/api/activity?severity=info,warning,error&limit=10' })).json();
    expect(infoUp.events.every((event: { severity: string }) => event.severity !== 'debug')).toBe(true);
  });

  it('stays readable while an import holds the Vault, and before a Vault is chosen', async () => {
    const { collector, jobs, activity } = services();
    const transfer = {
      enterRequest: (access: string) => {
        if (access === 'vault-read') throw new CollectorError('vault_busy', '正在合併或復原資料，請稍後再讀取。');
        return () => undefined;
      },
    } as unknown as HttpAppOptions['transfer'];
    const merging = await createHttpApp({ sources: PRODUCT_SOURCES, collector, jobs, activity, ...(transfer ? { transfer } : {}) });
    cleanups.push(() => merging.close());
    expect((await merging.inject({ method: 'GET', url: '/api/documents' })).statusCode).toBe(409);
    for (const url of ['/api/activity', '/api/jobs', '/api/jobs/summary?since=2026-10-15T00:00:00%2B08:00']) {
      expect((await merging.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }

    const notReady = await createHttpApp({ sources: PRODUCT_SOURCES, collector, jobs, activity, notReady: () => '尚未設定 Vault。' });
    cleanups.push(() => notReady.close());
    expect((await notReady.inject({ method: 'GET', url: '/api/documents' })).statusCode).toBe(503);
    expect((await notReady.inject({ method: 'GET', url: '/api/activity' })).statusCode).toBe(200);
    const health = (await notReady.inject({ method: 'GET', url: '/api/health' })).json();
    expect(health.activityLog).toMatchObject({ state: 'ok', pending: 0, dropped: 0 });
  });

  it('answers the activity, summary and retry contract, and rejects malformed queries', async () => {
    const { collector, jobs, activity } = services([new CollectorError('no_subtitles', '這支影片沒有可取得的既有字幕。')]);
    const app = await createHttpApp({ sources: PRODUCT_SOURCES, collector, jobs, activity, agentToken: 'agent-token-for-tests' });
    cleanups.push(() => app.close());
    const headers = { authorization: 'Bearer agent-token-for-tests' };
    expect((await app.inject({ method: 'GET', url: '/api/activity' })).statusCode).toBe(401);

    const submitted = (await app.inject({ method: 'POST', url: '/api/items', headers, payload: { url: 'https://youtu.be/kkkkkkkkkkk' } })).json();
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
      sources: PRODUCT_SOURCES,
      profilePath: root,
      workspace: withYouTube({
        capture: { capture: async () => { throw new Error('unused'); } } as never,
        channelSource: { resolve: async () => { throw new Error('unused'); }, listVideos: async () => [] },
        searchBinary: 'unused', searchData: path.join(root, 'search'), exportFolder: path.join(root, 'exports'), backupFolder: path.join(root, 'backups'),
        createSearch: async () => ({ search: new UnavailableTranscriptSearch('test'), close: async () => undefined }),
      }),
      agentSettingsFile: path.join(root, 'agent-settings.json'),
      skillPath: path.resolve('skills/xr-collector-agent'), uiPort: 0,
    });
    cleanups.push(() => runtime.close());
    const { connection: { token, url } } = await (await fetch(`${runtime.server.url}/api/device/agent/connection`)).json() as { connection: { token: string; url: string } };
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
