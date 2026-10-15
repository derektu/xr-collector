import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import { CollectorError, type CapturedTranscript, type CollectionJob, type SavedDocument } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { createHttpApp } from '../../src/server/app.js';

const captured: CapturedTranscript = {
  videoId: 'dQw4w9WgXcQ',
  sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'HTTP 測試',
  channelId: null,
  channelTitle: '測試頻道',
  publishedAt: null,
  languageCode: 'zh-Hant',
  languageName: null,
  subtitleKind: 'automatic',
  bodyMarkdown: '內容',
};

function makeCollector(): Collector {
  return makeServices().collector;
}

/** Real job manager over an in-memory Vault; capture fails with the given error when supplied. */
function makeServices(captureFailure?: CollectorError, captureGate?: Promise<void>): { collector: Collector; jobs: JobManager } {
  let saved: SavedDocument | null = null;
  const vault: DocumentVault = {
    getBySourceId: async () => saved,
    add: async (input) => {
      saved = {
        id: `youtube:${input.videoId}`,
        type: 'Transcript',
        title: input.title,
        sourceUrl: input.sourceUrl,
        sourceId: input.videoId,
        channelId: input.channelId,
        channelTitle: input.channelTitle,
        publishedAt: input.publishedAt,
        collectedAt: '2026-09-17T00:00:00.000Z',
        languageCode: input.languageCode,
        languageName: input.languageName,
        subtitleKind: input.subtitleKind,
        bodyMarkdown: input.bodyMarkdown,
      };
      return saved;
    },
    list: async () => [],
    read: async () => saved,
  };
  const collector = new Collector(vault, { index: async () => undefined });
  const jobs = new JobManager({
    vaultPath: '/vault',
    store: JobStore.memory(),
    source: {
      resolveChannel: async () => ({ id: 'UC-http', title: 'HTTP 頻道', url: 'https://www.youtube.com/channel/UC-http/videos' }),
      discover: async () => [],
      capture: async () => {
        await captureGate;
        if (captureFailure) throw captureFailure;
        return captured;
      },
    },
    documents: collector,
    channels: { list: async () => [], add: async (channel) => channel, remove: async () => false, setEnabled: async () => null },
  });
  return { collector, jobs };
}

async function settledJob(app: FastifyInstance, id: string) {
  let job: CollectionJob;
  do {
    job = (await app.inject({ method: 'GET', url: `/api/jobs/${id}` })).json().job;
  } while (job.state === 'queued' || job.state === 'running');
  return job;
}

