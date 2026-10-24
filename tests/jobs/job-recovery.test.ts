import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyYtDlpError } from '../../src/plugins/youtube/ytdlp-capture.js';
import {
  type CollectionPolicy,
  DEFAULT_POLICY,
} from '../../src/plugins/youtube/settings.js';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import {
  CollectorError,
  type CollectionJob,
  type DocumentSummary,
  type SavedDocument,
} from '../../src/core/types.js';
import { JobManager, type JobLimits, type RetryPolicy } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { CollectionPause } from '../../src/core/collection-pause.js';
import type { DiscoveredYouTubeVideo, ResolvedYouTubeChannel, YouTubeSource, CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { readEventFiles } from '../activity/event-files.js';
import type {
  YouTubeVideoRef,
} from '../../src/plugins/youtube/url.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import type { CapturedDocument, SubscriptionTarget } from '../../src/plugins/types.js';
import type { DocumentKey } from '../../src/vault/document-paths.js';
import { type RecordedSubscription, SubscriptionRecorder } from '../support/subscription-recorder.js';
import { transcriptOf } from '../support/youtube-documents.js';

// Interrupted work continues after a restart. A "crash" flushes the job store and opens the same
// directory again without closing the manager: the atomic snapshot on disk is what a killed process
// leaves behind. The Vault and subscriptions are shared memory objects standing in for files that
// survive the restart. Each generation gets a source of its own, so held work of the old process
// never finishes.

const VAULT = '/vaults/recovery';
const T0 = new Date('2026-10-15T06:00:00.000Z');

const videoId = (index: number, prefix = 'r') => `${prefix}${String(index).padStart(10, '0')}`.slice(0, 11);
const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const network = () => new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。');

function captured(id: string): CapturedTranscript {
  return {
    videoId: id, sourceUrl: watchUrl(id), title: `影片 ${id}`, channelId: null, channelTitle: '測試頻道',
    publishedAt: null, languageCode: 'zh-Hant', languageName: null, subtitleKind: 'manual', bodyMarkdown: '正文',
  };
}

class MemoryVault implements DocumentVault {
  readonly documents = new Map<string, SavedDocument>();
  saves = 0;
  async getByKey({ sourceId }: DocumentKey) { return this.documents.get(sourceId) ?? null; }
  async add(item: CapturedDocument) {
    const capture = transcriptOf(item);
    this.saves += 1;
    const document: SavedDocument = {
      id: `youtube:${capture.videoId}`, type: 'Transcript', title: capture.title, sourceUrl: capture.sourceUrl,
      sourceType: 'youtube', sourceId: capture.videoId, publisher: { id: capture.channelId, name: capture.channelTitle },
      publishedAt: null, collectedAt: T0.toISOString(),
      youtube: { languageCode: capture.languageCode, languageName: null, subtitleKind: 'manual' }, bodyMarkdown: capture.bodyMarkdown,
    };
    this.documents.set(capture.videoId, document);
    return document;
  }
  async list(): Promise<DocumentSummary[]> { return []; }
  async read(id: string) { return [...this.documents.values()].find((document) => document.id === id) ?? null; }
}

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** Calls and failures shared by every generation of the source. */
interface Script {
  captures: string[];
  discoveries: number;
  resolves: number;
  captureFailures: Map<string, CollectorError[]>;
  discoverFailures: CollectorError[];
  resolveFailures: CollectorError[];
  channelVideos: Map<string, DiscoveredYouTubeVideo[]>;
}

/** One process's YouTube source; held steps wait until this generation releases them. */
class ScriptedSource implements YouTubeSource {
  readonly held = new Map<string, () => void>();
  holdCaptures = new Set<string>();
  holdAllCaptures = false;
  holdDiscovery = false;
  holdResolve = false;

  constructor(private readonly script: Script) {}

  async resolveChannel(url: string): Promise<ResolvedYouTubeChannel> {
    this.script.resolves += 1;
    if (this.holdResolve) await never();
    const failure = this.script.resolveFailures.shift();
    if (failure) throw failure;
    const handle = url.split('/').pop()!.replace('@', '');
    const id = `UC${handle.padEnd(22, 'x')}`.slice(0, 24);
    return { id, title: `頻道 ${handle}`, url: `https://www.youtube.com/channel/${id}/videos` };
  }

  async discover(channel: SubscriptionTarget, page: { offset: number; limit: number }): Promise<DiscoveredYouTubeVideo[]> {
    this.script.discoveries += 1;
    if (this.holdDiscovery) await never();
    const failure = this.script.discoverFailures.shift();
    if (failure) throw failure;
    return (this.script.channelVideos.get(channel.id) ?? []).slice(page.offset, page.offset + page.limit);
  }

  async capture(video: YouTubeVideoRef): Promise<CapturedTranscript> {
    this.script.captures.push(video.videoId);
    if (this.holdAllCaptures || this.holdCaptures.has(video.videoId)) {
      await new Promise<void>((resolve) => this.held.set(video.videoId, resolve));
    }
    const failure = this.script.captureFailures.get(video.videoId)?.shift();
    if (failure) throw failure;
    return captured(video.videoId);
  }

  release(id: string): void {
    const resolve = this.held.get(id);
    if (!resolve) throw new Error(`capture ${id} is not waiting`);
    this.held.delete(id);
    resolve();
  }
}

interface Timer { ms: number; run: () => void; cancelled: boolean }

interface Generation {
  store: JobStore;
  manager: JobManager;
  source: ScriptedSource;
  timers: Timer[];
  /** Runs every timer that is due and not cancelled. */
  fireTimers(): void;
}

let directories: string[] = [];
let stores: JobStore[] = [];
afterEach(async () => {
  for (const store of stores) await store.flush();
  for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  directories = [];
  stores = [];
});

async function world(options: { limits?: Partial<JobLimits>; retry?: Partial<RetryPolicy>; pause?: CollectionPause } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xr-recovery-'));
  directories.push(directory);
  const vault = new MemoryVault();
  const subs = new SubscriptionRecorder();
  const script: Script = {
    captures: [], discoveries: 0, resolves: 0, captureFailures: new Map(), discoverFailures: [], resolveFailures: [], channelVideos: new Map(),
  };
  const clock = { now: new Date(T0) };
  let sequence = 0;
  let indexHangs = false;

  async function boot(prepare: (source: ScriptedSource) => void = () => undefined): Promise<Generation> {
    const store = await JobStore.open(directory, () => clock.now);
    stores.push(store);
    const source = new ScriptedSource(script);
    prepare(source);
    const hangIndex = indexHangs;
    const search = { index: async () => { if (hangIndex) await never(); } };
    const timers: Timer[] = [];
    const manager = new JobManager({
      vaultPath: VAULT, store, plugins: [youtubePlugin(source)], documents: new Collector(vault, search), subscriptions: subs,
      limits: { discovery: 1, capture: 1, ...options.limits },
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.pause ? { pause: options.pause } : {}),
      now: () => clock.now,
      createId: () => `job-${++sequence}`,
      setTimer: (run, ms) => {
        const timer: Timer = { ms, run, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
    });
    subs.attach(manager);
    return {
      store, manager, source, timers,
      fireTimers() {
        for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
      },
    };
  }

  return {
    directory, vault, subs, script, clock, boot,
    setIndexHangs(value: boolean) { indexHangs = value; },
    /** Leaves the generation as a killed process would and starts the next one. */
    async crash(previous: Generation, prepare?: (source: ScriptedSource) => void): Promise<Generation> {
      await previous.store.flush();
      const next = await boot(prepare);
      await next.manager.resume();
      return next;
    },
    /** Closes the generation and starts the next one. */
    async restart(previous: Generation, prepare?: (source: ScriptedSource) => void): Promise<Generation> {
      await previous.manager.close();
      const next = await boot(prepare);
      await next.manager.resume();
      return next;
    },
    async events(): Promise<Array<{
      eventType: string; jobId: string | null; errorCode?: string; attempt?: number; nextAttemptAt?: string; stopReason?: string; message: string;
    }>> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return readEventFiles(directory);
    },
  };
}

/** Subscribes to the channel in the recorder every generation shares. */
function subscribe(subs: SubscriptionRecorder, id: string): RecordedSubscription {
  return subs.add('youtube', { id, title: `頻道 ${id}`, url: `https://www.youtube.com/channel/${id}/videos` }, {
    settings: { intervalMinutes: 30, backfillDays: 60, backfillMaxItems: 50 },
  });
}

/** The one subscription the recorder holds. */
function onlySubscription(subs: SubscriptionRecorder): RecordedSubscription {
  expect(subs.subscriptions.size).toBe(1);
  return [...subs.subscriptions.values()][0]!;
}

function listed(count: number, prefix: string): DiscoveredYouTubeVideo[] {
  return Array.from({ length: count }, (_, index) => {
    const id = videoId(index, prefix);
    return { id, title: `影片 ${id}`, url: watchUrl(id), publishedAt: null, upcoming: false };
  });
}

describe('restart compatibility (R-T1)', () => {
  it('reads a jobs file without recovery fields and resumes it, except work a later job took over', async () => {
    const w = await world();
    const base = {
      vaultPath: VAULT, parentId: null, startedAt: T0.toISOString(), finishedAt: null, updatedAt: T0.toISOString(),
      progress: null, items: null, result: null, error: null,
    };
    const legacy: CollectionJob[] = [
      { ...base, id: 'old-channel', kind: 'youtube.channel', state: 'interrupted', phase: 'discover',
        source: { type: 'youtube', id: 'UC-legacy', url: 'https://www.youtube.com/channel/UC-legacy/videos', title: '舊頻道' },
        createdAt: '2026-10-01T00:00:00.000Z', scope: { trigger: 'manual' }, error: { code: 'interrupted', message: '服務停止。' } },
      { ...base, id: 'new-channel', kind: 'youtube.channel', state: 'completed', phase: 'capture',
        source: { type: 'youtube', id: 'UC-legacy', url: 'https://www.youtube.com/channel/UC-legacy/videos', title: '舊頻道' },
        createdAt: '2026-10-02T00:00:00.000Z', scope: { trigger: 'manual' }, result: { outcome: 'empty' } },
      { ...base, id: 'running-video', kind: 'youtube.video', state: 'running', phase: 'capture',
        source: { type: 'youtube', id: videoId(1), url: watchUrl(videoId(1)), title: null }, createdAt: '2026-10-03T00:00:00.000Z' },
      { ...base, id: 'interrupted-video', kind: 'youtube.video', state: 'interrupted', phase: null,
        source: { type: 'youtube', id: videoId(2), url: watchUrl(videoId(2)), title: null }, createdAt: '2026-10-03T00:00:01.000Z',
        error: { code: 'interrupted', message: '服務停止。' } },
    ];
    subscribe(w.subs, 'UC-legacy');
    await writeFile(path.join(w.directory, 'jobs.json'), `${JSON.stringify({ version: 1, jobs: legacy })}\n`);

    const g = await w.boot();
    await g.manager.resume();
    const [running, interrupted] = await Promise.all([
      g.manager.whenSettled('running-video'), g.manager.whenSettled('interrupted-video'),
    ]);

    expect(running).toMatchObject({ state: 'completed', result: { outcome: 'created' }, recovery: { resumedCount: 1, uncleanStops: 1 } });
    expect(interrupted).toMatchObject({ state: 'completed', result: { outcome: 'created' }, recovery: { resumedCount: 1, uncleanStops: 0 } });
    expect(g.manager.get('old-channel')).toMatchObject({ state: 'completed', result: { outcome: 'skipped', skipReason: 'superseded' } });
    expect(w.script.discoveries).toBe(0);
    expect(running).not.toHaveProperty('checkpoint');
    const resumed = (await w.events()).filter((event) => event.eventType === 'job.resumed');
    expect(Object.fromEntries(resumed.map((event) => [event.jobId, event.stopReason]))).toEqual({
      'running-video': 'crash', 'interrupted-video': 'unknown',
    });
    await g.store.flush();
    const onDisk = JSON.parse(await readFile(path.join(w.directory, 'jobs.json'), 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.jobs.find((job: CollectionJob) => job.id === 'running-video').checkpoint).toMatchObject({ savedDocumentId: `youtube:${videoId(1)}` });
  });
});

describe('video jobs across restarts (R-T2)', () => {
  it('captures again only the video whose capture was cut short, and keeps queue order', async () => {
    const w = await world();
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const first = await g1.manager.submitItem('youtube', watchUrl(videoId(1)));
    const second = await g1.manager.submitItem('youtube', watchUrl(videoId(2)));
    await vi.waitFor(() => expect(g1.source.held.has(videoId(1))).toBe(true));

    const g2 = await w.crash(g1);
    const [a, b] = await Promise.all([g2.manager.whenSettled(first.job.id), g2.manager.whenSettled(second.job.id)]);

    expect(a).toMatchObject({ state: 'completed', result: { outcome: 'created' }, recovery: { uncleanStops: 1 } });
    expect(b).toMatchObject({ state: 'completed', result: { outcome: 'created' }, recovery: { uncleanStops: 0 } });
    expect(w.script.captures).toEqual([videoId(1), videoId(1), videoId(2)]);
    const events = await w.events();
    expect(events.filter((event) => event.jobId === first.job.id).map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'job.accepted', 'job.started', 'job.interrupted', 'job.resumed', 'document.saved', 'job.completed',
    ]));
    expect(events.find((event) => event.jobId === first.job.id && event.eventType === 'job.resumed'))
      .toMatchObject({ stopReason: 'crash', message: '服務異常結束後重新啟動，接續收集工作。' });
  });

  it('only updates the index of a document saved before the restart', async () => {
    const w = await world();
    w.setIndexHangs(true);
    const g1 = await w.boot();
    const accepted = await g1.manager.submitItem('youtube', watchUrl(videoId(3)));
    await vi.waitFor(() => expect(g1.manager.get(accepted.job.id).phase).toBe('index'));

    w.setIndexHangs(false);
    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(accepted.job.id);

    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created', saved: true, indexed: true } });
    expect(w.script.captures).toEqual([videoId(3)]);
    expect(w.vault.saves).toBe(1);
  });
});

