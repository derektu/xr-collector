// Broken, a video the user deleted comes back on its own or still shows in reads and search.
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Collector, type CollectorOptions } from '../../../src/domain/vault/collector.js';
import { CollectorError } from '../../../src/shared/lib/collector-error.js';
import type { SavedDocument } from '../../../src/shared/documents/document-types.js';
import type { SubscriptionRecord } from '../../../src/shared/subscriptions/subscription-types.js';
import { JobManager } from '../../../src/domain/jobs/job-manager.js';
import type { JobStore } from '../../../src/domain/jobs/job-store.js';
import { openJobRecords } from '../../../src/app/runtime/job-records.js';
import type { DiscoveredYouTubeVideo, ResolvedYouTubeChannel, YouTubeSource, CapturedTranscript } from '../../../src/domain/sources/youtube/adapter.js';
import { DELETIONS_FILE } from '../../../src/domain/vault/deleted-documents.js';
import { MarkdownVault } from '../../../src/domain/vault/markdown-vault.js';
import { inspectVaultDirectory, writeVaultMarker } from '../../../src/domain/vault/vault-directory.js';
import type {
  YouTubeVideoRef,
} from '../../../src/domain/sources/youtube/url.js';
import { youtubePlugin } from '../../../src/domain/sources/youtube/server.js';
import type { CapturedDocument, SubscriptionTarget } from '../../../src/shared/sources/source-contract.js';
import { transcriptDocument } from '../../../src/domain/sources/youtube/server.js';
import { SubscriptionRecorder } from '../../support/subscription-recorder.js';
import { HeldCaptures } from '../../support/held-captures.js';
import { youtubeKey } from '../../support/youtube-documents.js';
import { eventually } from '../../support/wait.js';
import { VaultFileWriter } from '../../../src/domain/vault/vault-files.js';
import { eventSpec } from '../../../src/shared/activity/event-catalog.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';
import { recordingLog } from '../../support/log.js';

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

const SUBSCRIPTION: SubscriptionRecord = {
  id: CHANNEL, title: '刪除測試頻道', url: `https://www.youtube.com/channel/${CHANNEL}/videos`, enabled: true, addedAt: T0.toISOString(), updatedAt: T0.toISOString(),
  settings: { intervalMinutes: 30, backfillDays: 60, backfillMaxItems: 50, documentStatus: 'published' },
};

class Source implements YouTubeSource {
  listing: string[] = [];
  readonly captures: string[] = [];
  readonly failures = new Map<string, CollectorError>();
  readonly held = new Set<string>();
  readonly holds = new HeldCaptures();

