import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import {
  CollectorError,
  type CollectionJob,
  type DocumentSummary,
  type SavedDocument,
} from '../../src/core/types.js';
import { workStatus } from '../../src/jobs/job-board.js';
import { JobManager, checkActivity, type JobLimits } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import type { DiscoveredYouTubeVideo, ResolvedYouTubeChannel, YouTubeSource, CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { readEventFiles } from '../activity/event-files.js';
import type {
  YouTubeVideoRef,
} from '../../src/plugins/youtube/url.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import type { CapturedDocument, SubscriptionTarget } from '../../src/plugins/types.js';
import type { DocumentKey } from '../../src/vault/document-paths.js';
import { RecentTargets } from '../../src/subscriptions/recent-targets.js';
import { SubscriptionRecorder } from '../support/subscription-recorder.js';
import { transcriptOf } from '../support/youtube-documents.js';

const VAULT = '/vaults/a';

function videoId(index: number, prefix = 'v'): string {
  return `${prefix}${String(index).padStart(10, '0')}`.slice(0, 11);
}

function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

function captured(id: string): CapturedTranscript {
  return {
    videoId: id, sourceUrl: watchUrl(id), title: `影片 ${id}`, channelId: null, channelTitle: '測試頻道',
    publishedAt: null, languageCode: 'zh-Hant', languageName: null, subtitleKind: 'manual', bodyMarkdown: '正文',
  };
}

class MemoryVault implements DocumentVault {
  readonly documents = new Map<string, SavedDocument>();
  async getByKey({ sourceId }: DocumentKey) { return this.documents.get(sourceId) ?? null; }
  async add(item: CapturedDocument) {
    const capture = transcriptOf(item);
    const document: SavedDocument = {
      id: `youtube:${capture.videoId}`, type: 'Transcript', title: capture.title, sourceUrl: capture.sourceUrl,
      sourceType: 'youtube', sourceId: capture.videoId, publisher: { id: capture.channelId, name: capture.channelTitle },
      publishedAt: null, collectedAt: '2026-10-15T00:00:00.000Z',
      youtube: { languageCode: capture.languageCode, languageName: null, subtitleKind: 'manual' }, bodyMarkdown: capture.bodyMarkdown,
    };
    this.documents.set(capture.videoId, document);
    return document;
  }
  async list(): Promise<DocumentSummary[]> { return []; }
  async read(id: string) { return [...this.documents.values()].find((document) => document.id === id) ?? null; }
}

/** A YouTube source whose captures wait until the test releases them. */
class ControlledSource implements YouTubeSource {
  readonly captures: string[] = [];
  readonly pending = new Map<string, () => void>();
  readonly failures = new Map<string, CollectorError>();
  readonly channelVideos = new Map<string, DiscoveredYouTubeVideo[]>();
  holdCaptures = true;

  async resolveChannel(url: string): Promise<ResolvedYouTubeChannel> {
    const handle = url.split('/').pop()!.replace('@', '');
    const id = `UC${handle.padEnd(22, 'x')}`.slice(0, 24);
    return { id, title: `頻道 ${handle}`, url: `https://www.youtube.com/channel/${id}/videos` };
  }

  async discover(channel: SubscriptionTarget, page: { offset: number; limit: number }): Promise<DiscoveredYouTubeVideo[]> {
    return (this.channelVideos.get(channel.id) ?? []).slice(page.offset, page.offset + page.limit);
  }

  async capture(video: YouTubeVideoRef): Promise<CapturedTranscript> {
    this.captures.push(video.videoId);
    if (this.holdCaptures) await new Promise<void>((resolve) => this.pending.set(video.videoId, resolve));
    const failure = this.failures.get(video.videoId);
    if (failure) throw failure;
    return captured(video.videoId);
  }

  release(id: string): void {
    const resolve = this.pending.get(id);
    if (!resolve) throw new Error(`capture ${id} is not waiting`);
    this.pending.delete(id);
    resolve();
  }

  running(): string[] { return [...this.pending.keys()]; }
}

function setup(options: { limits?: Partial<JobLimits>; store?: JobStore; failIndex?: boolean; recentTargets?: RecentTargets } = {}) {
  const vault = new MemoryVault();
  const subs = new SubscriptionRecorder();
  const source = new ControlledSource();
  const search = {
    index: vi.fn(async () => { if (options.failIndex) throw new Error('meilisearch down'); }),
  };
  const store = options.store ?? JobStore.memory();
  let sequence = 0;
  const manager = new JobManager({
    vaultPath: VAULT, store, plugins: [youtubePlugin(source)], documents: new Collector(vault, search), subscriptions: subs,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.recentTargets ? { recentTarget: (type: string, url: string) => options.recentTargets!.get(type, url) } : {}),
    createId: () => `job-${++sequence}`,
  });
  subs.attach(manager);
  /** Subscribes to the channel and checks it once. */
  const collect = (target: SubscriptionTarget) => {
    // Listed videos carry no publish time, so they are all in range; the limit is the largest offered.
    const subscribed = subs.get('youtube', target.id)
      ?? subs.add('youtube', target, { settings: { intervalMinutes: 30, backfillWindow: '6m', backfillMaxItems: 50 } });
    return manager.submitCheck('youtube', subscribed, 'manual');
  };
  return { manager, vault, subs, source, search, store, collect };
}