describe('channel-add jobs across restarts (R-T3)', () => {
  it('resolves again when stopped while resolving', async () => {
    const w = await world();
    const g1 = await w.boot((source) => { source.holdResolve = true; });
    const adding = await g1.manager.submit('youtube', 'https://www.youtube.com/@resume');
    await vi.waitFor(() => expect(g1.manager.get(adding.job.id).phase).toBe('resolve'));

    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(adding.job.id);

    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created', followUpJobId: expect.any(String) } });
    expect(w.subs.of('subscribed')).toEqual([expect.objectContaining({ outcome: 'created', resumed: false })]);
    expect(w.subs.subscriptions.size).toBe(1);
  });

  it('starts the first collection of a subscription it added just before the restart', async () => {
    const w = await world();
    w.subs.hangAfterSubscribe = true;
    const g1 = await w.boot();
    const adding = await g1.manager.submit('youtube', 'https://www.youtube.com/@halfway');
    await vi.waitFor(() => expect(w.subs.subscriptions.size).toBe(1));
    const subscribed = onlySubscription(w.subs);
    w.script.channelVideos.set(subscribed.id, listed(2, 'h'));

    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(adding.job.id);
    const followUp = await g2.manager.whenSettled(done.result!.followUpJobId!);

    expect(done.result).toMatchObject({ outcome: 'created', subscriptionId: subscribed.id });
    expect(followUp).toMatchObject({ state: 'completed', result: { outcome: 'created' }, progress: { created: 2 } });
    // The request hands its subscription over again as resumed, so the subscription found is its own.
    expect(w.subs.of('subscribed')).toEqual([{ kind: 'subscribed', type: 'youtube', id: subscribed.id, outcome: 'created', resumed: true }]);
    expect(w.subs.subscriptions.size).toBe(1);
    expect(w.script.resolves).toBe(1);
  });
});