  async resolveChannel(): Promise<ResolvedYouTubeChannel> { throw new Error('unused'); }
  async discover(_channel: SubscriptionTarget, page: { offset: number; limit: number }): Promise<DiscoveredYouTubeVideo[]> {
    return this.listing.slice(page.offset, page.offset + page.limit)
      .map((id) => ({ id, title: `影片 ${id}`, url: watchUrl(id), publishedAt: null, upcoming: false }));
  }
  async capture(video: YouTubeVideoRef): Promise<CapturedTranscript> {
    this.captures.push(video.videoId);
    if (this.held.has(video.videoId)) await this.holds.hold(video.videoId);
    const failure = this.failures.get(video.videoId);
    if (failure) throw failure;
    return captured(video.videoId);
  }
  capturing(id: string): Promise<void> {
    return this.holds.started(id);
  }
  release(id: string): void {
    this.held.delete(id);
    if (this.holds.has(id)) this.holds.release(id);
  }
}

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-deletion-'));
  const jobsDirectory = await mkdtemp(path.join(tmpdir(), 'xr-deletion-jobs-'));
  directories.push(root, jobsDirectory);
  const clock = { now: new Date(T0) };
  const tick = (ms = 1000) => { clock.now = new Date(clock.now.getTime() + ms); };
  const vault = new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES), { now: () => clock.now });
  const indexed = new Map<string, SavedDocument>();
  const removed: string[] = [];
  let removeGate: Promise<void> | null = null;
  const search = {
    index: async (document: SavedDocument) => { indexed.set(document.id, document); },
    remove: async (id: string) => {
      removed.push(id);
      if (removeGate) await removeGate;
      indexed.delete(id);
    },
  };
  const events: Parameters<NonNullable<CollectorOptions['recordEvent']>>[0][] = [];
  const collector = new Collector(vault, search, { log: recordingLog(), recordEvent: (entry) => events.push({ ...entry, severity: entry.severity ?? eventSpec(entry.eventType)!.severity }) });
  const subs = new SubscriptionRecorder();
  const subscription = subs.add('youtube', SUBSCRIPTION, { settings: SUBSCRIPTION.settings });
  const source = new Source();
  let sequence = 0;

  async function boot(): Promise<{ store: JobStore; manager: JobManager }> {
    const store = (await openJobRecords(jobsDirectory, PRODUCT_SOURCES, { log: recordingLog(), now: () => clock.now })).jobs;
    stores.push(store);
    const manager = new JobManager({
      log: recordingLog(),
      sources: PRODUCT_SOURCES,
      vaultPath: root, vaultId: 'vault-id', store, plugins: [youtubePlugin(source)], documents: collector, subscriptions: subs,
      limits: { discovery: 1, capture: 1 }, now: () => clock.now, createId: () => `job-${++sequence}`,
    });
    subs.attach(manager);
    return { store, manager };
  }

  return {
    root, vault, collector, subs, subscription, source, clock, tick, indexed, removed, events, boot,
    holdRemovals() { let open = () => {}; removeGate = new Promise((resolve) => { open = resolve; }); return () => { removeGate = null; open(); }; },
    async collect(manager: JobManager, id: string) {
      const submission = await manager.submitItem('youtube', watchUrl(id));
      return manager.whenSettled(submission.job.id);
    },
    async checkChannel(manager: JobManager) {
      const submission = await manager.submitCheck('youtube', subscription, 'manual');
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
    expect((await w.collector.sources({ youtube: { subscriptions: [SUBSCRIPTION] } })).total).toBe(1);
    expect(await w.collector.findExisting(youtubeKey(a))).toBeNull();
    expect([...w.indexed.keys()]).toEqual([`youtube:${b}`]);
    await expect(w.collector.read(`youtube:${a}`)).rejects.toMatchObject({ code: 'document_deleted' });
    await expect(w.collector.delete(`youtube:${a}`)).rejects.toMatchObject({ code: 'document_deleted' });
    await expect(w.collector.delete(`youtube:${vid('nothing')}`)).rejects.toMatchObject({ code: 'document_not_found' });
    expect(w.events).toEqual([expect.objectContaining({ eventType: 'document.deleted', severity: 'info', documentId: `youtube:${a}`, sourceId: a })]);
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
    await eventually(() => expect(w.indexed.has(`youtube:${a}`)).toBe(false));
  });

  it('reports no search exclusion when no search service runs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-deletion-nosearch-'));
    directories.push(root);
    const vault = new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES));
    await vault.add(transcriptDocument(captured(vid('alpha'))));
    const result = await new Collector(vault, undefined, { log: recordingLog() }).delete(`youtube:${vid('alpha')}`);
    expect(result).toMatchObject({ indexed: false, indexMessage: expect.stringContaining('搜尋服務尚未啟用') });
  });
});

