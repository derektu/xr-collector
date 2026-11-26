import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Collector } from '../../../src/domain/vault/collector.js';
import type { DocumentVault } from '../../../src/shared/documents/document-vault.js';
import { NO_DELETIONS, unusedVaultWrite } from '../../support/document-vault-stubs.js';
import { CollectorError } from '../../../src/shared/lib/collector-error.js';
import type { DocumentSummary, SavedDocument } from '../../../src/shared/documents/document-types.js';
import type { CollectionJob } from '../../../src/shared/jobs/job-types.js';
import { JobManager, type JobLimits, type RetryPolicy } from '../../../src/domain/jobs/job-manager.js';
import { resumeInterrupted } from '../../../src/domain/jobs/job-recovery.js';
import type { JobStore } from '../../../src/domain/jobs/job-store.js';
import { openJobRecords, type JobRecords } from '../../../src/app/runtime/job-records.js';
import { CollectionPause } from '../../../src/shared/jobs/collection-pause.js';
import { Connectivity } from '../../../src/domain/jobs/connectivity.js';
import type { DiscoveredYouTubeVideo, ResolvedYouTubeChannel, YouTubeSource, CapturedTranscript } from '../../../src/domain/sources/youtube/adapter.js';
import { readEventFiles } from '../../support/event-files.js';
import type {
  YouTubeVideoRef,
} from '../../../src/domain/sources/youtube/url.js';
import { youtubePlugin } from '../../../src/domain/sources/youtube/server.js';
import type { CapturedDocument, SubscriptionTarget } from '../../../src/shared/sources/source-contract.js';
import type { DocumentKey } from '../../../src/shared/documents/document-types.js';
import { type RecordedSubscription, SubscriptionRecorder } from '../../support/subscription-recorder.js';
import { transcriptOf } from '../../support/youtube-documents.js';
import { HeldCaptures } from '../../support/held-captures.js';
import { eventually } from '../../support/wait.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';
import { timersAfter } from '../../support/timers.js';

// Interrupted work continues after a restart. A "crash" flushes the job store and opens the same
// directory again without closing the manager: the atomic snapshot on disk is what a killed process
// leaves behind. The Vault and subscriptions are shared memory objects standing in for files that
// survive the restart. Each generation gets a source of its own, so held work of the old process
// never finishes.

const VAULT = '/vaults/recovery';
const VAULT_ID = 'vault-id';
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
  readonly sources = PRODUCT_SOURCES;
  readonly documents = new Map<string, SavedDocument>();
  saves = 0;
  async getByKey({ sourceId }: DocumentKey) { return this.documents.get(sourceId) ?? null; }
  async add(item: CapturedDocument) {
    const capture = transcriptOf(item);
    this.saves += 1;
    const document: SavedDocument = {
      id: `youtube:${capture.videoId}`, type: 'Transcript', title: capture.title, sourceUrl: capture.sourceUrl,
      sourceType: 'youtube', sourceId: capture.videoId, publisher: { id: capture.channelId, name: capture.channelTitle },
      publishedAt: null, collectedAt: T0.toISOString(), status: 'published',
      youtube: { languageCode: capture.languageCode, languageName: null, subtitleKind: 'manual' }, bodyMarkdown: capture.bodyMarkdown,
    };
    this.documents.set(capture.videoId, document);
    return document;
  }
  async list(): Promise<DocumentSummary[]> { return []; }
  async read(id: string) { return [...this.documents.values()].find((document) => document.id === id) ?? null; }
  readonly remove = unusedVaultWrite;
  readonly writeStatus = unusedVaultWrite;
  readonly deletions = NO_DELETIONS;
  readonly now = () => new Date();
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
  readonly holds = new HeldCaptures();
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
      await this.holds.hold(video.videoId);
    }
    const failure = this.script.captureFailures.get(video.videoId)?.shift();
    if (failure) throw failure;
    return captured(video.videoId);
  }

  release(id: string): void {
    this.holds.release(id);
  }
}

interface Timer { ms: number; run: () => void; cancelled: boolean }