describe('channel-add jobs with chosen settings across restarts (A3)', () => {
  it('subscribes with the settings chosen when the job was accepted after a stop while resolving', async () => {
    const w = await world();
    const chosen = { intervalMinutes: 180, backfillDays: 14, backfillMaxItems: 5 };
    const g1 = await w.boot((source) => { source.holdResolve = true; });
    const adding = await g1.manager.submitSubscriptionAdd('youtube', 'https://www.youtube.com/@chosen', chosen);
    // Its activity events are labelled as a first collection.
    expect(adding.job.scope).toEqual({ trigger: 'subscribe' });
    await vi.waitFor(() => expect(g1.manager.get(adding.job.id).phase).toBe('resolve'));

    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(adding.job.id);
    const followUp = await g2.manager.whenSettled(done.result!.followUpJobId!);

    expect(onlySubscription(w.subs).settings).toEqual(chosen);
    expect(followUp.scope).toEqual({ trigger: 'subscribe' });
    // The chosen settings serve the restart only; the job as UI and Agents read it has no checkpoint.
    expect(done).not.toHaveProperty('checkpoint');
  });
});

describe('channel-add jobs whose record carries no settings (A3)', () => {
  it('subscribes with the default settings', async () => {
    const w = await world();
    const g1 = await w.boot((source) => { source.holdResolve = true; });
    const adding = await g1.manager.submitSubscriptionAdd('youtube', 'https://www.youtube.com/@nosettings', { intervalMinutes: 180, backfillDays: 45, backfillMaxItems: 20 });
    await vi.waitFor(() => expect(g1.manager.get(adding.job.id).phase).toBe('resolve'));
    await g1.store.flush();
    const file = JSON.parse(await readFile(path.join(w.directory, 'jobs.json'), 'utf8'));
    for (const job of file.jobs) delete job.checkpoint;
    await writeFile(path.join(w.directory, 'jobs.json'), `${JSON.stringify(file)}\n`);
    const g2 = await w.boot();
    await g2.manager.resume();
    const done = await g2.manager.whenSettled(adding.job.id);
    await g2.manager.whenSettled(done.result!.followUpJobId!);
    expect(onlySubscription(w.subs).settings).toEqual(DEFAULT_POLICY);
  });
});