describe('HTTP app', () => {
  it('reads and updates the channel schedule through HTTP', async () => {
    const calls: unknown[] = [];
    const scheduleValue = {
      enabled: true,
      intervalMinutes: 15,
      status: 'scheduled' as const,
      lastAttemptAt: null,
      lastCompletedAt: null,
      nextRunAt: '2026-09-17T00:15:00.000Z',
      lastResult: null,
    };
    const schedule = {
      getSchedule: async () => scheduleValue,
      updateSchedule: async (input: { enabled: boolean; intervalMinutes: number }) => {
        calls.push(input);
        return { ...scheduleValue, ...input };
      },
    };
    const app = await createHttpApp({ collector: makeCollector(), schedule });

    const read = await app.inject({ method: 'GET', url: '/api/youtube/schedule' });
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/youtube/schedule',
      payload: { enabled: false, intervalMinutes: 60 },
    });
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/youtube/schedule',
      payload: { enabled: true, intervalMinutes: 0 },
    });

    expect(read.json()).toEqual({ schedule: scheduleValue });
    expect(updated.json()).toMatchObject({
      schedule: { enabled: false, intervalMinutes: 60 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('invalid_request');
    expect(calls).toEqual([{ enabled: false, intervalMinutes: 60 }]);
    await app.close();
  });

  it('manages channels and starts a channel collection run through HTTP', async () => {
    const savedChannel = {
      id: 'UC-channel-one',
      title: '頻道一',
      url: 'https://www.youtube.com/channel/UC-channel-one/videos',
      enabled: true,
      addedAt: '2026-09-17T00:00:00.000Z',
    };
    const run = {
      id: 'run-1',
      status: 'running' as const,
      channelIds: [savedChannel.id],
      currentChannelId: savedChannel.id,
      totalVideos: 2,
      processedVideos: 1,
      created: 1,
      existing: 0,
      failed: 0,
      results: [],
      startedAt: '2026-09-17T00:00:00.000Z',
      completedAt: null,
    };
    const job = (id: string): CollectionJob => ({
      id, kind: 'youtube.channel', state: 'queued', phase: null, vaultPath: '/vault', parentId: null,
      source: { type: 'youtube', id: savedChannel.id, url: savedChannel.url, title: savedChannel.title },
      createdAt: '2026-09-17T00:00:00.000Z', startedAt: null, finishedAt: null, updatedAt: '2026-09-17T00:00:00.000Z',
      progress: null, items: null, result: null, error: null,
    });
    const calls: unknown[] = [];
    const channels = {
      listChannels: async () => [savedChannel],
      addChannel: async (url: string) => {
        calls.push(['add', url]);
        return { job: { ...job('add-1'), kind: 'youtube.channel-add' as const }, deduplicated: false };
      },
      setChannelEnabled: async (id: string, enabled: boolean) => {
        calls.push(['enabled', id, enabled]);
        return { ...savedChannel, enabled };
      },
      removeChannel: async (id: string) => {
        calls.push(['remove', id]);
      },
      startRun: async (ids?: string[]) => {
        calls.push(['run', ids]);
        return [{ job: job('run-1'), deduplicated: false }];
      },
    };
    const app = await createHttpApp({ collector: makeCollector(), channels });

    const added = await app.inject({
      method: 'POST',
      url: '/api/youtube/channels',
      payload: { url: 'https://www.youtube.com/@channel-one' },
    });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/youtube/channels',
    });
    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/youtube/channels/${savedChannel.id}`,
      payload: { enabled: false },
    });
    const started = await app.inject({
      method: 'POST',
      url: '/api/youtube/channel-runs',
      payload: { channelIds: [savedChannel.id] },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/youtube/channels/${savedChannel.id}`,
    });

    expect(added.statusCode).toBe(202);
    expect(added.json()).toMatchObject({ deduplicated: false, job: { id: 'add-1', kind: 'youtube.channel-add' } });
    expect(listed.json()).toEqual({ channels: [savedChannel] });
    expect(disabled.json()).toMatchObject({ channel: { id: savedChannel.id, enabled: false } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ submissions: [{ deduplicated: false, job: { id: 'run-1', state: 'queued' } }] });
    expect(removed.json()).toEqual({ removed: true });
    expect(calls).toEqual([
      ['add', 'https://www.youtube.com/@channel-one'],
      ['enabled', savedChannel.id, false],
      ['run', [savedChannel.id]],
      ['remove', savedChannel.id],
    ]);
    await app.close();
  });

  it('searches transcript text with channel and published-date filters', async () => {
    const searchRequests: unknown[] = [];
    const search = {
      status: () => ({ state: 'ready' as const, indexedDocuments: 2 }),
      index: async () => undefined,
      search: async (request: unknown) => {
        searchRequests.push(request);
        return {
          hits: [
            {
              id: 'youtube:dQw4w9WgXcQ',
              title: '搜尋結果',
              channelTitle: '測試頻道',
              publishedAt: '2026-09-12T00:00:00.000Z',
              languageCode: 'zh-Hant',
              subtitleKind: 'manual' as const,
              snippet: '…符合條件的字幕內容…',
            },
          ],
          estimatedTotalHits: 1,
        };
      },
      rebuild: async () => undefined,
    };
    const app = await createHttpApp({ collector: makeCollector(), search });

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=%E6%A2%9D%E4%BB%B6&channel=%E6%B8%AC%E8%A9%A6%E9%A0%BB%E9%81%93&publishedFrom=2026-09-01&publishedTo=2026-09-30',
    });

    expect(response.statusCode).toBe(200);
    expect(searchRequests).toEqual([
      {
        query: '條件',
        channel: '測試頻道',
        publishedFrom: '2026-09-01',
        publishedTo: '2026-09-30',
      },
    ]);
    expect(response.json()).toEqual({
      hits: [
        expect.objectContaining({
          id: 'youtube:dQw4w9WgXcQ',
          snippet: '…符合條件的字幕內容…',
        }),
      ],
      estimatedTotalHits: 1,
    });
    await app.close();
  });

  it('rejects an invalid published-date filter before searching', async () => {
    let searchCount = 0;
    const search = {
      status: () => ({ state: 'ready' as const, indexedDocuments: 0 }),
      search: async () => {
        searchCount += 1;
        return { hits: [], estimatedTotalHits: 0 };
      },
      index: async () => undefined,
      rebuild: async () => undefined,
    };
    const app = await createHttpApp({ collector: makeCollector(), search });

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&publishedFrom=not-a-date',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    expect(searchCount).toBe(0);
    await app.close();
  });

  it('accepts a video with 202 and exposes its progress through the jobs API', async () => {
    const { collector, jobs } = makeServices();
    const app = await createHttpApp({ collector, jobs });
    const response = await app.inject({
      method: 'POST',
      url: '/api/youtube/collect',
      payload: { url: captured.sourceUrl },
    });

    expect(response.statusCode).toBe(202);
    const { job } = response.json() as { job: CollectionJob };
    expect(job).toMatchObject({ kind: 'youtube.video', state: 'queued', source: { id: 'dQw4w9WgXcQ' } });
    expect(await settledJob(app, job.id)).toMatchObject({
      state: 'completed',
      result: { outcome: 'created', documentId: 'youtube:dQw4w9WgXcQ', saved: true, indexed: true },
    });
    expect((await app.inject({ method: 'GET', url: '/api/jobs?state=all&limit=5' })).json()).toMatchObject({
      jobs: [{ id: job.id }], nextCursor: null,
    });
    await jobs.close();
    await app.close();
  });

  it('classifies a pasted address into a video or channel job', async () => {
    let release!: () => void;
    const { collector, jobs } = makeServices(undefined, new Promise<void>((resolve) => { release = resolve; }));
    const app = await createHttpApp({ collector, jobs });
    const submit = (url: string) => app.inject({ method: 'POST', url: '/api/youtube/submissions', payload: { url } });

    const video = await submit('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123');
    const repeated = await submit('https://youtu.be/dQw4w9WgXcQ');
    const channel = await submit('@http-channel');
    const playlist = await submit('https://www.youtube.com/playlist?list=PL123');

    expect(video.statusCode).toBe(202);
    expect(video.json()).toMatchObject({ deduplicated: false, job: { kind: 'youtube.video' } });
    expect(repeated.json()).toMatchObject({ deduplicated: true, job: { id: video.json().job.id } });
    expect(channel.json()).toMatchObject({ job: { kind: 'youtube.channel-add', source: { url: 'https://www.youtube.com/@http-channel' } } });
    expect(playlist.statusCode).toBe(400);
    expect(playlist.json().error.code).toBe('unsupported_url');
    release();
    await settledJob(app, video.json().job.id);
    await settledJob(app, channel.json().job.id);
    await jobs.close();
    await app.close();
  });

  it('reports a capture failure on the job with a stable error code', async () => {
    const { collector, jobs } = makeServices(new CollectorError('no_subtitles', '沒有字幕'));
    const app = await createHttpApp({ collector, jobs });
    const response = await app.inject({
      method: 'POST',
      url: '/api/youtube/collect',
      payload: { url: captured.sourceUrl },
    });

    expect(response.statusCode).toBe(202);
    expect(await settledJob(app, response.json().job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'no_subtitles', message: '沒有字幕' },
    });
    await jobs.close();
    await app.close();
  });

  it('rejects malformed requests without accepting a job', async () => {
    const { collector, jobs } = makeServices();
    const app = await createHttpApp({ collector, jobs });
    const empty = await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: {} });
    const channelAsVideo = await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: { url: '@channel' } });
    const badState = await app.inject({ method: 'GET', url: '/api/jobs?state=done' });
    const missing = await app.inject({ method: 'GET', url: '/api/jobs/unknown' });

    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('invalid_request');
    expect(channelAsVideo.json().error.code).toBe('invalid_url');
    expect(badState.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('job_not_found');
    expect(jobs.list().jobs).toEqual([]);
    await app.close();
  });
});