function channel(id: string, title = id): SubscriptionTarget {
  return { id, title, url: `https://www.youtube.com/channel/${id}/videos` };
}

function videos(count: number, prefix: string): DiscoveredYouTubeVideo[] {
  return Array.from({ length: count }, (_, index) => {
    const id = videoId(index, prefix);
    return { id, title: `影片 ${id}`, url: watchUrl(id), publishedAt: null, upcoming: false };
  });
}

describe('JobManager', () => {
  it('accepts a video before capture finishes and reports saving and indexing separately', async () => {
    const { manager, source } = setup();
    const id = videoId(1);
    const submission = await manager.submitItem('youtube', `https://youtu.be/${id}?t=3`);
    expect(submission).toMatchObject({ deduplicated: false, job: { kind: 'youtube.video', state: 'queued', source: { id } } });

    await vi.waitFor(() => expect(manager.get(submission.job.id)).toMatchObject({ state: 'running', phase: 'capture' }));
    await vi.waitFor(() => expect(source.pending.has(id)).toBe(true));
    source.release(id);
    const job = await manager.whenSettled(submission.job.id);
    expect(job).toMatchObject({
      state: 'completed', phase: 'index', source: { title: `影片 ${id}` },
      result: { outcome: 'created', documentId: `youtube:${id}`, saved: true, indexed: true },
    });
  });

  it('keeps the saved document and marks the job when the index update fails', async () => {
    const { manager, source, vault } = setup({ failIndex: true });
    source.holdCaptures = false;
    const id = videoId(2);
    const job = await manager.whenSettled((await manager.submitItem('youtube', watchUrl(id))).job.id);
    expect(job).toMatchObject({ state: 'completed', result: { outcome: 'created', saved: true, indexed: false } });
    expect(job.result?.indexMessage).toBeTruthy();
    expect(vault.documents.has(id)).toBe(true);
  });

  it('returns the active job for a repeated video and captures it once', async () => {
    const { manager, source } = setup();
    const id = videoId(3);
    const first = await manager.submitItem('youtube', watchUrl(id));
    const repeated = await manager.submit('youtube', `https://youtu.be/${id}`);
    expect(repeated).toMatchObject({ deduplicated: true, job: { id: first.job.id } });

    await vi.waitFor(() => expect(source.running()).toEqual([id]));
    source.release(id);
    await manager.whenSettled(first.job.id);

    const again = await manager.submitItem('youtube', watchUrl(id));
    expect(again.deduplicated).toBe(false);
    expect(await manager.whenSettled(again.job.id)).toMatchObject({ result: { outcome: 'existing' } });
    expect(source.captures).toEqual([id]);
  });

  it('gives each channel its own job and links a video already being collected', async () => {
    const { manager, source, collect } = setup({ limits: { capture: 1 } });
    source.channelVideos.set('UC-A', videos(3, 'a'));
    source.channelVideos.set('UC-B', videos(2, 'b'));
    const manual = await manager.submitItem('youtube', watchUrl(videoId(1, 'a')));
    const a = await collect(channel('UC-A'));
    const b = await collect(channel('UC-B'));
    expect(b.job.id).not.toBe(a.job.id);
    expect((await collect(channel('UC-A'))).job.id).toBe(a.job.id);

    await vi.waitFor(() => expect(manager.get(b.job.id).items).toHaveLength(2));
    const aItems = manager.get(a.job.id).items!;
    expect(aItems.find((item) => item.sourceId === videoId(1, 'a'))?.jobId).toBe(manual.job.id);

    source.holdCaptures = false;
    for (const id of source.running()) source.release(id);
    const [doneA, doneB] = await Promise.all([manager.whenSettled(a.job.id), manager.whenSettled(b.job.id)]);
    expect(doneA).toMatchObject({ state: 'completed', progress: { total: 3, done: 3, created: 3 } });
    expect(doneB).toMatchObject({ state: 'completed', progress: { total: 2, done: 2, created: 2 } });
    expect(source.captures.filter((id) => id === videoId(1, 'a'))).toHaveLength(1);
  });

  it('bounds concurrent captures and rotates between the jobs that queued them', async () => {
    const { manager, source, collect } = setup({ limits: { capture: 2 } });
    source.channelVideos.set('UC-BIG', videos(20, 'g'));
    source.channelVideos.set('UC-OTHER', videos(2, 'o'));
    const big = await collect(channel('UC-BIG'));
    await vi.waitFor(() => expect(source.running()).toHaveLength(2));
    const manual = await manager.submitItem('youtube', watchUrl(videoId(1, 'm')));
    const other = await collect(channel('UC-OTHER'));
    await vi.waitFor(() => expect(manager.get(other.job.id).items).toHaveLength(2));

    const order: string[] = [];
    while (order.length < 6) {
      await vi.waitFor(() => expect(source.running().length).toBeGreaterThan(0));
      expect(source.running().length).toBeLessThanOrEqual(2);
      const next = source.running()[0]!;
      order.push(next);
      source.release(next);
    }
    // The manual video and the second channel start long before the large channel's 20 videos finish.
    expect(order.slice(0, 6)).toContain(videoId(1, 'm'));
    expect(order.slice(0, 6).some((id) => id.startsWith('o'))).toBe(true);
    expect(manager.get(big.job.id).state).toBe('running');

    source.holdCaptures = false;
    for (const id of source.running()) source.release(id);
    await Promise.all([manager.whenSettled(big.job.id), manager.whenSettled(manual.job.id), manager.whenSettled(other.job.id)]);
  });

  it('refuses new jobs once the waiting queue is full', async () => {
    const { manager, source } = setup({ limits: { capture: 1, maxQueued: 2 } });
    await manager.submitItem('youtube', watchUrl(videoId(1)));
    await vi.waitFor(() => expect(source.running()).toHaveLength(1));
    await manager.submitItem('youtube', watchUrl(videoId(2)));
    await manager.submitItem('youtube', watchUrl(videoId(3)));
    await expect(manager.submitItem('youtube', watchUrl(videoId(4)))).rejects.toMatchObject({ code: 'queue_full' });
  });

  it('completes a channel job with failed videos as partial and an empty listing as empty', async () => {
    const { manager, source, collect } = setup();
    source.holdCaptures = false;
    source.channelVideos.set('UC-PART', videos(2, 'p'));
    source.failures.set(videoId(0, 'p'), new CollectorError('no_subtitles', '這支影片沒有字幕。'));
    const partial = await manager.whenSettled((await collect(channel('UC-PART'))).job.id);
    expect(partial).toMatchObject({ state: 'completed', result: { outcome: 'partial' }, progress: { created: 1, failed: 1 } });
    expect(partial.items?.find((item) => item.state === 'failed')?.error).toMatchObject({ code: 'no_subtitles' });

    source.channelVideos.set('UC-NONE', []);
    expect(await manager.whenSettled((await collect(channel('UC-NONE'))).job.id))
      .toMatchObject({ state: 'completed', result: { outcome: 'empty' } });
  });

  it('adds a resolved channel and starts its collection as a follow-up job', async () => {
    const { manager, source, subs } = setup();
    source.holdCaptures = false;
    const added = await manager.submit('youtube', '@sample');
    expect(added.job).toMatchObject({ kind: 'youtube.channel-add', source: { id: null, url: 'https://www.youtube.com/@sample' } });
    const job = await manager.whenSettled(added.job.id);
    expect(job).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    const [subscribed] = subs.of('subscribed');
    expect(subs.of('subscribed')).toEqual([{ kind: 'subscribed', type: 'youtube', id: 'UCsamplexxxxxxxxxxxxxxxx', outcome: 'created', resumed: false }]);
    expect(subs.get('youtube', subscribed!.id)?.settings).toEqual({ intervalMinutes: 30, backfillWindow: '1m', backfillMaxItems: 10 });
    const followUp = await manager.whenSettled(job.result!.followUpJobId!);
    expect(followUp).toMatchObject({ kind: 'youtube.channel', source: { id: subscribed!.id }, result: { outcome: 'empty' } });
    expect(subs.of('checked')).toEqual([expect.objectContaining({ id: subscribed!.id, candidates: [], collecting: [] })]);
  });

  it('names a previewed subscription request from acceptance and subscribes to that target after the preview expires', async () => {
    let now = 0;
    const recentTargets = new RecentTargets(1000, () => now);
    const { manager, source, subs } = setup({ recentTargets });
    source.holdCaptures = false;
    const resolveChannel = source.resolveChannel.bind(source);
    let releaseBlocker!: () => void;
    const resolved: string[] = [];
    source.resolveChannel = async (url) => {
      resolved.push(url);
      if (url.endsWith('@blocker')) await new Promise<void>((resolve) => { releaseBlocker = resolve; });
      return resolveChannel(url);
    };
    const previewed = channel('UCpreviewedxxxxxxxxxxxxx', '預覽的頻道');
    recentTargets.remember('youtube', 'https://www.youtube.com/@previewed', previewed);

    // A request nobody previewed holds the single discovery slot, so the previewed one waits in the queue.
    const blocker = await manager.submit('youtube', '@blocker');
    await vi.waitFor(() => expect(manager.get(blocker.job.id).phase).toBe('resolve'));
    const added = await manager.submit('youtube', '@previewed');
    expect(added.job).toMatchObject({ state: 'queued', source: { id: null, title: '預覽的頻道' } });
    expect(manager.subscriptionWork('youtube').adds).toEqual([
      expect.objectContaining({ jobId: blocker.job.id, title: null }),
      expect.objectContaining({ jobId: added.job.id, title: '預覽的頻道' }),
    ]);

    now = 5000;
    expect(recentTargets.get('youtube', 'https://www.youtube.com/@previewed')).toBeUndefined();
    releaseBlocker();
    expect(await manager.whenSettled(added.job.id)).toMatchObject({
      state: 'completed', source: { id: previewed.id, title: '預覽的頻道' }, result: { subscriptionId: previewed.id },
    });
    expect(resolved).toEqual(['https://www.youtube.com/@blocker']);
    expect(subs.get('youtube', previewed.id)).toMatchObject({ title: '預覽的頻道', url: previewed.url });
  });

  it('rejects playlists and unknown addresses before accepting a job', async () => {
    const { manager } = setup();
    await expect(manager.submit('youtube', 'https://www.youtube.com/playlist?list=PL123')).rejects.toMatchObject({ code: 'unsupported_url' });
    await expect(manager.submit('youtube', 'https://example.com/watch?v=abcdefghijk')).rejects.toMatchObject({ code: 'invalid_url' });
    expect(manager.list().jobs).toEqual([]);
  });

  it('lists top-level jobs newest first with a cursor and hides another Vault', async () => {
    const store = JobStore.memory();
    const { manager, source } = setup({ store });
    source.holdCaptures = false;
    for (let index = 0; index < 3; index += 1) await manager.whenSettled((await manager.submitItem('youtube', watchUrl(videoId(index)))).job.id);
    const first = manager.list({ limit: 2 });
    expect(first.jobs.map((job) => job.source.id)).toEqual([videoId(2), videoId(1)]);
    expect(manager.list({ limit: 2, cursor: first.nextCursor! })).toMatchObject({ jobs: [{ source: { id: videoId(0) } }], nextCursor: null });

    const other = new JobManager({
      vaultPath: '/vaults/b', store, plugins: [youtubePlugin(source)], documents: new Collector(new MemoryVault()), subscriptions: new SubscriptionRecorder(),
    });
    expect(other.list().jobs).toEqual([]);
    expect(() => other.get(first.jobs[0]!.id)).toThrowError(expect.objectContaining({ code: 'job_not_found' }));
  });

  it('waits for running work on close and records queued work as interrupted', async () => {
    const { manager, source } = setup({ limits: { capture: 1 } });
    const running = await manager.submitItem('youtube', watchUrl(videoId(1)));
    const queued = await manager.submitItem('youtube', watchUrl(videoId(2)));
    await vi.waitFor(() => expect(source.running()).toEqual([videoId(1)]));
    expect(manager.isBusy()).toBe(true);

    const closing = manager.close();
    await expect(manager.submitItem('youtube', watchUrl(videoId(3)))).rejects.toMatchObject({ code: 'vault_busy' });
    source.release(videoId(1));
    await closing;
    expect(manager.isBusy()).toBe(false);
    expect(manager.get(running.job.id).state).toBe('completed');
    expect(manager.get(queued.job.id)).toMatchObject({ state: 'interrupted', error: { code: 'interrupted' } });
    expect(source.captures).toEqual([videoId(1)]);
  });

  it('records channel discovery and channel adding cut short by close as interrupted, not failed', async () => {
    const { manager, source, collect } = setup();
    let releaseDiscovery!: () => void;
    let releaseResolve!: () => void;
    source.discover = async () => {
      await new Promise<void>((resolve) => { releaseDiscovery = resolve; });
      return videos(3, 'c');
    };
    source.resolveChannel = async () => {
      await new Promise<void>((resolve) => { releaseResolve = resolve; });
      return { id: 'UC-LATE', title: '晚到的頻道', url: 'https://www.youtube.com/channel/UC-LATE/videos' };
    };
    const discovering = await collect(channel('UC-DISCOVER'));
    await vi.waitFor(() => expect(manager.get(discovering.job.id).phase).toBe('discover'));

    const closing = manager.close();
    releaseDiscovery();
    await closing;
    expect(manager.get(discovering.job.id)).toMatchObject({ state: 'interrupted', items: null, error: { code: 'interrupted' } });
    expect(source.captures).toEqual([]);

    const second = setup({ limits: { discovery: 1 } });
    second.source.resolveChannel = source.resolveChannel;
    const adding = await second.manager.submit('youtube', '@late');
    await vi.waitFor(() => expect(second.manager.get(adding.job.id).phase).toBe('resolve'));
    const closingSecond = second.manager.close();
    releaseResolve();
    await closingSecond;
    expect(second.manager.get(adding.job.id)).toMatchObject({ state: 'interrupted', error: { code: 'interrupted' } });
    expect(second.subs.subscriptions.size).toBe(0);
    expect(second.subs.of('subscribed')).toEqual([]);
  });
});

