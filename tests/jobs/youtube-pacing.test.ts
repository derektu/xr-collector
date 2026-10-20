import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouTubeGate } from '../../src/capture/youtube-gate.js';
import type { ChannelPatch, ChannelStore } from '../../src/channels/json-channel-store.js';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import {
  CollectorError,
  type CapturedTranscript,
  type DocumentSummary,
  type SavedDocument,
  type YouTubeChannel,
  type YouTubeVideoRef,
} from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import type {
  CaptureOptions, DiscoveredYouTubeVideo, ListingPage, RequestOptions, ResolvedYouTubeChannel, YouTubeSource,
} from '../../src/sources/youtube/adapter.js';
import { DEFAULT_POLICY } from '../../src/channels/collection-policy.js';
import { readEventFiles } from '../activity/event-files.js';

// Jobs and the YouTube request channel run together on one manual clock: a scripted YouTube answers
// through a real YouTubeGate, so cooldowns, waits and restarts follow the same rules as the app.

const VAULT = '/vaults/pacing';
const T0 = Date.parse('2026-10-15T06:00:00.000Z');
const MINUTE = 60_000;
const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const limited = () => new CollectorError('rate_limited', 'YouTube 暫時限制連線。', { detail: 'ERROR: HTTP Error 429: Too Many Requests' });
const network = () => new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。');

class MemoryVault implements DocumentVault {
  readonly documents = new Map<string, SavedDocument>();
  async getBySourceId(sourceId: string) { return this.documents.get(sourceId) ?? null; }
  async add(capture: CapturedTranscript) {
    const document: SavedDocument = {
      id: `youtube:${capture.videoId}`, type: 'Transcript', title: capture.title, sourceUrl: capture.sourceUrl,
      sourceType: 'youtube', sourceId: capture.videoId, publisher: { id: capture.channelId, name: capture.channelTitle },
      publishedAt: null, collectedAt: new Date(T0).toISOString(),
      youtube: { languageCode: capture.languageCode, languageName: null, subtitleKind: 'automatic' }, bodyMarkdown: capture.bodyMarkdown,
    };
    this.documents.set(capture.videoId, document);
    return document;
  }
  async list(): Promise<DocumentSummary[]> { return []; }
  async read(id: string) { return [...this.documents.values()].find((document) => document.id === id) ?? null; }
}

class MemoryChannels implements ChannelStore {
  readonly channels: YouTubeChannel[] = [];
  async list() { return this.channels.map((channel) => ({ ...channel })); }
  async add(channel: YouTubeChannel) { this.channels.push(channel); return channel; }
  async remove() { return false; }
  async setEnabled() { return null; }
  async update(id: string, patch: ChannelPatch) {
    const channel = this.channels.find((candidate) => candidate.id === id);
    if (!channel) return null;
    Object.assign(channel, patch);
    return { ...channel };
  }
}

interface Timer { at: number; callback: () => void; cancelled: boolean }

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** YouTube as yt-dlp would answer, every request passing the gate like YtDlpCapture does. */
class GatedSource implements YouTubeSource {
  readonly requests: string[] = [];
  readonly failures = new Map<string, CollectorError[]>();
  readonly channelVideos = new Map<string, DiscoveredYouTubeVideo[]>();
  holdNext = false;
  private readonly held: Array<() => void> = [];

  constructor(private readonly gate: YouTubeGate) {}

  releaseHeld(): void { for (const release of this.held.splice(0)) release(); }
  get heldCount(): number { return this.held.length; }

  private request<T>(name: string, answer: () => T, options: RequestOptions = {}): Promise<T> {
    return this.gate.run(options.priority ?? 'background', async () => {
      this.requests.push(name);
      if (this.holdNext) {
        this.holdNext = false;
        await new Promise<void>((resolve) => this.held.push(resolve));
      }
      const failure = this.failures.get(name)?.shift();
      if (failure) throw failure;
      return answer();
    }, options.signal);
  }

  resolveChannel(url: string, options?: RequestOptions): Promise<ResolvedYouTubeChannel> {
    return this.request(`resolve:${url}`, () => ({ id: 'UCpacingpacingpacingpaci', title: '節奏頻道', url }), options);
  }

  discover(channel: YouTubeChannel, page: ListingPage, options?: RequestOptions): Promise<DiscoveredYouTubeVideo[]> {
    return this.request(`list:${channel.id}`, () => (this.channelVideos.get(channel.id) ?? []).slice(page.offset, page.offset + page.limit), options);
  }