describe('channel-add jobs and the first scheduled check (R-T3)', () => {
  it('queues the first collection before the scheduler, so a check that is due at once joins it', async () => {
    const w = await world();
    w.subs.hangAfterSubscribe = true;
    const g1 = await w.boot();
    const adding = await g1.manager.submit('youtube', 'https://www.youtube.com/@duenow');
    await vi.waitFor(() => expect(w.subs.subscriptions.size).toBe(1));
    const subscribed = onlySubscription(w.subs);
    w.script.channelVideos.set(subscribed.id, listed(3, 'q'));

    await g1.store.flush();
    const g2 = await w.boot((source) => { source.holdDiscovery = true; });
    await g2.manager.resume();
    // The scheduler starts right after resume; its first check is due at once.
    const scheduled = await g2.manager.submitCheck('youtube', subscribed, 'scheduled');
    const added = g2.manager.get(adding.job.id);

    expect(added).toMatchObject({ state: 'completed', result: { outcome: 'created', followUpJobId: scheduled.job.id } });
    expect(scheduled).toMatchObject({ deduplicated: true, job: { scope: { trigger: 'subscribe' } } });
    expect(w.script.resolves).toBe(1);
  });
});

describe('channel jobs across restarts (R-T4)', () => {
  it('continues the recorded videos without discovering again, untruncated, and records its check (R-06)', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-resume-channel');
    w.script.channelVideos.set(subscribed.id, listed(6, 'c'));
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await vi.waitFor(() => expect(g1.source.held.has(videoId(0, 'c'))).toBe(true));
    g1.source.release(videoId(0, 'c'));
    await vi.waitFor(() => expect(g1.source.held.has(videoId(1, 'c'))).toBe(true));
    g1.source.release(videoId(1, 'c'));
    await vi.waitFor(() => expect(g1.manager.get(accepted.job.id).progress?.done).toBe(2));
    const childIds = g1.manager.get(accepted.job.id).items!.map((item) => item.jobId);

    const g2 = await w.crash(g1);
    // The scheduler's first check after a restart joins the resumed job, even after the limit was lowered.
    subscribed.settings = { ...subscribed.settings, backfillMaxItems: 5 };
    const scheduled = await g2.manager.submitCheck('youtube', subscribed, 'scheduled');
    const done = await g2.manager.whenSettled(accepted.job.id);

    expect(scheduled).toMatchObject({ deduplicated: true, job: { id: accepted.job.id } });
    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created' }, progress: { total: 6, done: 6, created: 6 }, recovery: { resumedCount: 1 } });
    expect(done.items!.map((item) => item.jobId)).toEqual(childIds);
    expect(w.script.discoveries).toBe(1);
    expect(w.script.captures.filter((id) => id === videoId(0, 'c'))).toHaveLength(1);
    expect(w.script.captures.filter((id) => id === videoId(1, 'c'))).toHaveLength(1);
    // Resuming reports the check's own discovery time again, with nothing new found.
    const keys = listed(6, 'c').map((video) => video.id);
    expect(w.subs.of('checked')).toEqual([
      { kind: 'checked', type: 'youtube', id: subscribed.id, at: T0.toISOString(), candidates: keys, collecting: keys },
      { kind: 'checked', type: 'youtube', id: subscribed.id, at: T0.toISOString() },
    ]);
  });

  it('records the check time a restart cut short', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-owed-check');
    w.script.channelVideos.set(subscribed.id, listed(2, 'o'));
    w.subs.hangOnChecked = true;
    const g1 = await w.boot();
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await vi.waitFor(() => expect(g1.manager.get(accepted.job.id).phase).toBe('capture'));
    expect(w.subs.of('checked')).toEqual([]);

    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(accepted.job.id);

    expect(done).toMatchObject({ state: 'completed', progress: { total: 2, created: 2 } });
    expect(w.script.discoveries).toBe(1);
    expect(w.subs.of('checked')).toEqual([{ kind: 'checked', type: 'youtube', id: subscribed.id, at: T0.toISOString() }]);
  });

  it('reports the discovery time of the check cut short, not the time of the restart', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-later-check');
    w.script.channelVideos.set(subscribed.id, listed(1, 'l'));
    w.subs.hangOnChecked = true;
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await vi.waitFor(() => expect(g1.manager.get(accepted.job.id).phase).toBe('capture'));
    w.clock.now = new Date('2026-10-15T07:00:00.000Z');

    const g2 = await w.crash(g1);
    await g2.manager.whenSettled(accepted.job.id);

    // The subscriptions keep a later check time they already hold; the job only says when its check was.
    expect(w.subs.of('checked')).toEqual([{ kind: 'checked', type: 'youtube', id: subscribed.id, at: T0.toISOString() }]);
  });

  it('discovers with the settings and time of the restart when stopped before recording videos (R-06)', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-rediscover');
    const videos = listed(3, 'd').map((video, index) => ({ ...video, publishedAt: new Date(T0.getTime() + index * 60_000).toISOString() }));
    w.script.channelVideos.set(subscribed.id, videos.reverse());
    const g1 = await w.boot((source) => { source.holdDiscovery = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await vi.waitFor(() => expect(g1.manager.get(accepted.job.id).phase).toBe('discover'));

    // While the service is down the limit is lowered and time moves on.
    subscribed.settings = { ...subscribed.settings, backfillDays: 7, backfillMaxItems: 5 };
    w.script.channelVideos.set(subscribed.id, [...listed(6, 'e'), ...videos]);
    w.clock.now = new Date(T0.getTime() + 3 * 24 * 60 * 60_000);
    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(accepted.job.id);

    expect(done).toMatchObject({ state: 'completed', progress: { total: 5, created: 5 }, scope: { trigger: 'manual' } });
    expect(done.items!.map((item) => item.sourceId)).toEqual(listed(5, 'e').map((video) => video.id));
    const child = g2.manager.get(done.items![0]!.jobId!);
    expect(child.publishedNotBefore).toBe(new Date(w.clock.now.getTime() - 7 * 24 * 60 * 60_000).toISOString());
    expect(w.subs.of('checked')).toEqual([expect.objectContaining({ at: w.clock.now.toISOString() })]);
  });
});