describe('workStatus', () => {
  const now = '2026-10-15T04:00:00.000Z';
  const later = '2026-10-15T05:00:00.000Z';
  const soon = '2026-10-15T04:30:00.000Z';
  const error = { code: 'network_error', message: '無法連線。' };
  const retry = { attempts: 1, maxAttempts: 3, nextAttemptAt: later, lastError: error };
  const check = (overrides: Partial<CollectionJob>): CollectionJob => ({
    id: 'j', kind: 'youtube.channel', state: 'running', phase: 'capture', vaultPath: VAULT, parentId: null,
    source: { type: 'youtube', id: 'UC1', url: 'https://www.youtube.com/channel/UC1', title: 'A' },
    createdAt: now, startedAt: now, finishedAt: null, updatedAt: now,
    progress: { total: 10, done: 3, created: 3, existing: 0, failed: 0 }, items: null, result: null, error: null, ...overrides,
  });
  const item = (state: 'queued' | 'running' | 'completed', extra = {}) => ({ sourceId: 'v', title: 'v', url: 'u', jobId: 'x', state, outcome: null, error: null, ...extra });
  const cooldown = (until = later) => ({ wait: { reason: 'rate_limited' as const, until } });
  const downloading = { state: 'downloading' };
  const failedRetry = { state: 'retrying', at: later, cause: { reason: 'failed', error, attempt: 2, maxAttempts: 3 } };

  it('is queued until the work starts, also while its source cools down', () => {
    expect(workStatus(check({ state: 'queued', startedAt: null, progress: null }))).toEqual({ state: 'queued' });
    expect(workStatus(check({ state: 'queued', startedAt: null, progress: null, ...cooldown() }))).toEqual({ state: 'queued' });
    expect(workStatus(check({ kind: 'youtube.video', state: 'queued', startedAt: null, progress: null }))).toEqual({ state: 'queued' });
  });

  it('checks until the check knows items to collect, and downloads after, whoever holds the capture slot', () => {
    expect(workStatus(check({ phase: 'discover', progress: null }))).toEqual({ state: 'checking' });
    expect(workStatus(check({ progress: { total: 0, done: 0, created: 0, existing: 0, failed: 0 } }))).toEqual({ state: 'checking' });
    // A started check waiting in line again, such as after a restart, does not go back to queued.
    expect(workStatus(check({ state: 'queued', phase: 'discover', progress: null }))).toEqual({ state: 'checking' });
    expect(workStatus(check({}))).toEqual(downloading);
    expect(workStatus(check({ items: [item('completed'), item('queued')] }))).toEqual(downloading);
    expect(workStatus(check({ items: [item('queued', cooldown()), item('running')] }))).toEqual(downloading);
    expect(workStatus(check({ items: [item('queued', cooldown()), item('queued')] }))).toEqual(downloading);
    expect(workStatus(check({ kind: 'youtube.video', progress: null }))).toEqual(downloading);
    expect(workStatus(check({ kind: 'youtube.channel-add', phase: 'resolve', progress: null }))).toEqual({ state: 'checking' });
  });

  it('retries while its own step waits for a retry or a cooldown', () => {
    expect(workStatus(check({ state: 'queued', retry }))).toEqual(failedRetry);
    expect(workStatus(check({ state: 'queued', phase: 'discover', progress: null, ...cooldown() })))
      .toEqual({ state: 'retrying', at: later, cause: { reason: 'rate_limited' } });
    expect(workStatus(check({ kind: 'youtube.video', state: 'queued', progress: null, retry }))).toEqual(failedRetry);
  });

  it('retries while every item it still collects waits, until the first of them goes on', () => {
    expect(workStatus(check({ items: [item('completed'), item('queued', { retry }), item('queued', cooldown(soon))] })))
      .toEqual({ state: 'retrying', at: soon, cause: { reason: 'rate_limited' } });
    expect(workStatus(check({ items: [item('queued', { retry })] }))).toEqual(failedRetry);
  });

  it('reports a check with its item progress', () => {
    expect(checkActivity(check({}))).toEqual({ jobId: 'j', status: downloading, done: 3, total: 10 });
    expect(checkActivity(check({ state: 'queued', startedAt: null, progress: null }))).toEqual({ jobId: 'j', status: { state: 'queued' }, done: 0, total: 0 });
  });
});