interface Generation {
  store: JobStore;
  records: JobRecords;
  manager: JobManager;
  source: ScriptedSource;
  timers: Timer[];
  /** Runs every timer that is due and not cancelled. */
  fireTimers(): void;
  /**
   * Resolves once the steps already running have finished. While collection is held or paused no
   * step starts, so a test that waits here and finds nothing started knows nothing will start until
   * the hold or pause ends.
   */
  quiet(): Promise<void>;
}

let directories: string[] = [];
let stores: JobRecords[] = [];
afterEach(async () => {
  for (const store of stores) await store.close();
  for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  directories = [];
  stores = [];
});

async function world(options: { limits?: Partial<JobLimits>; retry?: Partial<RetryPolicy>; pause?: CollectionPause; connectivity?: Connectivity } = {}) {
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
    const records = await openJobRecords(directory, PRODUCT_SOURCES, { now: () => clock.now });
    const store = records.jobs;
    stores.push(records);
    const source = new ScriptedSource(script);
    prepare(source);
    const hangIndex = indexHangs;
    const search = { index: async () => { if (hangIndex) await never(); } };
    const timers: Timer[] = [];
    const manager = new JobManager({
      sources: PRODUCT_SOURCES,
      vaultPath: VAULT, vaultId: VAULT_ID, store, plugins: [youtubePlugin(source)], documents: new Collector(vault, search), subscriptions: subs,
      limits: { discovery: 1, capture: 1, ...options.limits },
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.pause ? { pause: options.pause } : {}),
      ...(options.connectivity ? { connectivity: options.connectivity } : {}),
      now: () => clock.now,
      createId: () => `job-${++sequence}`,
      timers: timersAfter((ms, run) => {
        const timer: Timer = { ms, run, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      }),
    });
    subs.attach(manager);
    return {
      store, records, manager, source, timers,
      fireTimers() {
        for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
      },
      async quiet() {
        (await manager.hold())();
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
      for (const records of stores) await records.activity.flush();
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

describe('video jobs across restarts (R-T2)', () => {
  it('captures again only the video whose capture was cut short, and keeps queue order', async () => {
    const w = await world();
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const first = await g1.manager.submitItem('youtube', watchUrl(videoId(1)));
    const second = await g1.manager.submitItem('youtube', watchUrl(videoId(2)));
    await g1.source.holds.started(videoId(1));

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
      .toMatchObject({ severity: 'info', stopReason: 'crash', message: '服務異常結束後重新啟動，接續收集工作。' });
    expect(events.find((event) => event.jobId === first.job.id && event.eventType === 'job.interrupted'))
      .toMatchObject({ severity: 'warning' });
  });

  it('only updates the index of a document saved before the restart', async () => {
    const w = await world();
    w.setIndexHangs(true);
    const g1 = await w.boot();
    const accepted = await g1.manager.submitItem('youtube', watchUrl(videoId(3)));
    await eventually(() => expect(g1.manager.get(accepted.job.id).phase).toBe('index'));

    w.setIndexHangs(false);
    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(accepted.job.id);

    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created', saved: true, indexed: true } });
    expect(w.script.captures).toEqual([videoId(3)]);
    expect(w.vault.saves).toBe(1);
  });
});

describe('subscription requests across restarts start over (R-T3)', () => {
  it.each([
    ['stopped while resolving, subscribes once it resolves again', false, 'created'],
    ['stopped after it subscribed, finds the subscription already listed', true, 'existing'],
  ] as const)('a request %s', async (_name, afterSubscribe, outcome) => {
    const w = await world();
    w.subs.hangAfterSubscribe = afterSubscribe;
    const g1 = await w.boot((source) => { source.holdResolve = !afterSubscribe; });
    const adding = await g1.manager.submit('youtube', 'https://www.youtube.com/@restart');
    await eventually(() => expect(w.script.resolves + w.subs.subscriptions.size).toBe(afterSubscribe ? 2 : 1));

    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(adding.job.id);

    expect(done).toMatchObject({ state: 'completed', result: { outcome } });
    expect(w.script.resolves).toBe(2);
    expect(w.subs.subscriptions.size).toBe(1);
  });

  it('subscribes with the settings chosen when the job was accepted', async () => {
    const w = await world();
    const chosen = { intervalMinutes: 180, backfillDays: 14, backfillMaxItems: 5 };
    const g1 = await w.boot((source) => { source.holdResolve = true; });
    const adding = await g1.manager.submitSubscriptionAdd('youtube', 'https://www.youtube.com/@chosen', chosen);
    // Its activity events are labelled as a first collection.
    expect(adding.job.scope).toEqual({ trigger: 'subscribe' });
    await eventually(() => expect(g1.manager.get(adding.job.id).phase).toBe('resolve'));

    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(adding.job.id);
    const followUp = await g2.manager.whenSettled(done.result!.followUpJobId!);

    expect(onlySubscription(w.subs).settings).toEqual(chosen);
    expect(followUp.scope).toEqual({ trigger: 'subscribe' });
    // The chosen settings serve the restart only; the job as UI and Agents read it has no checkpoint.
    expect(done).not.toHaveProperty('checkpoint');
  });
});

describe('checks across restarts start over (R-T4)', () => {
  it('lists again, saves each video once whether the restart caught it saved, capturing or queued, and ends once', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-resume-channel');
    w.script.channelVideos.set(subscribed.id, listed(4, 'c'));
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await g1.source.holds.started(videoId(0, 'c'));
    g1.source.release(videoId(0, 'c'));
    await g1.source.holds.started(videoId(1, 'c'));

    const g2 = await w.crash(g1);
    const done = await g2.manager.whenSettled(accepted.job.id);

    await Promise.all(g1.manager.get(accepted.job.id).items!.map((item) => g2.manager.whenSettled(item.jobId!)));

    expect(done).toMatchObject({ state: 'completed', recovery: { resumedCount: 1 } });
    expect(w.script.discoveries).toBe(2);
    expect(w.script.captures.filter((id) => id === videoId(0, 'c'))).toHaveLength(1);
    expect([...w.vault.documents.keys()].sort()).toEqual(listed(4, 'c').map((video) => video.id).sort());
    expect(w.vault.saves).toBe(4);
    expect(w.subs.of('ended')).toEqual([
      { kind: 'ended', type: 'youtube', id: subscribed.id, at: done.finishedAt, errorCode: null, failureClass: null, counted: true },
    ]);
  });

  it('stops the items a restart resumed when their subscription is removed, even if the new listing no longer finds them', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-orphan-items');
    w.script.channelVideos.set(subscribed.id, listed(2, 'o'));
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await g1.source.holds.started(videoId(0, 'o'));
    const itemIds = g1.manager.get(accepted.job.id).items!.map((item) => item.jobId!);

    w.script.channelVideos.set(subscribed.id, []);
    const g2 = await w.crash(g1, (source) => { source.holdAllCaptures = true; });
    await g2.manager.whenSettled(accepted.job.id);
    await g2.source.holds.started(videoId(0, 'o'));

    g2.manager.stopSubscription('youtube', subscribed.id, 'subscription_removed');
    g2.source.release(videoId(0, 'o'));
    const items = await Promise.all(itemIds.map((id) => g2.manager.whenSettled(id)));

    expect(items.map((item) => item.result)).toEqual([
      { outcome: 'skipped', skipReason: 'subscription_removed' },
      { outcome: 'skipped', skipReason: 'subscription_removed' },
    ]);
    expect(w.vault.saves).toBe(0);
  });

  it('discovers with the settings and time of the restart (R-06)', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-rediscover');
    const videos = listed(3, 'd').map((video, index) => ({ ...video, publishedAt: new Date(T0.getTime() + index * 60_000).toISOString() }));
    w.script.channelVideos.set(subscribed.id, videos.reverse());
    const g1 = await w.boot((source) => { source.holdDiscovery = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await eventually(() => expect(g1.manager.get(accepted.job.id).phase).toBe('discover'));

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
    expect(w.subs.of('ended')).toEqual([expect.objectContaining({ at: w.clock.now.toISOString(), errorCode: null })]);
  });
});

describe('subscriptions that stopped before a restart (R-T5)', () => {
  it.each([
    ['paused', 'subscription_paused', (subs: SubscriptionRecorder, subscribed: RecordedSubscription) => { subscribed.enabled = false; }],
    ['removed', 'subscription_removed', (subs: SubscriptionRecorder, subscribed: RecordedSubscription) => subs.remove('youtube', subscribed.id)],
  ] as const)('a %s subscription skips its interrupted check and the videos it queued, also one the user submitted', async (_name, reason, stop) => {
    const w = await world();
    const subscribed = subscribe(w.subs, `UC-${reason}`);
    w.script.channelVideos.set(subscribed.id, listed(3, 'p'));
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await g1.source.holds.started(videoId(0, 'p'));
    const submitted = await g1.manager.submitItem('youtube', watchUrl(videoId(2, 'p')));
    expect(submitted.deduplicated).toBe(true);
    stop(w.subs, subscribed);

    const g2 = await w.crash(g1);

    expect(g2.manager.get(accepted.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'skipped', skipReason: reason } });
    for (const item of g1.manager.get(accepted.job.id).items!) {
      expect(g2.manager.get(item.jobId!)).toMatchObject({ state: 'completed', result: { outcome: 'skipped', skipReason: reason } });
    }
    expect(g2.manager.isBusy()).toBe(false);
    expect(w.script.captures).toEqual([videoId(0, 'p')]);
  });

  it.each([
    ['paused', 'subscription_paused', 1, (subs: SubscriptionRecorder, subscribed: RecordedSubscription) => { subscribed.enabled = false; }],
    ['removed', 'subscription_removed', 0, (subs: SubscriptionRecorder, subscribed: RecordedSubscription) => subs.remove('youtube', subscribed.id)],
  ] as const)('a subscription %s while its restarted check lists again skips the videos restored from before the restart', async (_name, reason, saves, stop) => {
    const w = await world();
    const subscribed = subscribe(w.subs, `UC-relist-${reason}`);
    w.script.channelVideos.set(subscribed.id, listed(3, 'q'));
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const accepted = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await g1.source.holds.started(videoId(0, 'q'));
    const restored = g1.manager.get(accepted.job.id).items!.map((item) => item.jobId!);

    const g2 = await w.crash(g1, (source) => { source.holdAllCaptures = true; source.holdDiscovery = true; });
    await eventually(() => expect(g2.manager.get(accepted.job.id).phase).toBe('discover'));
    await g2.source.holds.started(videoId(0, 'q'));
    stop(w.subs, subscribed);
    g2.manager.stopSubscription('youtube', subscribed.id, reason);
    g2.source.release(videoId(0, 'q'));

    const ended = await Promise.all(restored.map((id) => g2.manager.whenSettled(id)));
    expect(ended.filter((job) => job.result?.outcome === 'skipped' && job.result.skipReason === reason)).toHaveLength(3 - saves);
    expect(w.vault.saves).toBe(saves);
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
    await g.source.holds.started(id);
    pause.set('sleep', true);
    // The request in flight at suspend loses the network in a dark wake.
    g.source.holdCaptures.clear();
    g.source.release(id);
    await eventually(() => expect(g.manager.get(accepted.job.id).state).toBe('queued'));
    await g.quiet();
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
    await eventually(() => expect(g.manager.get(first.job.id).retry?.nextAttemptAt).toBeTruthy());
    pause.set('sleep', true);
    const second = await g.manager.submitItem('youtube', watchUrl(queued));
    // The retry wait ends while the system sleeps.
    g.fireTimers();
    await g.quiet();
    expect(w.script.captures).toEqual([retried]);
    expect([g.manager.get(first.job.id).state, g.manager.get(second.job.id).state]).toEqual(['queued', 'queued']);

    pause.set('sleep', false);
    const [doneFirst, doneSecond] = await Promise.all([g.manager.whenSettled(first.job.id), g.manager.whenSettled(second.job.id)]);
    expect([doneFirst.state, doneSecond.state]).toEqual(['completed', 'completed']);
    expect(doneFirst.retry).toMatchObject({ attempts: 1 });
    expect(w.script.captures.sort()).toEqual([retried, retried, queued].sort());
  });

});

describe('lost network (#128)', () => {
  /** A connectivity service whose probe answers `state.online`, once `state.gate` (when set) opens. */
  function offlineWorld(online: boolean) {
    const pause = new CollectionPause();
    const state = { online, probes: 0, gate: null as Promise<void> | null };
    const connectivity = new Connectivity({ pause, probe: async () => { state.probes += 1; if (state.gate) await state.gate; return state.online; } });
    return { pause, state, connectivity };
  }

  it('returns a step that fails for lack of a network to the queue without spending an attempt, and finishes it once online', async () => {
    const net = offlineWorld(false);
    const w = await world({ pause: net.pause, connectivity: net.connectivity });
    const id = videoId(10, 'o');
    w.script.captureFailures.set(id, [network()]);
    const g = await w.boot();
    const accepted = await g.manager.submitItem('youtube', watchUrl(id));
    await eventually(() => expect(g.manager.get(accepted.job.id).state).toBe('queued'));
    await eventually(() => expect(net.pause.has('offline')).toBe(true));
    expect(net.state.probes).toBe(1);
    expect(g.manager.get(accepted.job.id)).not.toHaveProperty('retry');
    expect(g.timers).toEqual([]);

    net.state.online = true;
    expect(await net.connectivity.check()).toBe('online');
    const done = await g.manager.whenSettled(accepted.job.id);
    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(done).not.toHaveProperty('retry');
    expect(w.script.captures).toEqual([id, id]);
    const types = (await w.events()).map((event) => event.eventType);
    expect(types).not.toContain('job.retry_scheduled');
    expect(types).not.toContain('job.failed');
    net.connectivity.close();
  });

  it('ends a check that failed for lack of a network only once it lists after the network returns', async () => {
    const net = offlineWorld(false);
    const w = await world({ pause: net.pause, connectivity: net.connectivity });
    const subscribed = subscribe(w.subs, 'UC-offline-check');
    w.script.channelVideos.set(subscribed.id, []);
    w.script.discoverFailures.push(network());
    const g = await w.boot();
    const accepted = await g.manager.submitCheck('youtube', subscribed, 'manual');
    await eventually(() => expect(net.pause.has('offline')).toBe(true));
    expect(g.manager.get(accepted.job.id).state).toBe('queued');
    expect(w.subs.of('ended')).toEqual([]);

    net.state.online = true;
    expect(await net.connectivity.check()).toBe('online');
    const done = await g.manager.whenSettled(accepted.job.id);
    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'empty' } });
    expect(w.subs.of('ended')).toEqual([
      { kind: 'ended', type: 'youtube', id: subscribed.id, at: done.finishedAt, errorCode: null, failureClass: null, counted: true },
    ]);
    net.connectivity.close();
  });

  it('spends an attempt when the network is there, so one unreachable source fails on its own', async () => {
    const net = offlineWorld(true);
    const w = await world({ pause: net.pause, connectivity: net.connectivity });
    const id = videoId(11, 'o');
    w.script.captureFailures.set(id, [network()]);
    const g = await w.boot();
    const accepted = await g.manager.submitItem('youtube', watchUrl(id));
    await eventually(() => expect(g.manager.get(accepted.job.id).retry?.attempts).toBe(1));
    expect(net.state.probes).toBe(1);
    expect(net.pause.paused).toBe(false);
    expect((await w.events()).map((event) => event.eventType)).toContain('job.retry_scheduled');
    g.fireTimers();
    expect(await g.manager.whenSettled(accepted.job.id)).toMatchObject({ state: 'completed', retry: { attempts: 1 } });
    net.connectivity.close();
  });
});