describe('subscriptions that stopped (R-T5)', () => {
  it('keeps a paused subscription paused and skips its unfinished videos', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-paused');
    w.script.channelVideos.set(subscribed.id, listed(3, 'p'));
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await vi.waitFor(() => expect(g1.source.held.has(videoId(0, 'p'))).toBe(true));
    await vi.waitFor(() => expect(w.subs.of('checked')).toHaveLength(1));
    subscribed.enabled = false;
    g1.manager.stopSubscription('youtube', subscribed.id, 'subscription_paused');

    const g2 = await w.crash(g1);
    const done = g2.manager.get(accepted.job.id);

    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'skipped', skipReason: 'subscription_paused' } });
    expect(done.items!.map((item) => item.skipReason)).toEqual(['subscription_paused', 'subscription_paused', 'subscription_paused']);
    expect(g2.manager.isBusy()).toBe(false);
    // A check skipped on resume reports nothing more to its subscription.
    expect(w.subs.of('checked')).toHaveLength(1);
    expect(w.script.captures).toEqual([videoId(0, 'p')]);
  });

  it('skips a removed subscription but finishes a video the user also submitted', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-removed');
    w.script.channelVideos.set(subscribed.id, listed(3, 'x'));
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await vi.waitFor(() => expect(g1.source.held.has(videoId(0, 'x'))).toBe(true));
    const claimed = await g1.manager.submitItem('youtube', watchUrl(videoId(2, 'x')));
    expect(claimed.deduplicated).toBe(true);
    w.subs.remove('youtube', subscribed.id);

    const g2 = await w.crash(g1);
    const video = await g2.manager.whenSettled(claimed.job.id);

    expect(g2.manager.get(accepted.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'skipped', skipReason: 'subscription_removed' } });
    expect(video).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(video).not.toHaveProperty('claimedByUser');
    expect(g2.store.get(claimed.job.id)).toMatchObject({ claimedByUser: true });
  });
});