describe('JobStore', () => {
  let directory: string | null = null;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = null; });

  it('persists accepted jobs and events, and marks unfinished jobs interrupted on reopen', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'xr-jobs-'));
    const store = await JobStore.open(directory);
    const { manager, source, collect } = setup({ store, limits: { discovery: 1, capture: 1 } });
    source.channelVideos.set('UC-STOP', videos(2, 's'));
    const accepted = await collect(channel('UC-STOP', '停止中的頻道'));

    // Acceptance is durable before the HTTP response.
    const onDisk = JSON.parse(await readFile(path.join(directory, 'jobs.json'), 'utf8'));
    expect(onDisk.jobs.map((job: { id: string }) => job.id)).toContain(accepted.job.id);

    await vi.waitFor(() => expect(source.running()).toEqual([videoId(0, 's')]));
    source.release(videoId(0, 's'));
    await vi.waitFor(() => expect(manager.get(accepted.job.id).progress?.done).toBe(1));
    await store.flush();

    // A process that stops without closing leaves running and queued jobs on disk.
    const reopened = await JobStore.open(directory);
    const channelJob = reopened.get(accepted.job.id)!;
    expect(channelJob).toMatchObject({ state: 'interrupted', source: { title: '停止中的頻道' }, progress: { done: 1, created: 1 } });
    expect(channelJob.items?.map((item) => item.state)).toEqual(['completed', 'interrupted']);
    expect(reopened.list(VAULT).filter((job) => job.state === 'interrupted').length).toBeGreaterThanOrEqual(2);

    const events = await readEventFiles(directory);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'job.accepted', 'job.started', 'channel.discovered', 'document.saved', 'job.completed', 'job.interrupted',
    ]));
    expect(events[0]).toEqual(expect.objectContaining({ eventId: expect.any(String), timestamp: expect.any(String), vaultPath: VAULT }));
    source.release(videoId(1, 's'));
    await manager.close();
  });

  it('keeps interrupted jobs when finished jobs exceed the retention limit', () => {
    const store = JobStore.memory();
    const record = (id: string, state: 'completed' | 'interrupted', minute: number): CollectionJob => ({
      id, kind: 'youtube.video', state, phase: 'capture', vaultPath: VAULT, parentId: null,
      source: { type: 'youtube', id: null, url: watchUrl(videoId(minute)), title: null },
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(), startedAt: null, finishedAt: null,
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
      progress: null, items: null, result: null, error: null,
    });
    store.put(record('oldest-interrupted', 'interrupted', 0));
    store.put(record('oldest-completed', 'completed', 1));
    for (let index = 0; index < 1000; index += 1) store.put(record(`completed-${index}`, 'completed', 2 + index));

    expect(store.get('oldest-interrupted')).toMatchObject({ state: 'interrupted' });
    expect(store.get('oldest-completed')).toBeUndefined();
    expect(store.list(VAULT)).toHaveLength(1001);
  });

  it.each(['', '{"version":1,"jobs":"broken"}', '{"version":99,"jobs":[]}'])(
    'sets aside an unreadable jobs file %j and starts with no history',
    async (contents) => {
      directory = await mkdtemp(path.join(tmpdir(), 'xr-jobs-corrupt-'));
      await writeFile(path.join(directory, 'jobs.json'), contents);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const store = await JobStore.open(directory, () => new Date('2026-10-15T01:02:03.456Z'));
        expect(store.list(VAULT)).toEqual([]);
        expect(await readdir(directory)).toEqual(['jobs.json.corrupt-2026-10-15T01-02-03-456Z']);
        expect(await readFile(path.join(directory, 'jobs.json.corrupt-2026-10-15T01-02-03-456Z'), 'utf8')).toBe(contents);
        expect(error).toHaveBeenCalledOnce();

        const { manager, source } = setup({ store });
        source.holdCaptures = false;
        await manager.whenSettled((await manager.submitItem('youtube', watchUrl(videoId(9)))).job.id);
        await store.flush();
        expect(JSON.parse(await readFile(path.join(directory, 'jobs.json'), 'utf8')).jobs).toHaveLength(1);
      } finally {
        error.mockRestore();
      }
    },
  );
});