describe('system sleep and Vault holds together (#97)', () => {
  it('starts queued work only once both the hold and the sleep pause are over, whichever ends first', async () => {
    const pause = new CollectionPause();
    const w = await world({ pause });
    const g = await w.boot();

    // The hold ends while the system still sleeps.
    pause.set('sleep', true);
    const releaseFirst = await g.manager.hold();
    const first = await g.manager.submitItem('youtube', watchUrl(videoId(8, 's')));
    releaseFirst();
    await g.quiet();
    expect(w.script.captures).toEqual([]);
    pause.set('sleep', false);
    expect(await g.manager.whenSettled(first.job.id)).toMatchObject({ state: 'completed' });

    // The system wakes while the hold is still in force.
    const releaseSecond = await g.manager.hold();
    pause.set('sleep', true);
    const second = await g.manager.submitItem('youtube', watchUrl(videoId(9, 's')));
    pause.set('sleep', false);
    await g.quiet();
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
    await eventually(() => expect(g.manager.get(accepted.job.id).retry?.nextAttemptAt).toBeTruthy());

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

  it('retries channel discovery and channel resolution', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-flaky');
    w.script.channelVideos.set(subscribed.id, listed(1, 'f'));
    w.script.discoverFailures.push(network());
    w.script.resolveFailures.push(network());
    const g = await w.boot();
    const discovering = await g.manager.submitCheck('youtube', subscribed, 'manual');
    await eventually(() => expect(g.manager.get(discovering.job.id).retry?.nextAttemptAt).toBeTruthy());
    g.fireTimers();
    expect(await g.manager.whenSettled(discovering.job.id)).toMatchObject({ state: 'completed', retry: { attempts: 1 } });

    const adding = await g.manager.submit('youtube', 'https://www.youtube.com/@flakyadd');
    await eventually(() => expect(g.manager.get(adding.job.id).retry?.nextAttemptAt).toBeTruthy());
    g.fireTimers();
    expect(await g.manager.whenSettled(adding.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created' }, retry: { attempts: 1 } });
  });

  it('backs off, frees the slot while waiting, and keeps the attempt count across a restart', async () => {
    const w = await world();
    w.script.captureFailures.set(videoId(6), [network(), network(), network(), network()]);
    const g1 = await w.boot();
    const failing = await g1.manager.submitItem('youtube', watchUrl(videoId(6)));
    await eventually(() => expect(g1.manager.get(failing.job.id).retry?.attempts).toBe(1));
    // The only capture slot is free while the job waits.
    const other = await g1.manager.submitItem('youtube', watchUrl(videoId(7)));
    expect(await g1.manager.whenSettled(other.job.id)).toMatchObject({ state: 'completed' });
    g1.fireTimers();
    await eventually(() => expect(g1.manager.get(failing.job.id).retry?.attempts).toBe(2));
    expect(g1.timers.map((timer) => timer.ms)).toEqual([120_000]);
    expect(g1.manager.get(failing.job.id).retry?.nextAttemptAt).toBe('2026-10-15T06:02:00.000Z');

    w.clock.now = new Date('2026-10-15T06:01:00.000Z');
    const g2 = await w.restart(g1);
    expect(g2.manager.get(failing.job.id)).toMatchObject({ state: 'queued', retry: { attempts: 2 }, recovery: { resumedCount: 1, uncleanStops: 0 } });
    expect(g2.timers.map((timer) => timer.ms)).toEqual([60_000]);
    expect((await w.events()).find((event) => event.jobId === failing.job.id && event.eventType === 'job.resumed'))
      .toMatchObject({ severity: 'info', stopReason: 'shutdown', message: '服務正常關閉後重新啟動，接續收集工作。' });
    expect((await w.events()).find((event) => event.jobId === failing.job.id && event.eventType === 'job.interrupted'))
      .toMatchObject({ severity: 'debug' });
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
      await current.source.holds.started(videoId(8));
      g = await w.crash(g, hold);
      expect(g.manager.get(stuck.job.id).recovery?.uncleanStops).toBe(stop);
    }
    const third = g;
    await third.source.holds.started(videoId(8));
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
    await eventually(() => expect(g.manager.get(accepted.job.id).retry?.attempts).toBe(1));
    for (let restart = 0; restart < 3; restart += 1) g = await w.restart(g);
    w.clock.now = new Date('2026-10-15T06:05:00.000Z');
    g = await w.restart(g);

    expect(await g.manager.whenSettled(accepted.job.id)).toMatchObject({
      state: 'completed', recovery: { resumedCount: 4, uncleanStops: 0 }, retry: { attempts: 1 },
    });
  });
});

describe('interrupted work in its subscription\'s activity (#255)', () => {
  /** The event types of one job that the activity filter of a subscription returns. */
  async function subscriptionEvents(records: JobRecords, subscriptionId: string, jobId: string): Promise<string[]> {
    const page = await records.views.query({ subscriptionId, limit: 500 }, { vaultPath: VAULT });
    return page.events.filter((event) => event.jobId === jobId).map((event) => event.eventType);
  }

  it('files the interruption of a check\'s item under the subscription after the job records are gone', async () => {
    const w = await world();
    const subscribed = subscribe(w.subs, 'UC-interrupted-item');
    w.script.channelVideos.set(subscribed.id, listed(1, 'p'));
    const g1 = await w.boot((source) => { source.holdAllCaptures = true; });
    const check = await g1.manager.submitCheck('youtube', subscribed, 'manual');
    await g1.source.holds.started(videoId(0, 'p'));
    const itemId = g1.manager.get(check.job.id).items![0]!.jobId!;

    const g2 = await w.crash(g1);
    await g2.manager.whenSettled(check.job.id);
    // Finished jobs beyond the store's limit drop out oldest first, so these push out the check and its item.
    for (let index = 0; index < 1001; index += 1) {
      const at = new Date(T0.getTime() + 86_400_000 + index).toISOString();
      g2.store.put({
        id: `later-${index}`, kind: 'youtube.video', state: 'completed', phase: null, vaultPath: VAULT, vaultId: VAULT_ID, parentId: null,
        source: { type: 'youtube', id: `later-${index}`, url: watchUrl(`later-${index}`), title: null },
        createdAt: at, startedAt: at, finishedAt: at, updatedAt: at, progress: null, items: null, result: { outcome: 'existing' }, error: null,
      });
    }
    expect(g2.store.get(itemId)).toBeUndefined();
    expect(g2.store.get(check.job.id)).toBeUndefined();

    expect(await subscriptionEvents(g2.records, subscribed.id, itemId)).toContain('job.interrupted');
  });
});

describe('the order interrupted jobs are restored in', () => {
  const interrupted = (id: string, videoKey: string, minute: number): CollectionJob => {
    const at = new Date(T0.getTime() + minute * 60_000).toISOString();
    return {
      id, kind: 'youtube.video', state: 'interrupted', phase: 'capture', vaultPath: VAULT, vaultId: VAULT_ID, parentId: null,
      source: { type: 'youtube', id: videoKey, url: watchUrl(videoKey), title: null },
      createdAt: at, startedAt: at, finishedAt: at, updatedAt: at, progress: null, items: null, result: null,
      error: { code: 'interrupted', message: '中斷' },
      recovery: { resumedCount: 0, uncleanStops: 0, lastInterruptedAt: at, lastResumedAt: null, lastStop: 'shutdown' },
    };
  };

  it.each([
    ['oldest first', ['old-a', 'b', 'new-a']],
    ['newest first', ['new-a', 'b', 'old-a']],
  ])('is oldest to newest whatever order the records come in (%s), so the newest job of a work key is restored last and owns it', async (_order, ids) => {
    const jobs = new Map([
      ['old-a', interrupted('old-a', videoId(1), 0)],
      ['b', interrupted('b', videoId(2), 1)],
      ['new-a', interrupted('new-a', videoId(1), 2)],
    ]);
    const restored: string[] = [];
    await resumeInterrupted({
      sources: PRODUCT_SOURCES,
      stored: () => ids.map((id) => jobs.get(id)!),
      runs: () => true,
      stopped: async () => null,
      settle: () => { throw new Error('nothing settles'); },
      restore: (job) => { restored.push(job.id); },
    });
    expect(restored).toEqual(['old-a', 'b', 'new-a']);
  });

  it('restores jobs created in the same millisecond in the reverse of the order the records come in', async () => {
    const restored: string[] = [];
    await resumeInterrupted({
      sources: PRODUCT_SOURCES,
      stored: () => [interrupted('first', videoId(1), 0), interrupted('second', videoId(2), 0), interrupted('third', videoId(3), 0)],
      runs: () => true,
      stopped: async () => null,
      settle: () => { throw new Error('nothing settles'); },
      restore: (job) => { restored.push(job.id); },
    });
    expect(restored).toEqual(['third', 'second', 'first']);
  });
});
