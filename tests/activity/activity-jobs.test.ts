import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SubscriptionService, SubscriptionServices } from '../../src/subscriptions/subscription-service.js';
import { DEFAULT_POLICY } from '../../src/plugins/youtube/settings.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import {
  CollectorError,
  type CollectionJob,
  type DocumentSummary,
  type JobEvent,
  type SavedDocument,
  type SubscriptionRecord,
} from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { eventLine, eventText } from '../../src/web/activity-presentation.js';
import { forwardingPort, type SubscriptionPort } from '../../src/jobs/subscription-port.js';
import { JobStore } from '../../src/jobs/job-store.js';
import type { DiscoveredYouTubeVideo, ResolvedYouTubeChannel, YouTubeSource, CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import type {
  YouTubeVideoRef,
} from '../../src/plugins/youtube/url.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import type { CapturedDocument, SubscriptionTarget } from '../../src/core/source-contract.js';
import type { DocumentKey } from '../../src/vault/document-paths.js';
import { SubscriptionRecorder } from '../support/subscription-recorder.js';
import { transcriptOf } from '../support/youtube-documents.js';
import { HeldCaptures } from '../support/held-captures.js';
import { eventually } from '../support/wait.js';
import { VaultFileWriter } from '../../src/vault/vault-files.js';
import { PRODUCT_DECLARATIONS, PRODUCT_SOURCES } from '../support/product-sources.js';

// Manual retry, job summary and the job fields activity events carry, over the real job manager.

const VAULT = '/vaults/activity';
const T0 = new Date('2026-10-15T06:00:00.000Z');
const directories: string[] = [];

/**
 * The Activity line of a collected completion reads its result from the event's fields and says what
 * the server's message says after its opening words.
 */
function expectCollectedLine(completed: JobEvent): void {
  const opening = '收集完成';
  expect(completed.message.startsWith(opening)).toBe(true);
  expect(eventLine(completed).line).toBe('collected');
  expect(eventText(PRODUCT_DECLARATIONS, completed)).toBe(`${completed.sourceTitle ? `${completed.sourceTitle}：` : ''}完成收集${completed.message.slice(opening.length)}`);
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

class MemoryVault implements DocumentVault {
  readonly sources = PRODUCT_SOURCES;
  readonly documents = new Map<string, SavedDocument>();
  async getByKey({ sourceId }: DocumentKey) { return this.documents.get(sourceId) ?? null; }
  async getBySourceId(sourceId: string) { return this.documents.get(sourceId) ?? null; }
  async add(item: CapturedDocument) {
    const capture = transcriptOf(item);
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

/** Failures queued per call kind; captures can wait until released. */
class ScriptedSource implements YouTubeSource {
  readonly captureFailures = new Map<string, CollectorError[]>();
  readonly discoverFailures: CollectorError[] = [];
  readonly resolveFailures: CollectorError[] = [];
  readonly channelVideos = new Map<string, DiscoveredYouTubeVideo[]>();
  readonly holds = new HeldCaptures();
  hold = new Set<string>();

  async resolveChannel(url: string): Promise<ResolvedYouTubeChannel> {
    const failure = this.resolveFailures.shift();
    if (failure) throw failure;
    const handle = url.split('/').pop()!.replace('@', '');
    const id = `UC${handle.padEnd(22, 'x')}`.slice(0, 24);
    return { id, title: `頻道 ${handle}`, url: `https://www.youtube.com/channel/${id}/videos` };
  }

  async discover(channel: SubscriptionTarget, page: { offset: number; limit: number }): Promise<DiscoveredYouTubeVideo[]> {
    const failure = this.discoverFailures.shift();
    if (failure) throw failure;
    return (this.channelVideos.get(channel.id) ?? []).slice(page.offset, page.offset + page.limit);
  }

  async capture(video: YouTubeVideoRef): Promise<CapturedTranscript> {
    if (this.hold.has(video.videoId)) await this.holds.hold(video.videoId);
    const failure = this.captureFailures.get(video.videoId)?.shift();
    if (failure) throw failure;
    return {
      videoId: video.videoId, sourceUrl: watchUrl(video.videoId), title: `影片 ${video.videoId}`, channelId: null, channelTitle: '測試頻道',
      publishedAt: null, languageCode: 'zh-Hant', languageName: null, subtitleKind: 'manual', bodyMarkdown: '正文',
    };
  }
}

let tick = 0;
/** Each reading is a millisecond later, so events keep the order they happened in. */
const clock = () => new Date(T0.getTime() + tick++);

/** A job manager over a scripted source that reports to `subscriptions`. */
function build(subscriptions: SubscriptionPort, store: JobStore, limits: { capture?: number } = {}) {
  const vault = new MemoryVault();
  const source = new ScriptedSource();
  const timers: Array<() => void> = [];
  let sequence = 0;
  const manager = new JobManager({
    sources: PRODUCT_SOURCES,
    vaultPath: VAULT, store, plugins: [youtubePlugin(source)], documents: new Collector(vault, { index: async () => undefined }), subscriptions,
    now: clock, createId: () => `job-${++sequence}`, limits,
    setTimer: (callback) => { timers.push(callback); return () => undefined; },
  });
  const runTimers = () => { for (const callback of timers.splice(0)) callback(); };
  /** Runs the timers once the manager has set one. */
  const runNextTimers = async () => {
    await eventually(() => expect(timers).not.toHaveLength(0));
    runTimers();
  };
  const events = async (query: Parameters<typeof store.activity.query>[0] = {}) => (await store.activity.query(query, { vaultPath: VAULT })).events;
  return { manager, store, source, vault, runTimers, runNextTimers, events };
}

/** Jobs whose subscriptions are an in-memory recorder of what the jobs report. */
function setup(store: JobStore = JobStore.memory(PRODUCT_SOURCES, clock), limits: { capture?: number } = {}) {
  const subs = new SubscriptionRecorder();
  const world = build(subs, store, limits);
  subs.attach(world.manager);
  return { ...world, subs };
}

/** Jobs and the real subscription service over a subscriptions file in a temporary Vault. */
async function setupWithService() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-activity-subscriptions-'));
  directories.push(root);
  const channelStore = new JsonSubscriptionStore(new VaultFileWriter(root, PRODUCT_SOURCES), 'youtube', clock);
  let service: SubscriptionService | null = null;
  const world = build(forwardingPort(() => new SubscriptionServices(PRODUCT_SOURCES, [service!])), JobStore.memory(PRODUCT_SOURCES, clock));
  service = new SubscriptionService('youtube', channelStore, world.manager, {
    sources: PRODUCT_SOURCES,
    autoCollection: async () => true, resolveTarget: (url) => world.source.resolveChannel(url), documents: async () => [], now: clock,
  });
  return { ...world, channelStore, service };
}

function subscription(id: string): SubscriptionRecord {
  return {
    id, title: `頻道 ${id}`, url: `https://www.youtube.com/channel/${id}/videos`, enabled: true, addedAt: T0.toISOString(),
    settings: { ...DEFAULT_POLICY },
  };
}

/** Subscribes the recorder to a channel with the default settings. */
function subscribe(subs: SubscriptionRecorder, id: string) {
  const { settings, ...target } = subscription(id);
  return subs.add('youtube', target, { settings });
}

const noSubtitles = () => new CollectorError('no_subtitles', '這支影片沒有可取得的既有字幕。');
const network = () => new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。', { detail: 'ERROR: Unable to download webpage: <urlopen error timed out>' });

describe('manual retry (A-T9)', () => {
  it('retries a failed video with a new job once, and refuses other retries', async () => {
    const { manager, source, events } = setup();
    source.captureFailures.set('aaaaaaaaaaa', [noSubtitles()]);
    const failed = await manager.whenSettled((await manager.submitItem('youtube', watchUrl('aaaaaaaaaaa'))).job.id);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'no_subtitles' } });

    const retried = await manager.retry(failed.id);
    expect(retried.deduplicated).toBe(false);
    expect(retried.job).toMatchObject({ retryOf: failed.id, state: 'queued' });
    expect(retried.job.retry).toBeUndefined();
    expect(manager.get(failed.id).retriedBy).toBe(retried.job.id);
    expect(await manager.whenSettled(retried.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created' } });

    await expect(manager.retry(failed.id)).rejects.toMatchObject({ code: 'job_not_retryable' });
    await expect(manager.retry(retried.job.id)).rejects.toMatchObject({ code: 'job_not_retryable' });
    await expect(manager.retry('missing')).rejects.toMatchObject({ code: 'job_not_found' });

    const forOriginal = (await events({ jobId: failed.id })).map((entry) => entry.eventType).reverse();
    expect(forOriginal).toEqual(['job.accepted', 'job.started', 'job.failed', 'job.accepted', 'job.retry_requested']);
    const requested = (await events({ eventType: ['job.retry_requested'] }))[0]!;
    expect(requested).toMatchObject({ jobId: retried.job.id, retryOf: failed.id, sourceId: 'aaaaaaaaaaa', severity: 'info' });
  });

  it('gives a job whose automatic retries ran out a fresh attempt budget', async () => {
    const { manager, source, runNextTimers, events } = setup();
    source.captureFailures.set('bbbbbbbbbbb', [network(), network(), network()]);
    const id = (await manager.submitItem('youtube', watchUrl('bbbbbbbbbbb'))).job.id;
    // Three attempts: the first and two automatic retries.
    for (let retry = 0; retry < 2; retry += 1) await runNextTimers();
    const failed = await manager.whenSettled(id);
    expect(failed).toMatchObject({ state: 'failed', retry: { attempts: 3 } });
    const failure = (await events({ jobId: id, eventType: ['job.failed'] }))[0]!;
    expect(failure.detail).toContain('Unable to download webpage');
    expect((await events({ jobId: id, eventType: ['job.retry_scheduled'] })).every((event) => event.severity === 'warning')).toBe(true);
    const starts = await events({ jobId: id, eventType: ['job.started'] });
    expect(starts.map((event) => event.severity)).toEqual(['debug', 'debug', 'info']);

    const retried = await manager.retry(id);
    const done = await manager.whenSettled(retried.job.id);
    expect(done).toMatchObject({ state: 'completed', retryOf: id });
    expect(done.retry).toBeUndefined();
  });

  it('returns the active job of the same video instead of a second one', async () => {
    const { manager, source } = setup();
    source.captureFailures.set('ccccccccccc', [noSubtitles()]);
    const failed = await manager.whenSettled((await manager.submitItem('youtube', watchUrl('ccccccccccc'))).job.id);
    source.hold.add('ccccccccccc');
    const active = await manager.submitItem('youtube', watchUrl('ccccccccccc'));
    const retried = await manager.retry(failed.id);
    expect(retried).toMatchObject({ deduplicated: true, job: { id: active.job.id } });
    expect(manager.get(failed.id).retriedBy).toBe(active.job.id);
    await source.holds.started('ccccccccccc');
    source.holds.release('ccccccccccc');
  });

  it('subscribes again with the settings a failed subscription request was accepted with', async () => {
    const { manager, source, subs } = setup();
    source.resolveFailures.push(new CollectorError('invalid_subscription', '無法辨認這個 YouTube 頻道。'));
    const settings = { intervalMinutes: 120, backfillDays: 7, backfillMaxItems: 5 };
    const failed = await manager.whenSettled((await manager.submitSubscriptionAdd('youtube', 'https://www.youtube.com/@retry', settings)).job.id);
    expect(failed.state).toBe('failed');
    const retried = await manager.retry(failed.id);
    expect(retried.job).toMatchObject({ kind: 'youtube.channel-add', retryOf: failed.id, scope: { trigger: 'subscribe' } });
    const done = await manager.whenSettled(retried.job.id);
    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(subs.of('subscribed')).toEqual([expect.objectContaining({ id: done.result!.subscriptionId, outcome: 'created' })]);
    expect(subs.get('youtube', done.result!.subscriptionId!)!.settings).toEqual(settings);
  });

  it('checks the subscription of a failed channel job now, and follows its pause or removal', async () => {
    const { manager, source, channelStore, service } = await setupWithService();
    await channelStore.add(subscription('UC1'));
    await channelStore.add(subscription('UC2'));
    source.channelVideos.set('UC1', [{ id: 'ddddddddddd', title: '新影片', url: watchUrl('ddddddddddd'), publishedAt: T0.toISOString(), upcoming: false }]);
    source.discoverFailures.push(new CollectorError('capture_failed', '字幕取得失敗，請稍後再試。'));
    const [first] = await service.startRun({ trigger: 'scheduled', subscriptionIds: ['UC1'] });
    const failed = await manager.whenSettled(first!.job.id);
    expect(failed.state).toBe('failed');

    const retried = await manager.retry(failed.id);
    expect(retried.job).toMatchObject({ kind: 'youtube.channel', retryOf: failed.id, scope: { trigger: 'manual' } });
    expect(await manager.whenSettled(retried.job.id)).toMatchObject({ state: 'completed', progress: { created: 1 } });

    source.discoverFailures.push(new CollectorError('capture_failed', '字幕取得失敗，請稍後再試。'));
    const [second] = await service.startRun({ trigger: 'manual', subscriptionIds: ['UC2'] });
    const failedAgain = await manager.whenSettled(second!.job.id);
    await channelStore.setEnabled('UC2', false);
    await expect(manager.retry(failedAgain.id)).rejects.toMatchObject({ code: 'subscription_paused' });
    await channelStore.remove('UC2');
    await expect(manager.retry(failedAgain.id)).rejects.toMatchObject({ code: 'subscription_not_found' });
    expect(manager.get(failedAgain.id).retriedBy).toBeUndefined();
  });

  it('collects the failed videos of a channel job again, without discovery or reporting a check', async () => {
    const { manager, source, subs, vault } = setup();
    subscribe(subs, 'UC3');
    const video = (id: string) => ({ id, title: `頻道影片 ${id}`, url: watchUrl(id), publishedAt: T0.toISOString(), upcoming: false });
    source.channelVideos.set('UC3', [video('mmmmmmmmmmm'), video('nnnnnnnnnnn')]);
    source.captureFailures.set('mmmmmmmmmmm', [noSubtitles()]);
    source.captureFailures.set('nnnnnnnnnnn', [noSubtitles()]);
    const first = await manager.submitCheck('youtube', subs.get('youtube', 'UC3')!, 'scheduled');
    const failed = await manager.whenSettled(first.job.id);
    // Failed videos are left to later checks; the check itself completes.
    expect(failed).toMatchObject({ state: 'completed', result: { outcome: 'partial' }, progress: { failed: 2 } });
    expect(subs.of('failed').map((report) => [report.key, report.errorCode])).toEqual([
      ['mmmmmmmmmmm', 'no_subtitles'], ['nnnnnnnnnnn', 'no_subtitles'],
    ]);
    expect(subs.of('checked')).toHaveLength(1);

    // The videos left the listing: a new check would find nothing.
    source.channelVideos.set('UC3', []);
    source.discoverFailures.push(new CollectorError('capture_failed', '這次重試不應該重新發現影片。'));
    const retried = await manager.retry(failed.id);
    expect(retried.job).toMatchObject({ kind: 'youtube.channel', retryOf: failed.id, scope: { trigger: 'manual' } });
    const done = await manager.whenSettled(retried.job.id);
    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created' }, progress: { total: 2, created: 2 } });
    expect(done.items!.map((item) => item.sourceId)).toEqual(['mmmmmmmmmmm', 'nnnnnnnnnnn']);
    expect(done.items!.every((item) => manager.get(item.jobId!).publishedNotBefore === undefined)).toBe(true);
    expect(source.discoverFailures).toHaveLength(1);
    expect(subs.of('checked')).toHaveLength(1);
    expect(subs.of('collected').map((report) => report.key)).toEqual(['mmmmmmmmmmm', 'nnnnnnnnnnn']);
    expect(await vault.getBySourceId('nnnnnnnnnnn')).not.toBeNull();
    expect(manager.get(failed.id).retriedBy).toBe(retried.job.id);
    await expect(manager.retry(failed.id)).rejects.toMatchObject({ code: 'job_not_retryable' });
  });

  it('retries only the failed videos of a channel job that completed with some failing', async () => {
    const { manager, source, subs } = setup();
    const channel = subscribe(subs, 'UC4');
    const video = (id: string) => ({ id, title: `頻道影片 ${id}`, url: watchUrl(id), publishedAt: T0.toISOString(), upcoming: false });
    source.channelVideos.set('UC4', [video('ooooooooooo'), video('ppppppppppp')]);
    source.captureFailures.set('ppppppppppp', [noSubtitles()]);
    const first = await manager.submitCheck('youtube', channel, 'scheduled');
    const partial = await manager.whenSettled(first.job.id);
    expect(partial).toMatchObject({ state: 'completed', result: { outcome: 'partial' } });

    const retried = await manager.retry(partial.id);
    const done = await manager.whenSettled(retried.job.id);
    expect(done.items!.map((item) => item.sourceId)).toEqual(['ppppppppppp']);
    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(manager.get(partial.id).retriedBy).toBe(retried.job.id);

    const clean = await manager.submitCheck('youtube', channel, 'manual');
    const finished = await manager.whenSettled(clean.job.id);
    expect(finished.state).toBe('completed');
    await expect(manager.retry(finished.id)).rejects.toMatchObject({ code: 'job_not_retryable' });
  });
});

describe('masked job errors (A-T6)', () => {
  it('masks credentials in the error a job keeps and shows', async () => {
    const { manager, source, events } = setup();
    source.captureFailures.set('lllllllllll', [new CollectorError('capture_failed', '失敗（Authorization: Bearer leaked.token）cookie=SID=x')]);
    const failed = await manager.whenSettled((await manager.submitItem('youtube', watchUrl('lllllllllll'))).job.id);
    expect(failed.error!.message).toBe('失敗（Authorization: [已遮蔽]）cookie: [已遮蔽]');
    expect(JSON.stringify(await events({ jobId: failed.id }))).not.toContain('leaked.token');
  });
});

describe('job summary and event fields', () => {
  it('persists severity from job role and outcome instead of event name alone (L1)', async () => {
    const { manager, source, subs, events } = setup();
    const created = await manager.whenSettled((await manager.submitItem('youtube', watchUrl('qqqqqqqqqqq'))).job.id);
    expect(created.result?.outcome).toBe('created');
    expect((await events({ jobId: created.id })).map((event) => [event.eventType, event.severity]).reverse()).toEqual([
      ['job.accepted', 'debug'], ['job.started', 'info'], ['document.saved', 'info'], ['job.completed', 'debug'],
    ]);

    const existing = await manager.whenSettled((await manager.submitItem('youtube', watchUrl('qqqqqqqqqqq'))).job.id);
    expect(existing.result?.outcome).toBe('existing');
    const existed = (await events({ jobId: existing.id, eventType: ['job.completed'] }))[0]!;
    expect(existed).toMatchObject({ severity: 'info', outcome: 'existing' });
    expect(eventLine(existed).line).toBe('completed');

    const channel = subscribe(subs, 'UC-levels');
    source.channelVideos.set('UC-levels', [{ id: 'rrrrrrrrrrr', title: '子工作', url: watchUrl('rrrrrrrrrrr'), publishedAt: T0.toISOString(), upcoming: false }]);
    const checked = await manager.whenSettled((await manager.submitCheck('youtube', channel, 'manual')).job.id);
    const checkEvents = await events({ jobId: checked.id });
    expect(checkEvents.find((event) => event.jobId === checked.id && event.eventType === 'job.started')).toMatchObject({ severity: 'info' });
    expect(checkEvents.find((event) => event.parentJobId === checked.id && event.eventType === 'job.started')).toMatchObject({ severity: 'debug' });
    expect(checkEvents.find((event) => event.parentJobId === checked.id && event.eventType === 'job.completed')).toMatchObject({ severity: 'debug' });
    expect(checkEvents.find((event) => event.jobId === checked.id && event.eventType === 'channel.discovered')).toMatchObject({ severity: 'debug' });
    expect(checkEvents.find((event) => event.jobId === checked.id && event.eventType === 'job.completed')).toMatchObject({ severity: 'info' });

    source.channelVideos.set('UC-levels', [{ id: 'sssssssssss', title: '失敗子工作', url: watchUrl('sssssssssss'), publishedAt: T0.toISOString(), upcoming: false }]);
    source.captureFailures.set('sssssssssss', [noSubtitles()]);
    const partial = await manager.whenSettled((await manager.submitCheck('youtube', channel, 'manual')).job.id);
    expect((await events({ jobId: partial.id, eventType: ['job.completed'] })).find((event) => event.jobId === partial.id))
      .toMatchObject({ severity: 'warning', outcome: 'partial' });
    expect((await events({ jobId: partial.id, eventType: ['subscription.item_failed'] }))[0]).toMatchObject({ severity: 'warning' });
  });

  it('records a created item completion without repeating the document-save stage', async () => {
    const { manager, events } = setup();
    const done = await manager.whenSettled((await manager.submitItem('youtube', watchUrl('zzzzzzzzzzz'))).job.id);
    const completed = (await events({ jobId: done.id, eventType: ['job.completed'] }))[0]!;
    expect(completed).toMatchObject({ jobRole: 'item', outcome: 'created' });
    expectCollectedLine(completed);
  });

  it('counts active jobs and jobs finished since a time, leaving out retried failures', async () => {
    // A second capture slot lets the retry finish while another capture is held.
    const { manager, source } = setup(undefined, { capture: 2 });
    source.captureFailures.set('eeeeeeeeeee', [noSubtitles()]);
    source.captureFailures.set('fffffffffff', [noSubtitles()]);
    await manager.whenSettled((await manager.submitItem('youtube', watchUrl('ggggggggggg'))).job.id);
    const failed = await manager.whenSettled((await manager.submitItem('youtube', watchUrl('eeeeeeeeeee'))).job.id);
    await manager.whenSettled((await manager.submitItem('youtube', watchUrl('fffffffffff'))).job.id);
    source.hold.add('hhhhhhhhhhh');
    await manager.submitItem('youtube', watchUrl('hhhhhhhhhhh'));
    expect(manager.summary('2026-10-15T00:00:00+08:00')).toEqual({ active: 1, completed: 1, failed: 2, since: '2026-10-14T16:00:00.000Z' });
    const retried = await manager.retry(failed.id);
    await manager.whenSettled(retried.job.id);
    expect(manager.summary('2026-10-15T00:00:00+08:00')).toMatchObject({ active: 1, completed: 2, failed: 1 });
    expect(manager.summary('2026-10-16T00:00:00+08:00')).toMatchObject({ active: 1, completed: 0, failed: 0 });
    await source.holds.started('hhhhhhhhhhh');
    source.holds.release('hhhhhhhhhhh');
  });

  it('records title, subscription, parent and trigger on the events of a channel job and its videos', async () => {
    const { manager, source, channelStore, service, events } = await setupWithService();
    await channelStore.add(subscription('UC9'));
    source.channelVideos.set('UC9', [{ id: 'iiiiiiiiiii', title: '頻道影片', url: watchUrl('iiiiiiiiiii'), publishedAt: T0.toISOString(), upcoming: false }]);
    const [submission] = await service.startRun({ trigger: 'scheduled', subscriptionIds: ['UC9'] });
    await manager.whenSettled(submission!.job.id);
    const saved = (await events({ eventType: ['document.saved'] }))[0]!;
    expect(saved).toMatchObject({ subscriptionId: 'UC9', parentJobId: submission!.job.id, sourceTitle: '影片 iiiiiiiiiii', documentId: 'youtube:iiiiiiiiiii' });
    const accepted = (await events({ jobId: submission!.job.id, eventType: ['job.accepted'] })).find((entry) => entry.jobId === submission!.job.id)!;
    expect(accepted).toMatchObject({ trigger: 'scheduled', sourceTitle: '頻道 UC9', subscriptionId: 'UC9', jobRole: 'check' });
    const completed = (await events({ jobId: submission!.job.id, eventType: ['job.completed'] })).find((entry) => entry.jobId === submission!.job.id)!;
    expect(completed).toMatchObject({ outcome: 'created', check: { created: 1, existing: 0, failed: 0, skipped: 0 } });
    expectCollectedLine(completed);
    const videoAccepted = (await events({ eventType: ['job.accepted'] })).find((entry) => entry.parentJobId === submission!.job.id)!;
    expect(videoAccepted).toMatchObject({ sourceTitle: '頻道影片', jobRole: 'item' });
    const chronology = await events({ jobId: submission!.job.id });
    expect(chronology.findIndex((entry) => entry.eventId === videoAccepted.eventId))
      .toBeLessThan(chronology.findIndex((entry) => entry.eventType === 'channel.discovered'));
    expect((await events({ subscriptionId: 'UC9' })).length).toBeGreaterThanOrEqual(6);
    await service.setEnabled('UC9', false);
    expect((await events({ subscriptionId: 'UC9', eventType: ['subscription.paused'] }))[0]).toMatchObject({ sourceTitle: '頻道 UC9', namesSource: true });
  });

  it('says a check that found nothing new, and one whose video failed, from the event fields', async () => {
    const { manager, source, subs, events } = setup();
    const channel = subscribe(subs, 'UC-results');
    const completion = async (id: string) => (await events({ jobId: id, eventType: ['job.completed'] })).find((entry) => entry.jobId === id)!;
    const empty = await manager.whenSettled((await manager.submitCheck('youtube', channel, 'manual')).job.id);
    expect(await completion(empty.id)).toMatchObject({ outcome: 'empty' });
    expectCollectedLine(await completion(empty.id));

    source.channelVideos.set('UC-results', [
      { id: 'uuuuuuuuuuu', title: '失敗', url: watchUrl('uuuuuuuuuuu'), publishedAt: T0.toISOString(), upcoming: false },
    ]);
    source.captureFailures.set('uuuuuuuuuuu', [noSubtitles()]);
    const failing = await manager.whenSettled((await manager.submitCheck('youtube', channel, 'manual')).job.id);
    expect(await completion(failing.id)).toMatchObject({ outcome: 'partial', check: { created: 0, failed: 1 } });
    expectCollectedLine(await completion(failing.id));
    // A failed video's event names the video in its message, so its line does not lead with the title.
    expect((await events({ jobId: failing.id, eventType: ['subscription.item_failed'] }))[0]).toMatchObject({ sourceTitle: '失敗', namesSource: true });
  });
});

describe('check summaries from real jobs (#96 A2, L6)', () => {
  it('summarizes scheduled checks that cannot list the channel as one network error run between empty runs', async () => {
    const { manager, source, subs, store, runNextTimers } = setup();
    const channel = subscribe(subs, 'UC-runs');
    const check = async (failing: boolean) => {
      if (failing) source.discoverFailures.push(network(), network(), network());
      const id = (await manager.submitCheck('youtube', channel, 'scheduled')).job.id;
      // A check that cannot list the channel makes three attempts: the first and two automatic retries.
      if (failing) for (let retry = 0; retry < 2; retry += 1) await runNextTimers();
      return manager.whenSettled(id);
    };
    const states = [];
    for (const failing of [false, false, true, true, false]) states.push((await check(failing)).state);
    expect(states).toEqual(['completed', 'completed', 'failed', 'failed', 'completed']);

    const summary = await store.activity.summary({ view: 'summary', sourceType: 'youtube', subscriptionId: 'UC-runs' }, { vaultPath: VAULT });
    const runs = summary.entries.filter((entry) => entry.kind === 'check').map((entry) => [entry.result, entry.count]);
    expect(runs).toEqual([['empty', 1], ['network_error', 2], ['empty', 2]]);
  });

  it('shows a first collection of three videos as one subscription, one start, three documents and one result, with queue events only at DEBUG', async () => {
    const { manager, source, service, store } = await setupWithService();
    const id = (await source.resolveChannel('https://www.youtube.com/@lifecycle')).id;
    source.channelVideos.set(id, ['lllllllll01', 'lllllllll02', 'lllllllll03'].map((video) => ({
      id: video, title: `影片 ${video}`, url: watchUrl(video), publishedAt: T0.toISOString(), upcoming: false,
    })));
    await manager.whenSettled((await service.add('https://www.youtube.com/@lifecycle')).job.id);
    const scope = { vaultPath: VAULT };
    await eventually(async () => expect((await store.activity.summary({ view: 'summary', subscriptionId: id }, scope)).entries
      .some((entry) => entry.kind === 'check')).toBe(true));

    const info: ['info', 'warning', 'error'] = ['info', 'warning', 'error'];
    const summary = (await store.activity.summary({ view: 'summary', subscriptionId: id, severity: info }, scope)).entries;
    const shown = summary.map((entry) => (entry.kind === 'check' ? `check:${entry.result}:${entry.created}` : entry.event.eventType)).sort();
    expect(shown).toEqual(['check:other:3', 'document.saved', 'document.saved', 'document.saved', 'job.started', 'subscription.added']);
    const raw = (await store.activity.query({ subscriptionId: id, severity: info }, scope)).events.map((event) => event.eventType);
    expect(raw.filter((type) => type === 'document.saved')).toHaveLength(3);
    expect(raw).not.toContain('job.accepted');
    const debug = (await store.activity.query({ subscriptionId: id }, scope)).events.map((event) => event.eventType);
    expect(debug).toContain('job.accepted');
  });
});

describe('retention leaves job records alone (A-T3)', () => {
  it('keeps real check summaries and detail after their jobs are pruned and the store restarts (#96 A6)', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xr-activity-summary-jobs-'));
    directories.push(directory);
    const store = await JobStore.open(directory, PRODUCT_SOURCES, clock);
    const first = setup(store);
    const channel = subscribe(first.subs, 'UC-summary');
    for (let index = 0; index < 12; index += 1) {
      const submission = await first.manager.submitCheck('youtube', channel, 'scheduled');
      expect(await first.manager.whenSettled(submission.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'empty' } });
    }
    for (let index = 0; index < 1001; index += 1) store.put(finished(`later-${index}`, new Date(T0.getTime() + 86_400_000 + index).toISOString()));
    await first.manager.close();
    await store.close();

    const reopened = await JobStore.open(directory, PRODUCT_SOURCES, clock);
    expect(reopened.list(VAULT).some((job) => job.kind === 'youtube.channel')).toBe(false);
    const summary = await reopened.activity.summary({ view: 'summary', sourceType: 'youtube', subscriptionId: 'UC-summary' }, { vaultPath: VAULT });
    const group = summary.entries.find((entry) => entry.kind === 'check')!;
    expect(group).toMatchObject({ count: 12, result: 'empty' });
    expect((await reopened.activity.group(group.groupId, { vaultPath: VAULT })).checks).toHaveLength(12);
    await reopened.close();
  });

  it('keeps an interrupted job and an index failure after every event expired, and resumes the job', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xr-activity-jobs-'));
    directories.push(directory);
    let now = T0;
    const store = await JobStore.open(directory, PRODUCT_SOURCES, () => now);
    const first = setup(store);
    first.source.hold.add('jjjjjjjjjjj');
    const interrupted = (await first.manager.submitItem('youtube', watchUrl('jjjjjjjjjjj'))).job.id;
    await first.source.holds.started('jjjjjjjjjjj');
    await store.flush();
    // The process stops while the capture runs; reopening marks the job interrupted.
    now = new Date(T0.getTime() + 40 * 86_400_000);
    const reopened = await JobStore.open(directory, PRODUCT_SOURCES, () => now);
    await reopened.activity.purge();
    const before = await readFile(path.join(directory, 'jobs.json'), 'utf8');
    expect((await reopened.activity.query({}, { vaultPath: VAULT })).events.every((entry) => entry.timestamp >= new Date(now.getTime() - 30 * 86_400_000).toISOString())).toBe(true);
    expect(reopened.get(interrupted)).toMatchObject({ state: 'interrupted' });
    expect(await readFile(path.join(directory, 'jobs.json'), 'utf8')).toBe(before);

    const second = setup(reopened);
    await second.manager.resume();
    expect(await second.manager.whenSettled(interrupted)).toMatchObject({ state: 'completed', recovery: { resumedCount: 1 } });
    await reopened.close();
    await store.close();
  });
});

function finished(id: string, timestamp: string): CollectionJob {
  return {
    id, kind: 'youtube.video', state: 'completed', phase: null, vaultPath: VAULT, parentId: null,
    source: { type: 'youtube', id, url: watchUrl(id), title: id }, createdAt: timestamp, startedAt: timestamp,
    finishedAt: timestamp, updatedAt: timestamp, progress: null, items: null, result: { outcome: 'existing' }, error: null,
  };
}