describe('visibility and re-collection (A2)', () => {
  it.each<[string, number, ((text: string) => string) | null, boolean]>([
    ['collected before the deletion is hidden', -1000, null, false],
    ['collected at the deletion time is hidden', 0, null, false],
    ['collected after the deletion shows', 1, null, true],
    ['with collected_at missing is hidden', -1000, (text) => text.replace(/^ *collected_at: .*\n/mu, ''), false],
    ['with collected_at unreadable is hidden', -1000, (text) => text.replace(/^( *collected_at: ).*$/mu, '$1not a time'), false],
  ])('a file with a deletion record %s, and the file stays on disk either way', async (_rule, collectedAfterMs, damage, shown) => {
    const w = await world();
    const a = vid('alpha');
    const deletedAt = new Date(T0.getTime() + 1000);
    w.clock.now = new Date(deletedAt.getTime() + collectedAfterMs);
    await w.vault.add(transcriptDocument(captured(a)));
    w.clock.now = deletedAt;
    await w.vault.deletions.record({ sourceType: 'youtube', sourceId: a, sourceUrl: watchUrl(a), title: 'A', publisherId: null, publisherName: 'P' });
    const file = path.join(w.root, 'documents/youtube', `${a}.md`);
    if (damage) {
      const text = await readFile(file, 'utf8');
      expect(damage(text)).not.toBe(text);
      await writeFile(file, damage(text));
    }

    expect((await w.vault.list()).map((document) => document.sourceId)).toEqual(shown ? [a] : []);
    expect(await w.vault.read(`youtube:${a}`) !== null).toBe(shown);
    expect(await exists(file)).toBe(true);
  });

  it.each([
    ['removed with the deletion', true],
    ['left on disk beside the deletion record', false],
  ])('refuses an explicit request made at the deletion time and saves a later one anew, with the file %s', async (_case, removeFile) => {
    const w = await world();
    const a = vid('alpha');
    await w.vault.add(transcriptDocument(captured(a)));
    if (removeFile) await w.collector.delete(`youtube:${a}`);
    else await w.vault.deletions.record({ sourceType: 'youtube', sourceId: a, sourceUrl: watchUrl(a), title: 'A', publisherId: null, publisherName: 'P' });

    await expect(w.collector.save(transcriptDocument(captured(a)), { explicitAt: T0.toISOString(), status: 'published' })).rejects.toMatchObject({ code: 'document_deleted' });
    await expect(w.collector.save(transcriptDocument(captured(a)))).rejects.toMatchObject({ code: 'document_deleted' });

    const later = new Date(T0.getTime() + 1).toISOString();
    const result = await w.collector.save(transcriptDocument({ ...captured(a), bodyMarkdown: '重新收集的正文' }), { explicitAt: later, status: 'published' });
    expect(result.document.collectedAt).toBe(later);
    expect(await readFile(path.join(w.root, 'documents/youtube', `${a}.md`), 'utf8')).toContain('重新收集的正文');
    expect(await w.vault.deletions.list()).toEqual([]);
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

    expect(await inspectVaultDirectory(root, PRODUCT_SOURCES)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('deleted-documents.json') });
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
    w.subscription.settings = { ...w.subscription.settings, backfillMaxItems: 5 };
    w.source.listing = [a, b, c, vid('delta'), vid('echo'), vid('foxtrot')];

    const job = await w.checkChannel(manager);

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

    w.source.failures.delete(a);
    w.tick();
    const retry = await manager.retry(failed.id);
    const retried = await manager.whenSettled(retry.job.id);
    expect(retried.result).toMatchObject({ outcome: 'created', documentId: `youtube:${a}` });
    expect(await w.vault.deletions.list()).toEqual([]);
    expect(w.indexed.has(`youtube:${a}`)).toBe(true);

    const captures = w.source.captures.length;
    expect((await w.checkChannel(manager)).result?.outcome).toBe('empty');
    expect(w.source.captures).toHaveLength(captures);
  });
});

describe('explicit requests and the deletion time (A5)', () => {
  it('skips an explicit job accepted before the deletion and collects one accepted after it', async () => {
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
    w.source.release(hold);
    await manager.whenSettled(blocker.job.id);

    expect((await manager.whenSettled(early.job.id)).result).toMatchObject({ outcome: 'skipped', skipReason: 'deleted' });
    expect(await w.collector.findExisting(youtubeKey(a))).toBeNull();

    w.tick();
    expect((await w.collect(manager, a)).result).toMatchObject({ outcome: 'created' });
  });
});
