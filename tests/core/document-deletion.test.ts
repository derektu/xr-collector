import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubscriptionPatch, SubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { Collector, type CollectorOptions } from '../../src/core/collector.js';
import {
  CollectorError,
  type SavedDocument,
  type SubscriptionRecord,
} from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import type { DiscoveredYouTubeVideo, ResolvedYouTubeChannel, YouTubeSource, CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { inspectVaultDirectory, writeVaultMarker } from '../../src/vault/vault-directory.js';
import type {
  YouTubeVideoRef,
} from '../../src/plugins/youtube/url.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import type { CapturedDocument } from '../../src/plugins/types.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';
import { youtubeKey } from '../support/youtube-documents.js';

const T0 = new Date('2026-10-16T00:00:00.000Z');
const CHANNEL = 'UCdeletiontestchannel000';

let directories: string[] = [];
let stores: JobStore[] = [];
afterEach(async () => {
  for (const store of stores) await store.flush();
  for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  directories = [];
  stores = [];
});

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const vid = (name: string) => name.padEnd(11, '0').slice(0, 11);

function captured(id: string): CapturedTranscript {
  return {
    videoId: id, sourceUrl: watchUrl(id), title: `影片 ${id}`, channelId: CHANNEL, channelTitle: '刪除測試頻道',
    publishedAt: null, languageCode: 'zh-Hant', languageName: null, subtitleKind: 'manual', bodyMarkdown: `正文 ${id}`,
  };
}

class MemoryChannels implements SubscriptionStore {
  readonly channels: SubscriptionRecord[] = [{
    id: CHANNEL, title: '刪除測試頻道', url: `https://www.youtube.com/channel/${CHANNEL}/videos`, enabled: true, addedAt: T0.toISOString(),
    settings: { intervalMinutes: 30, backfillWindow: '6m', backfillMaxItems: 50 },
  }];
  async list() { return this.channels.map((channel) => ({ ...channel })); }
  async add(channel: SubscriptionRecord) { this.channels.push(channel); return channel; }
  async remove() { return false; }
  async setEnabled() { return null; }
  async update(id: string, patch: SubscriptionPatch) {
    const channel = this.channels.find((candidate) => candidate.id === id);
    if (!channel) return null;
    Object.assign(channel, patch);
    return { ...channel };
  }
}

/** Lists the channel's videos newest first; captures wait while held and fail as told. */
class Source implements YouTubeSource {
  listing: string[] = [];
  readonly captures: string[] = [];
  readonly failures = new Map<string, CollectorError>();
  readonly held = new Set<string>();
  private readonly waiting = new Map<string, () => void>();

  async resolveChannel(): Promise<ResolvedYouTubeChannel> { throw new Error('unused'); }
  async discover(_channel: SubscriptionRecord, page: { offset: number; limit: number }): Promise<DiscoveredYouTubeVideo[]> {
    return this.listing.slice(page.offset, page.offset + page.limit)
      .map((id) => ({ id, title: `影片 ${id}`, url: watchUrl(id), publishedAt: null, upcoming: false }));
  }
  async capture(video: YouTubeVideoRef): Promise<CapturedTranscript> {
    this.captures.push(video.videoId);
    if (this.held.has(video.videoId)) await new Promise<void>((resolve) => this.waiting.set(video.videoId, resolve));
    const failure = this.failures.get(video.videoId);
    if (failure) throw failure;
    return captured(video.videoId);
  }
  async capturing(id: string): Promise<void> {
    await expect.poll(() => this.waiting.has(id)).toBe(true);
  }
  release(id: string): void {
    this.held.delete(id);
    this.waiting.get(id)?.();
    this.waiting.delete(id);
  }
}

/** A Vault, its collector with a recording search index, and job managers that can be restarted. */
async function world(options: { holdAdds?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-deletion-'));
  const jobsDirectory = await mkdtemp(path.join(tmpdir(), 'xr-deletion-jobs-'));
  directories.push(root, jobsDirectory);
  const clock = { now: new Date(T0) };
  const tick = (ms = 1000) => { clock.now = new Date(clock.now.getTime() + ms); };
  let addGate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  class GatedVault extends MarkdownVault {
    override async add(capture: CapturedDocument, addOptions?: { collectedAt?: Date }): Promise<SavedDocument> {
      const saved = await super.add(capture, addOptions);
      if (addGate) await addGate;
      return saved;
    }
  }
  const vault = options.holdAdds ? new GatedVault(root, { now: () => clock.now }) : new MarkdownVault(root, { now: () => clock.now });
  const indexed = new Map<string, SavedDocument>();
  const removed: string[] = [];
  let removeFails = false;
  let removeGate: Promise<void> | null = null;
  const search = {
    index: async (document: SavedDocument) => { indexed.set(document.id, document); },
    remove: async (id: string) => {
      removed.push(id);
      if (removeGate) await removeGate;
      if (removeFails) throw new Error('index down');
      indexed.delete(id);
    },
  };
  const events: Parameters<NonNullable<CollectorOptions['recordEvent']>>[0][] = [];
  const collector = new Collector(vault, search, { recordEvent: (entry) => events.push(entry) });
  const channels = new MemoryChannels();
  const source = new Source();
  let sequence = 0;

  async function boot(): Promise<{ store: JobStore; manager: JobManager }> {
    const store = await JobStore.open(jobsDirectory, () => clock.now);
    stores.push(store);
    const manager = new JobManager({
      vaultPath: root, store, plugins: [youtubePlugin(source)], documents: collector, subscriptions: { youtube: channels },
      limits: { discovery: 1, capture: 1 }, now: () => clock.now, createId: () => `job-${++sequence}`,
    });
    return { store, manager };
  }

  return {
    root, vault, collector, channels, source, clock, tick, indexed, removed, events, boot,
    setRemoveFails(value: boolean) { removeFails = value; },
    /** Holds index removals until the returned function runs, like a removal waiting behind a rebuild. */
    holdRemovals() { let open = () => {}; removeGate = new Promise((resolve) => { open = resolve; }); return () => { removeGate = null; open(); }; },
    holdAdd() { addGate = new Promise((resolve) => { openGate = resolve; }); },
    releaseAdd() { addGate = null; openGate?.(); },
    async collect(manager: JobManager, id: string) {
      const submission = await manager.submitItem('youtube', watchUrl(id));
      return manager.whenSettled(submission.job.id);
    },
    async checkChannel(manager: JobManager) {
      const submission = await manager.submitCheck('youtube', channels.channels[0]!, 'manual');
      return manager.whenSettled(submission.job.id);
    },
  };
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

describe('deleting a document (A1)', () => {
  it('records the deletion, removes the file and index entry, and hides it from every read', async () => {
    const w = await world();
    const { manager } = await w.boot();
    const a = vid('alpha');
    const b = vid('bravo');
    await w.collect(manager, a);
    await w.collect(manager, b);
    w.tick();

    const result = await w.collector.delete(`youtube:${a}`);

    expect(result).toEqual({
      deleted: { id: `youtube:${a}`, sourceType: 'youtube', sourceId: a, title: `影片 ${a}`, deletedAt: w.clock.now.toISOString() },
      indexed: true,
    });
    expect(await exists(path.join(w.root, 'documents/youtube', `${a}.md`))).toBe(false);
    expect(JSON.parse(await readFile(path.join(w.root, DELETIONS_FILE), 'utf8'))).toEqual({
      version: 1,
      deleted: [{
        sourceType: 'youtube', sourceId: a, sourceUrl: watchUrl(a), title: `影片 ${a}`, publisherId: CHANNEL, publisherName: '刪除測試頻道',
        deletedAt: w.clock.now.toISOString(),
      }],
    });
    expect((await w.collector.list()).map((document) => document.id)).toEqual([`youtube:${b}`]);
    expect((await w.collector.sources({ youtube: { subscriptions: w.channels.channels } })).total).toBe(1);
    expect(await w.collector.findExisting(youtubeKey(a))).toBeNull();
    expect([...w.indexed.keys()]).toEqual([`youtube:${b}`]);
    await expect(w.collector.read(`youtube:${a}`)).rejects.toMatchObject({ code: 'document_deleted' });
    await expect(w.collector.delete(`youtube:${a}`)).rejects.toMatchObject({ code: 'document_deleted' });
    await expect(w.collector.delete(`youtube:${vid('nothing')}`)).rejects.toMatchObject({ code: 'document_not_found' });
    expect(w.events).toEqual([expect.objectContaining({ eventType: 'document.deleted', severity: 'info', documentId: `youtube:${a}`, sourceId: a })]);
  });

  it('reports a failed index removal, keeps the deletion and records a warning', async () => {
    const w = await world();
    const { manager } = await w.boot();
    const a = vid('alpha');
    await w.collect(manager, a);
    w.setRemoveFails(true);

    const result = await w.collector.delete(`youtube:${a}`);

    expect(result).toMatchObject({ indexed: true });
    expect(await w.collector.list()).toEqual([]);
    await expect.poll(() => w.events.map((event) => [event.eventType, event.severity])).toEqual([
      ['document.deleted', 'info'], ['document.index_remove_failed', 'warning'],
    ]);
    expect(await w.vault.deletions.get(`youtube:${a}`)).not.toBeNull();
  });

  it('answers before the index removal finishes, so a rebuild never holds up a deletion', async () => {
    const w = await world();
    const { manager } = await w.boot();
    const a = vid('alpha');
    await w.collect(manager, a);
    const open = w.holdRemovals();

    const result = await w.collector.delete(`youtube:${a}`);

    expect(result.indexed).toBe(true);
    expect(w.removed).toEqual([`youtube:${a}`]);
    expect(w.indexed.has(`youtube:${a}`)).toBe(true);
    open();
    await expect.poll(() => w.indexed.has(`youtube:${a}`)).toBe(false);
  });

  it('reports no search exclusion when no search service runs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-deletion-nosearch-'));
    directories.push(root);
    const vault = new MarkdownVault(root);
    await vault.add(transcriptDocument(captured(vid('alpha'))));
    const result = await new Collector(vault).delete(`youtube:${vid('alpha')}`);
    expect(result).toMatchObject({ indexed: false, indexMessage: expect.stringContaining('搜尋服務尚未啟用') });
  });
});