  async capture(video: YouTubeVideoRef, options: CaptureOptions = {}): Promise<CapturedTranscript> {
    const request = { signal: options.signal } as RequestOptions;
    await this.request(`info:${video.videoId}`, () => undefined, request);
    await this.request(`subtitles:${video.videoId}`, () => undefined, request);
    return {
      videoId: video.videoId, sourceUrl: video.canonicalUrl, title: `影片 ${video.videoId}`, channelId: null, channelTitle: '頻道',
      publishedAt: null, languageCode: 'en-orig', languageName: null, subtitleKind: 'automatic', bodyMarkdown: 'Body.',
    };
  }
}

const directories: string[] = [];
const processes: Array<{ gate: YouTubeGate; manager: JobManager; store: JobStore }> = [];
afterEach(async () => {
  for (const running of processes.splice(0)) {
    await running.manager.close().catch(() => undefined);
    await running.store.close().catch(() => undefined);
    await running.gate.flush();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function world(options: { waitMs?: number } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xr-youtube-pacing-'));
  directories.push(directory);
  let now = T0;
  const timers: Timer[] = [];
  const clock = () => new Date(now);
  const setTimer = (callback: () => void, ms: number) => {
    const timer = { at: now + ms, callback, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      await settle();
      const due = timers.filter((timer) => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      due.cancelled = true;
      due.callback();
    }
    now = target;
    await settle();
  };
  const vault = new MemoryVault();
  const channels = new MemoryChannels();
  const statePath = path.join(directory, 'youtube-pacing.json');
  const jobsPath = path.join(directory, 'jobs');
  let sequence = 0;
  const wait = options.waitMs ?? 0;

  /** One process: a gate read from its state file, a job store on disk and a manager. */
  const boot = async () => {
    const gate = await YouTubeGate.open({ statePath, now: clock, random: () => 0, setTimer, waitRangeMs: { min: wait, max: wait } });
    const store = await JobStore.open(jobsPath, clock);
    const source = new GatedSource(gate);
    const manager = new JobManager({
      vaultPath: VAULT, store, source, documents: new Collector(vault, { index: async () => undefined }), channels,
      now: clock, setTimer, createId: () => `job-${++sequence}`, pacing: gate,
    });
    processes.push({ gate, store, manager });
    return { gate, store, source, manager };
  };
  const events = async () => (await readEventFiles(jobsPath)).filter((event) => event.vaultPath === VAULT);
  return { boot, advance, clock: () => now, vault, channels, events };
}

describe('jobs during a YouTube cooldown (P-T5)', () => {
  it('waits for the cooldown without spending an attempt and then completes by itself', async () => {
    const w = await world();
    const p = await w.boot();
    p.source.failures.set('info:aaaaaaaaaaa', [limited()]);
    const first = await p.manager.submitVideo(watchUrl('aaaaaaaaaaa'));
    await w.advance(0);
    const until = new Date(T0 + 5 * MINUTE).toISOString();
    await vi.waitFor(() => expect(p.manager.get(first.job.id)).toMatchObject({ state: 'queued', wait: { reason: 'rate_limited', until } }));
    expect(p.manager.get(first.job.id).retry).toBeUndefined();
    expect(p.gate.status()).toMatchObject({ state: 'cooldown', cooldownUntil: until, level: 1 });

    // Nothing reaches YouTube during the cooldown, including work accepted meanwhile.
    const second = await p.manager.submitVideo(watchUrl('bbbbbbbbbbb'));
    await w.advance(5 * MINUTE - 1);
    expect(p.source.requests).toEqual(['info:aaaaaaaaaaa']);
    expect(p.manager.get(second.job.id).state).toBe('queued');

    await w.advance(1);
    const done = await p.manager.whenSettled(first.job.id);
    expect(done).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(done.wait).toBeUndefined();
    expect(done.retry).toBeUndefined();
    expect(await p.manager.whenSettled(second.job.id)).toMatchObject({ state: 'completed' });
    expect(p.source.requests).toEqual([
      'info:aaaaaaaaaaa', 'info:aaaaaaaaaaa', 'subtitles:aaaaaaaaaaa', 'info:bbbbbbbbbbb', 'subtitles:bbbbbbbbbbb',
    ]);
    expect(p.gate.status().level).toBe(0);

    await p.store.flush();
    const events = await w.events();
    expect(events.find((event) => event.eventType === 'youtube.rate_limited')).toMatchObject({
      severity: 'warning', jobId: null, until, level: 1, detail: 'ERROR: HTTP Error 429: Too Many Requests',
    });
    expect(events.find((event) => event.eventType === 'job.deferred')).toMatchObject({ jobId: first.job.id, until });
    expect(events.some((event) => event.eventType === 'youtube.cooldown_ended')).toBe(true);
    expect(events.some((event) => event.eventType === 'job.retry_scheduled' || event.eventType === 'job.failed')).toBe(false);
  });

  it('shows the wait on every queued job and on jobs accepted during the cooldown', async () => {
    const w = await world();
    const p = await w.boot();
    p.source.failures.set('info:jjjjjjjjjjj', [limited()]);
    const limitedJob = await p.manager.submitVideo(watchUrl('jjjjjjjjjjj'));
    const queuedJob = await p.manager.submitVideo(watchUrl('kkkkkkkkkkk'));
    const until = new Date(T0 + 5 * MINUTE).toISOString();
    await vi.waitFor(() => expect(p.manager.get(limitedJob.job.id).wait).toBeDefined());
    // The job that was only waiting in line shows the same cooldown, so the UI and Agents see why.
    expect(p.manager.get(queuedJob.job.id)).toMatchObject({ state: 'queued', wait: { reason: 'rate_limited', until } });
    const lateJob = await p.manager.submitVideo(watchUrl('lllllllllll'));
    expect(p.manager.get(lateJob.job.id)).toMatchObject({ state: 'queued', wait: { reason: 'rate_limited', until } });
    expect(p.source.requests).toEqual(['info:jjjjjjjjjjj']);

    await w.advance(5 * MINUTE);
    for (const id of [limitedJob.job.id, queuedJob.job.id, lateJob.job.id]) {
      const done = await p.manager.whenSettled(id);
      expect(done).toMatchObject({ state: 'completed' });
      expect(done.wait).toBeUndefined();
    }
    // Outside a cooldown a new job carries no wait.
    p.source.holdNext = true;
    const after = await p.manager.submitVideo(watchUrl('mmmmmmmmmmm'));
    expect(p.manager.get(after.job.id).wait).toBeUndefined();
    await vi.waitFor(() => expect(p.source.heldCount).toBe(1));
    p.source.releaseHeld();
  });

  it('shows the wait on the channel item and resumes a channel check after the cooldown', async () => {
    const w = await world();
    const p = await w.boot();
    const channel: YouTubeChannel = {
      id: 'UCpacingpacingpacingpaci', title: '節奏頻道', url: 'https://www.youtube.com/channel/UCpacingpacingpacingpaci/videos',
      enabled: true, addedAt: new Date(T0).toISOString(), settings: { ...DEFAULT_POLICY },
    };
    w.channels.channels.push(channel);
    p.source.channelVideos.set(channel.id, [{ id: 'ccccccccccc', title: '影片', url: watchUrl('ccccccccccc'), publishedAt: null, upcoming: false }]);
    p.source.failures.set('subtitles:ccccccccccc', [limited()]);
    const accepted = await p.manager.submitChannel(channel, 'manual');
    await w.advance(0);
    const until = new Date(T0 + 5 * MINUTE).toISOString();
    await vi.waitFor(() => expect(p.manager.get(accepted.job.id).items![0]).toMatchObject({ state: 'queued', wait: { reason: 'rate_limited', until } }));
    await w.advance(5 * MINUTE);
    const done = await p.manager.whenSettled(accepted.job.id);
    expect(done).toMatchObject({ state: 'completed', progress: { created: 1 } });
    expect(done.items![0]!.wait).toBeUndefined();
  });

  it('defers a channel check limited while listing, and keeps network errors at three attempts', async () => {
    const w = await world();
    const p = await w.boot();
    const channel: YouTubeChannel = {
      id: 'UCpacingpacingpacingpaci', title: '節奏頻道', url: 'https://www.youtube.com/channel/UCpacingpacingpacingpaci/videos',
      enabled: true, addedAt: new Date(T0).toISOString(), settings: { ...DEFAULT_POLICY },
    };
    w.channels.channels.push(channel);
    p.source.failures.set(`list:${channel.id}`, [limited()]);
    const check = await p.manager.submitChannel(channel, 'manual');
    await w.advance(0);
    await vi.waitFor(() => expect(p.manager.get(check.job.id)).toMatchObject({ state: 'queued', wait: { reason: 'rate_limited' } }));
    await w.advance(5 * MINUTE);
    expect(await p.manager.whenSettled(check.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'empty' } });

    p.source.failures.set('info:ddddddddddd', [network(), network(), network()]);
    const failing = await p.manager.submitVideo(watchUrl('ddddddddddd'));
    await w.advance(10 * MINUTE);
    expect(await p.manager.whenSettled(failing.job.id)).toMatchObject({
      state: 'failed', error: { code: 'network_error' }, retry: { attempts: 3, maxAttempts: 3 },
    });
  });

  it('fails a deterministic error at once', async () => {
    const w = await world();
    const p = await w.boot();
    p.source.failures.set('info:eeeeeeeeeee', [new CollectorError('no_subtitles', '這支影片沒有可取得的既有字幕。')]);
    const job = await p.manager.submitVideo(watchUrl('eeeeeeeeeee'));
    expect(await p.manager.whenSettled(job.job.id)).toMatchObject({ state: 'failed', error: { code: 'no_subtitles' } });
    expect(p.source.requests).toEqual(['info:eeeeeeeeeee']);
  });

  it('holds and closes at once during a cooldown', async () => {
    const w = await world();
    const p = await w.boot();
    p.source.failures.set('info:fffffffffff', [limited()]);
    const job = await p.manager.submitVideo(watchUrl('fffffffffff'));
    await w.advance(0);
    await vi.waitFor(() => expect(p.manager.get(job.job.id).wait).toBeDefined());
    const release = await p.manager.hold(1_000);
    release();
    await p.manager.close();
    await p.store.flush();
    expect(p.store.get(job.job.id)).toMatchObject({ state: 'interrupted', wait: { reason: 'rate_limited' } });
  });

  it('returns a step waiting for its YouTube turn to the queue when a hold starts', async () => {
    const w = await world({ waitMs: 8_000 });
    const p = await w.boot();
    p.source.holdNext = true;
    const first = await p.manager.submitVideo(watchUrl('ggggggggggg'));
    await w.advance(0);
    await vi.waitFor(() => expect(p.source.heldCount).toBe(1));
    p.source.releaseHeld();
    await w.advance(0);
    await vi.waitFor(() => expect(p.gate.status().state).toBe('waiting'));
    // The info request ended; the subtitle request now waits 8 seconds for its turn.
    expect(p.source.requests).toEqual(['info:ggggggggggg']);
    const release = await p.manager.hold(1_000);
    expect(p.manager.get(first.job.id)).toMatchObject({ state: 'queued' });
    expect(p.manager.get(first.job.id).retry).toBeUndefined();
    release();
    await w.advance(60_000);
    expect(await p.manager.whenSettled(first.job.id)).toMatchObject({ state: 'completed' });
  });
});

describe('cooldown across restarts (P-T6)', () => {
  it('keeps waiting jobs behind the cooldown after a restart', async () => {
    const w = await world();
    const first = await w.boot();
    first.source.failures.set('info:hhhhhhhhhhh', [limited()]);
    const job = await first.manager.submitVideo(watchUrl('hhhhhhhhhhh'));
    await w.advance(0);
    await vi.waitFor(() => expect(first.manager.get(job.job.id).wait).toBeDefined());
    await first.gate.flush();
    await first.manager.close();
    await first.store.close();

    await w.advance(2 * MINUTE);
    const second = await w.boot();
    expect(second.gate.status()).toMatchObject({ state: 'cooldown', level: 1 });
    await second.manager.resume();
    await w.advance(0);
    await vi.waitFor(() => expect(second.manager.get(job.job.id)).toMatchObject({ state: 'queued', wait: { reason: 'rate_limited', until: new Date(T0 + 5 * MINUTE).toISOString() } }));
    expect(second.source.requests).toEqual([]);
    await w.advance(3 * MINUTE);
    expect(await second.manager.whenSettled(job.job.id)).toMatchObject({ state: 'completed' });
    await second.manager.close();
    await second.store.close();
  });

  it('continues at once when the cooldown ended while the service was stopped', async () => {
    const w = await world();
    const first = await w.boot();
    first.source.failures.set('info:iiiiiiiiiii', [limited()]);
    const job = await first.manager.submitVideo(watchUrl('iiiiiiiiiii'));
    await w.advance(0);
    await vi.waitFor(() => expect(first.manager.get(job.job.id).wait).toBeDefined());
    await first.gate.flush();
    await first.manager.close();
    await first.store.close();

    await w.advance(6 * MINUTE);
    const second = await w.boot();
    expect(second.gate.status().state).toBe('idle');
    await second.manager.resume();
    const done = await second.manager.whenSettled(job.job.id);
    expect(done).toMatchObject({ state: 'completed' });
    expect(done.wait).toBeUndefined();
    await second.manager.close();
    await second.store.close();
  });
});