describe('system sleep (#97)', () => {
  it('returns a step that fails while the system sleeps to the queue without spending an attempt', async () => {
    const pause = new CollectionPause();
    const w = await world({ pause });
    const id = videoId(5, 's');
    w.script.captureFailures.set(id, [network()]);
    const g = await w.boot((source) => { source.holdCaptures = new Set([id]); });
    const accepted = await g.manager.submitItem('youtube', watchUrl(id));
    await vi.waitFor(() => expect(g.source.held.has(id)).toBe(true));
    pause.set('sleep', true);
    // The request in flight at suspend loses the network in a dark wake.
    g.source.holdCaptures.clear();
    g.source.release(id);
    await vi.waitFor(() => expect(g.manager.get(accepted.job.id).state).toBe('queued'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(g.manager.get(accepted.job.id)).not.toHaveProperty('retry');
    expect(g.timers).toEqual([]);
    expect(w.script.captures).toEqual([id]);

    pause.set('sleep', false);
    const done = await g.manager.whenSettled(accepted.job.id);
    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(done).not.toHaveProperty('retry');
    expect(w.script.captures).toEqual([id, id]);
    expect((await w.events()).map((event) => event.eventType)).not.toContain('job.retry_scheduled');
  });

  it('starts no queued step and no retry while the system sleeps, and runs them after resume', async () => {
    const pause = new CollectionPause();
    const w = await world({ pause });
    const retried = videoId(6, 's');
    const queued = videoId(7, 's');
    w.script.captureFailures.set(retried, [network()]);
    const g = await w.boot();
    const first = await g.manager.submitItem('youtube', watchUrl(retried));
    await vi.waitFor(() => expect(g.manager.get(first.job.id).retry?.nextAttemptAt).toBeTruthy());
    pause.set('sleep', true);
    const second = await g.manager.submitItem('youtube', watchUrl(queued));
    // The retry wait ends while the system sleeps.
    g.fireTimers();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.script.captures).toEqual([retried]);
    expect([g.manager.get(first.job.id).state, g.manager.get(second.job.id).state]).toEqual(['queued', 'queued']);

    pause.set('sleep', false);
    const [doneFirst, doneSecond] = await Promise.all([g.manager.whenSettled(first.job.id), g.manager.whenSettled(second.job.id)]);
    expect([doneFirst.state, doneSecond.state]).toEqual(['completed', 'completed']);
    expect(doneFirst.retry).toMatchObject({ attempts: 1 });
    expect(w.script.captures.sort()).toEqual([retried, retried, queued].sort());
  });
});

describe('system sleep and Vault holds together (#97)', () => {
  it('starts queued work only once both the hold and the sleep pause are over, whichever ends first', async () => {
    const pause = new CollectionPause();
    const w = await world({ pause });
    const g = await w.boot();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    // The hold ends while the system still sleeps.
    pause.set('sleep', true);
    const releaseFirst = await g.manager.hold();
    const first = await g.manager.submitItem('youtube', watchUrl(videoId(8, 's')));
    releaseFirst();
    await settle();
    expect(w.script.captures).toEqual([]);
    pause.set('sleep', false);
    expect(await g.manager.whenSettled(first.job.id)).toMatchObject({ state: 'completed' });

    // The system wakes while the hold is still in force.
    const releaseSecond = await g.manager.hold();
    pause.set('sleep', true);
    const second = await g.manager.submitItem('youtube', watchUrl(videoId(9, 's')));
    pause.set('sleep', false);
    await settle();
    expect(w.script.captures).toEqual([videoId(8, 's')]);
    releaseSecond();
    expect(await g.manager.whenSettled(second.job.id)).toMatchObject({ state: 'completed' });
  });
});

describe('automatic retries (R-T6, R-T7)', () => {
  it('retries a network failure and reports the attempts and the event', async () => {
    const w = await world();
    w.script.captureFailures.set(videoId(4), [network()]);
    const g = await w.boot();
    const accepted = await g.manager.submitItem('youtube', watchUrl(videoId(4)));
    await vi.waitFor(() => expect(g.manager.get(accepted.job.id).retry?.nextAttemptAt).toBeTruthy());

    expect(g.manager.get(accepted.job.id)).toMatchObject({
      state: 'queued', retry: { attempts: 1, maxAttempts: 3, nextAttemptAt: '2026-10-15T06:00:30.000Z', lastError: { code: 'network_error' } },
    });
    expect(g.timers.map((timer) => timer.ms)).toEqual([30_000]);
    g.fireTimers();
    const done = await g.manager.whenSettled(accepted.job.id);

    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created' }, retry: { attempts: 1, nextAttemptAt: null } });
    expect(w.script.captures).toEqual([videoId(4), videoId(4)]);
    const retried = (await w.events()).find((event) => event.eventType === 'job.retry_scheduled');
    expect(retried).toMatchObject({ jobId: accepted.job.id, errorCode: 'network_error', attempt: 1, nextAttemptAt: '2026-10-15T06:00:30.000Z' });
  });

  it('clears the wait from a channel item once its next attempt starts', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-item-retry');
    w.script.channelVideos.set(subscribed.id, listed(1, 'i'));
    const id = videoId(0, 'i');
    w.script.captureFailures.set(id, [network()]);
    const g = await w.boot((source) => { source.holdCaptures = new Set([id]); });
    const accepted = await g.manager.submitCheck('youtube', subscribed, 'manual');
    await vi.waitFor(() => expect(g.source.held.has(id)).toBe(true));
    g.source.release(id);
    await vi.waitFor(() => expect(g.manager.get(accepted.job.id).items![0]!.retry?.nextAttemptAt).toBe('2026-10-15T06:00:30.000Z'));

    g.fireTimers();
    await vi.waitFor(() => expect(g.source.held.has(id)).toBe(true));
    expect(g.manager.get(accepted.job.id).items![0]).toMatchObject({ state: 'queued', retry: { attempts: 1, nextAttemptAt: null } });
    g.source.release(id);
    expect(await g.manager.whenSettled(accepted.job.id)).toMatchObject({ state: 'completed', progress: { created: 1 } });
  });

  it.each([
    ['no_subtitles', '這支影片沒有可取得的既有字幕。'],
    ['video_unavailable', '這支影片目前無法存取。'],
    ['capture_failed', '字幕取得失敗，請稍後再試。'],
  ])('does not retry %s', async (code, message) => {
    const w = await world();
    w.script.captureFailures.set(videoId(5), [new CollectorError(code as 'no_subtitles', message)]);
    const g = await w.boot();
    const done = await g.manager.whenSettled((await g.manager.submitItem('youtube', watchUrl(videoId(5)))).job.id);

    expect(done).toMatchObject({ state: 'failed', error: { code, message } });
    expect(done.retry).toBeUndefined();
    expect(w.script.captures).toEqual([videoId(5)]);
  });

  it('classifies rate limiting as its own code, not a failed network attempt', () => {
    const error = classifyYtDlpError(new Error('Command failed'), 'ERROR: [youtube] abc: HTTP Error 429: Too Many Requests');
    expect(error.code).toBe('rate_limited');
  });

  it('retries channel discovery and channel resolution', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-flaky');
    w.script.channelVideos.set(subscribed.id, listed(1, 'f'));
    w.script.discoverFailures.push(network());
    w.script.resolveFailures.push(network());
    const g = await w.boot();
    const discovering = await g.manager.submitCheck('youtube', subscribed, 'manual');
    await vi.waitFor(() => expect(g.manager.get(discovering.job.id).retry?.nextAttemptAt).toBeTruthy());
    g.fireTimers();
    expect(await g.manager.whenSettled(discovering.job.id)).toMatchObject({ state: 'completed', retry: { attempts: 1 } });

    const adding = await g.manager.submit('youtube', 'https://www.youtube.com/@flakyadd');
    await vi.waitFor(() => expect(g.manager.get(adding.job.id).retry?.nextAttemptAt).toBeTruthy());
    g.fireTimers();
    expect(await g.manager.whenSettled(adding.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created' }, retry: { attempts: 1 } });
  });

  it('backs off, frees the slot while waiting, and keeps the attempt count across a restart', async () => {
    const w = await world();
    w.script.captureFailures.set(videoId(6), [network(), network(), network(), network()]);
    const g1 = await w.boot();
    const failing = await g1.manager.submitItem('youtube', watchUrl(videoId(6)));
    await vi.waitFor(() => expect(g1.manager.get(failing.job.id).retry?.attempts).toBe(1));
    // The only capture slot is free while the job waits.
    const other = await g1.manager.submitItem('youtube', watchUrl(videoId(7)));
    expect(await g1.manager.whenSettled(other.job.id)).toMatchObject({ state: 'completed' });
    g1.fireTimers();
    await vi.waitFor(() => expect(g1.manager.get(failing.job.id).retry?.attempts).toBe(2));
    expect(g1.timers.map((timer) => timer.ms)).toEqual([120_000]);
    expect(g1.manager.get(failing.job.id).retry?.nextAttemptAt).toBe('2026-10-15T06:02:00.000Z');

    w.clock.now = new Date('2026-10-15T06:01:00.000Z');
    const g2 = await w.restart(g1);
    expect(g2.manager.get(failing.job.id)).toMatchObject({ state: 'queued', retry: { attempts: 2 }, recovery: { resumedCount: 1, uncleanStops: 0 } });
    expect(g2.timers.map((timer) => timer.ms)).toEqual([60_000]);
    expect((await w.events()).find((event) => event.jobId === failing.job.id && event.eventType === 'job.resumed'))
      .toMatchObject({ stopReason: 'shutdown', message: '服務正常關閉後重新啟動，接續收集工作。' });
    g2.fireTimers();
    const done = await g2.manager.whenSettled(failing.job.id);

    expect(done).toMatchObject({
      state: 'failed', retry: { attempts: 3, maxAttempts: 3 },
      error: { code: 'network_error', message: '無法連線到 YouTube，請稍後再試。（已嘗試 3 次）' },
    });
    expect(w.script.captures.filter((id) => id === videoId(6))).toHaveLength(3);
  });
});

describe('repeated unclean stops (R-T8)', () => {
  it('stops resuming a job that keeps stopping the service mid-step, but not the work queued behind it', async () => {
    const w = await world();
    const hold = (source: ScriptedSource) => { source.holdCaptures = new Set([videoId(8)]); };
    let g = await w.boot(hold);
    const stuck = await g.manager.submitItem('youtube', watchUrl(videoId(8)));
    const queued = await g.manager.submitItem('youtube', watchUrl(videoId(9)));
    for (let stop = 1; stop <= 2; stop += 1) {
      const current = g;
      await vi.waitFor(() => expect(current.source.held.has(videoId(8))).toBe(true));
      g = await w.crash(g, hold);
      expect(g.manager.get(stuck.job.id).recovery?.uncleanStops).toBe(stop);
    }
    const third = g;
    await vi.waitFor(() => expect(third.source.held.has(videoId(8))).toBe(true));
    g = await w.crash(g, hold);

    expect(g.manager.get(stuck.job.id)).toMatchObject({
      state: 'failed', error: { code: 'interrupted_repeatedly' }, recovery: { uncleanStops: 3 },
    });
    expect(await g.manager.whenSettled(queued.job.id)).toMatchObject({ state: 'completed', recovery: { uncleanStops: 0, resumedCount: 3 } });
  });

  it('does not count clean shutdowns', async () => {
    const w = await world();
    w.script.captureFailures.set(videoId(10), [network()]);
    let g = await w.boot();
    const accepted = await g.manager.submitItem('youtube', watchUrl(videoId(10)));
    await vi.waitFor(() => expect(g.manager.get(accepted.job.id).retry?.attempts).toBe(1));
    for (let restart = 0; restart < 3; restart += 1) g = await w.restart(g);
    w.clock.now = new Date('2026-10-15T06:05:00.000Z');
    g = await w.restart(g);

    expect(await g.manager.whenSettled(accepted.job.id)).toMatchObject({
      state: 'completed', recovery: { resumedCount: 4, uncleanStops: 0 }, retry: { attempts: 1 },
    });
  });
});