describe('deletion transaction and recovery (A2)', () => {
  it('hides a document as soon as its record exists and finishes the deletion when the Vault opens', async () => {
    const w = await world();
    const a = vid('alpha');
    await w.vault.add(transcriptDocument(captured(a)));
    w.tick();
    // A stop right after the record was written leaves the file behind.
    await w.vault.deletions.record({ sourceType: 'youtube', sourceId: a, sourceUrl: watchUrl(a), title: 'A', publisherId: null, publisherName: 'P' });

    expect(await w.vault.list()).toEqual([]);
    expect(await w.vault.read(`youtube:${a}`)).toBeNull();
    expect(await exists(path.join(w.root, 'documents/youtube', `${a}.md`))).toBe(true);

    const recovery = await new MarkdownVault(w.root).recoverDeletions();
    expect(recovery.completed.map((record) => record.sourceId)).toEqual([a]);
    expect(recovery.cleared).toEqual([]);
    expect(await exists(path.join(w.root, 'documents/youtube', `${a}.md`))).toBe(false);
    expect(await w.vault.deletions.get(`youtube:${a}`)).not.toBeNull();
  });

  it('treats a document collected at the deletion time as deleted', async () => {
    const w = await world();
    const a = vid('alpha');
    // The clock does not move: collection and deletion carry the same time.
    await w.vault.add(transcriptDocument(captured(a)));
    const record = await w.vault.deletions.record({ sourceType: 'youtube', sourceId: a, sourceUrl: watchUrl(a), title: 'A', publisherId: null, publisherName: 'P' });
    expect(record.deletedAt).toBe(T0.toISOString());

    expect(await w.vault.read(`youtube:${a}`)).toBeNull();
    expect((await w.vault.recoverDeletions()).completed).toHaveLength(1);
  });

  it('lifts the record of an explicit re-collection that saved its document before a stop', async () => {
    const w = await world();
    const a = vid('alpha');
    await w.vault.deletions.record({ sourceType: 'youtube', sourceId: a, sourceUrl: watchUrl(a), title: 'A', publisherId: null, publisherName: 'P' });
    w.tick(1);
    await w.vault.add(transcriptDocument(captured(a)));

    expect(await w.vault.read(`youtube:${a}`)).not.toBeNull();
    const recovery = await w.vault.recoverDeletions();
    expect(recovery.cleared.map((entry) => entry.sourceId)).toEqual([a]);
    expect(await w.vault.deletions.list()).toEqual([]);
    expect(await w.vault.read(`youtube:${a}`)).not.toBeNull();
  });

  it('refuses an explicit request made at the deletion time and stamps a later one after the deletion', async () => {
    const w = await world();
    const a = vid('alpha');
    await w.vault.add(transcriptDocument(captured(a)));
    await w.collector.delete(`youtube:${a}`);

    await expect(w.collector.save(transcriptDocument(captured(a)), { explicitAt: T0.toISOString() })).rejects.toMatchObject({ code: 'document_deleted' });
    await expect(w.collector.save(transcriptDocument(captured(a)))).rejects.toMatchObject({ code: 'document_deleted' });

    // The clock still reads the deletion time; the document is stamped one millisecond later.
    const later = new Date(T0.getTime() + 1).toISOString();
    const result = await w.collector.save(transcriptDocument(captured(a)), { explicitAt: later });
    expect(result.recollected).toBe(true);
    expect(result.document.collectedAt).toBe(later);
    expect(await w.vault.deletions.list()).toEqual([]);
    expect(w.events.at(-1)).toMatchObject({ eventType: 'document.recollected', documentId: `youtube:${a}` });
  });

  it.each([
    ['missing', (text: string) => text.replace(/^ *collected_at: .*\n/mu, '')],
    ['unreadable', (text: string) => text.replace(/^( *collected_at: ).*$/mu, '$1not a time')],
  ])('keeps the file and the record, hidden, when collected_at is %s', async (_name, damage) => {
    const w = await world();
    const a = vid('alpha');
    await w.vault.add(transcriptDocument(captured(a)));
    w.tick();
    await w.vault.deletions.record({ sourceType: 'youtube', sourceId: a, sourceUrl: watchUrl(a), title: 'A', publisherId: null, publisherName: 'P' });
    const file = path.join(w.root, 'documents/youtube', `${a}.md`);
    const text = await readFile(file, 'utf8');
    const damaged = damage(text);
    expect(damaged).not.toBe(text);
    await writeFile(file, damaged);

    const recovery = await w.vault.recoverDeletions();

    expect(recovery).toMatchObject({ completed: [], cleared: [], unresolved: [expect.objectContaining({ sourceId: a })] });
    expect(await exists(file)).toBe(true);
    expect(await w.vault.deletions.get(`youtube:${a}`)).not.toBeNull();
    expect(await w.vault.list()).toEqual([]);
    expect(await w.vault.read(`youtube:${a}`)).toBeNull();
  });

  it.each([
    ['broken JSON', '{'],
    ['an unknown version', JSON.stringify({ version: 2, deleted: [] })],
    ['a malformed record', JSON.stringify({ version: 1, deleted: [{ sourceType: 'youtube', sourceId: 'short' }] })],
  ])('refuses to open a Vault whose deletions file has %s', async (_name, contents) => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-deletion-invalid-'));
    directories.push(root);
    await writeVaultMarker(root, 'test');
    await mkdir(path.join(root, 'settings'), { recursive: true });
    await writeFile(path.join(root, DELETIONS_FILE), contents);

    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('deleted-documents.json') });
  });
});

describe('deletions and collection (A4)', () => {
  it('leaves deleted videos out of channel checks, where they still take their place within the item limit', async () => {
    const w = await world();
    const { manager } = await w.boot();
    const [a, b, c] = [vid('alpha'), vid('bravo'), vid('charlie')];
    await w.collect(manager, a);
    w.tick();
    await w.collector.delete(`youtube:${a}`);
    w.channels.channels[0]!.settings = { ...w.channels.channels[0]!.settings, backfillMaxItems: 5 };
    w.source.listing = [a, b, c, vid('delta'), vid('echo'), vid('foxtrot')];

    const job = await w.checkChannel(manager);

    // The newest five are the candidates; the deleted one is dropped and not replaced by an older video.
    expect(job.items?.map((item) => item.sourceId)).toEqual([b, c, vid('delta'), vid('echo')]);
    expect(w.source.captures).toEqual([a, b, c, vid('delta'), vid('echo')]);
    expect((await w.collector.list()).map((document) => document.sourceId)).not.toContain(a);
  });

  it('collects a deleted video again only for an explicit request that succeeds, then treats it as collected', async () => {
    const w = await world();
    const { manager } = await w.boot();
    const a = vid('alpha');
    await w.collect(manager, a);
    w.tick();
    await w.collector.delete(`youtube:${a}`);
    w.tick();

    w.source.failures.set(a, new CollectorError('no_subtitles', '這支影片沒有字幕。'));
    const failed = await w.collect(manager, a);
    expect(failed.state).toBe('failed');
    expect(await w.vault.deletions.get(`youtube:${a}`)).not.toBeNull();
    w.source.listing = [a];
    expect((await w.checkChannel(manager)).result?.outcome).toBe('empty');

    // A retry of the failed single-video job is an explicit request made now.
    w.source.failures.delete(a);
    w.tick();
    const retry = await manager.retry(failed.id);
    const retried = await manager.whenSettled(retry.job.id);
    expect(retried.result).toMatchObject({ outcome: 'created', documentId: `youtube:${a}` });
    expect(await w.vault.deletions.list()).toEqual([]);
    expect(w.indexed.has(`youtube:${a}`)).toBe(true);
    expect(w.events.at(-1)).toMatchObject({ eventType: 'document.recollected' });

    const captures = w.source.captures.length;
    expect((await w.checkChannel(manager)).result?.outcome).toBe('empty');
    expect(w.source.captures).toHaveLength(captures);
  });

  it('skips a deleted video when a channel job retries its failed videos', async () => {
    const w = await world();
    const { manager } = await w.boot();
    const [a, b] = [vid('alpha'), vid('bravo')];
    w.source.listing = [a, b];
    w.source.failures.set(a, new CollectorError('capture_failed', '收集失敗。'));
    const first = await w.checkChannel(manager);
    expect(first.result?.outcome).toBe('partial');

    // The user collects the failed video directly, then deletes it.
    w.source.failures.delete(a);
    w.tick();
    await w.collect(manager, a);
    w.tick();
    await w.collector.delete(`youtube:${a}`);

    const captures = w.source.captures.length;
    const retry = await manager.retry(first.id);
    const retried = await manager.whenSettled(retry.job.id);
    expect(retried.items).toEqual([expect.objectContaining({ sourceId: a, outcome: 'skipped', skipReason: 'deleted' })]);
    expect(await w.vault.read(`youtube:${a}`)).toBeNull();
    // The deletion is checked before capture, so YouTube is not asked for the transcript.
    expect(w.source.captures).toHaveLength(captures);
  });
});

describe('deletion races (A5)', () => {
  it('does not index a document deleted between its save and its index update', async () => {
    const w = await world({ holdAdds: true });
    const { manager } = await w.boot();
    const a = vid('alpha');
    w.holdAdd();
    const submission = await manager.submitItem('youtube', watchUrl(a));
    await expect.poll(async () => exists(path.join(w.root, 'documents/youtube', `${a}.md`))).toBe(true);
    w.tick();
    const deletion = w.collector.delete(`youtube:${a}`);
    w.releaseAdd();
    await deletion;

    const job = await manager.whenSettled(submission.job.id);
    expect(job.result).toMatchObject({ outcome: 'skipped', skipReason: 'deleted' });
    expect(w.indexed.has(`youtube:${a}`)).toBe(false);
    expect(await w.collector.list()).toEqual([]);
  });

  it('skips an explicit job accepted before the deletion and collects one accepted after it', async () => {
    const w = await world();
    const { manager } = await w.boot();
    const [hold, a] = [vid('hold'), vid('alpha')];
    w.source.held.add(hold);
    const blocker = await manager.submitItem('youtube', watchUrl(hold));
    await w.source.capturing(hold);
    const early = await manager.submitItem('youtube', watchUrl(a));
    // The document arrives another way, such as an import, and is deleted while the job waits.
    w.tick();
    await w.vault.add(transcriptDocument(captured(a)));
    w.tick();
    await w.collector.delete(`youtube:${a}`);
    w.source.release(hold);
    await manager.whenSettled(blocker.job.id);

    expect((await manager.whenSettled(early.job.id)).result).toMatchObject({ outcome: 'skipped', skipReason: 'deleted' });
    expect(await w.collector.findExisting(youtubeKey(a))).toBeNull();

    w.tick();
    expect((await w.collect(manager, a)).result).toMatchObject({ outcome: 'created' });
  });

  it('collects a video again when a direct submission after the deletion joins a job queued before it', async () => {
    const w = await world();
    const { manager } = await w.boot();
    const [hold, a] = [vid('hold'), vid('alpha')];
    w.source.held.add(hold);
    const blocker = await manager.submitItem('youtube', watchUrl(hold));
    await w.source.capturing(hold);
    const early = await manager.submitItem('youtube', watchUrl(a));
    w.tick();
    await w.vault.add(transcriptDocument(captured(a)));
    w.tick();
    await w.collector.delete(`youtube:${a}`);
    w.tick();

    const again = await manager.submitItem('youtube', watchUrl(a));
    expect(again).toMatchObject({ deduplicated: true, job: { id: early.job.id } });
    w.source.release(hold);
    await manager.whenSettled(blocker.job.id);

    expect((await manager.whenSettled(early.job.id)).result).toMatchObject({ outcome: 'created', documentId: `youtube:${a}` });
    expect(await w.vault.deletions.list()).toEqual([]);
    expect(await w.collector.findExisting(youtubeKey(a))).not.toBeNull();
  });

  it('takes the latest direct submission of a video a channel job queued', async () => {
    const w = await world();
    const { manager } = await w.boot();
    const [hold, a] = [vid('hold'), vid('alpha')];
    w.source.listing = [hold, a];
    w.source.held.add(hold);
    const channel = await manager.submitCheck('youtube', w.channels.channels[0]!, 'manual');
    await w.source.capturing(hold);
    // The user claims the queued video, the document arrives and is deleted, then the user asks again.
    expect(await manager.submitItem('youtube', watchUrl(a))).toMatchObject({ deduplicated: true });
    w.tick();
    await w.vault.add(transcriptDocument(captured(a)));
    w.tick();
    await w.collector.delete(`youtube:${a}`);
    w.tick();
    expect(await manager.submitItem('youtube', watchUrl(a))).toMatchObject({ deduplicated: true });
    w.source.release(hold);

    const job = await manager.whenSettled(channel.job.id);
    expect(job.items).toContainEqual(expect.objectContaining({ sourceId: a, outcome: 'created' }));
    expect(await w.vault.deletions.list()).toEqual([]);
  });

  it('does not bring a document back through jobs resumed after a restart', async () => {
    const w = await world();
    const first = await w.boot();
    const [a, b] = [vid('alpha'), vid('bravo')];
    w.source.listing = [a, b];
    w.source.held.add(a);
    await first.manager.submitCheck('youtube', w.channels.channels[0]!, 'manual');
    await w.source.capturing(a);
    const explicit = await first.manager.submitItem('youtube', watchUrl(b));
    // Both videos exist and are deleted while the jobs wait; then the service stops abruptly.
    w.tick();
    await w.vault.add(transcriptDocument(captured(a)));
    await w.vault.add(transcriptDocument(captured(b)));
    w.tick();
    await w.collector.delete(`youtube:${a}`);
    await w.collector.delete(`youtube:${b}`);
    await first.store.flush();

    const second = await w.boot();
    await second.manager.resume();
    w.source.release(a);
    expect((await second.manager.whenSettled(explicit.job.id)).result).toMatchObject({ outcome: 'skipped', skipReason: 'deleted' });
    await expect.poll(() => second.manager.isBusy()).toBe(false);
    expect(await w.collector.list()).toEqual([]);
    expect(w.indexed.size).toBe(0);
  });

  it('removes the index entry of a document deleted while its index update runs', async () => {
    const w = await world();
    const a = vid('alpha');
    const document = await w.vault.add(transcriptDocument(captured(a)));
    const indexing = w.collector.index(document);
    w.tick();
    const deletion = w.collector.delete(`youtube:${a}`);
    await Promise.all([indexing, deletion]);
    expect(w.indexed.has(`youtube:${a}`)).toBe(false);
  });
});
