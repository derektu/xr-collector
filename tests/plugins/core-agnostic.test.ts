import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { Collector } from '../../src/core/collector.js';
import { registerSourceDefinitions } from '../../src/core/source-registry.js';
import { CollectorError, type CollectionJob, type SubscriptionRecord } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { PacingGate } from '../../src/pacing/pacing-gate.js';
import { CollectionScheduler, type ScheduleStore, type StoredSchedule } from '../../src/subscriptions/scheduler.js';
import { SubscriptionService } from '../../src/subscriptions/subscription-service.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { importNewVault } from '../../src/vault/vault-import.js';
import { itemStates } from '../../src/vault/vault-merge.js';
import { registeredFiles, registeredSource } from '../../src/vault/vault-package.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import type { VaultWorkspace } from '../../src/vault/workspace.js';
import type { CapturedDocument, SourcePlugin } from '../../src/plugins/types.js';
import { createFakePlugin, FAKE, FAKE2, FAKE_DEFAULTS, FakeSource, type FakeSettings } from '../support/fake-source-plugin.js';
import { youtubePlugins } from '../support/youtube-sources.js';
import { cleanUp, importFile, machine, open, seed, temp, type Machine } from '../vault/exchange-fixtures.js';

// The core collects, subscribes, paces, deletes and resumes for source types it never names: two
// fake types in separate pacing groups run through the same job manager, subscription services,
// scheduler and Markdown Vault the product assembles for YouTube.

registerSourceDefinitions([FAKE, FAKE2]);

const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

class MemoryScheduleStore implements ScheduleStore {
  constructor(private value: StoredSchedule = { enabled: true }) {}
  async load(): Promise<StoredSchedule> { return { ...this.value }; }
  async save(value: StoredSchedule): Promise<void> { this.value = { ...value }; }
}

interface Timer { ms: number; run: () => void; cancelled: boolean }

const itemUrl = (type: string, key: string) => `https://${type}.example/item/${key}`;
const feedUrl = (type: string, id: string) => `https://${type}.example/feed/${id}`;

/**
 * One Vault with both fake types assembled as the workspace assembles plugins: a Markdown Vault
 * with deletion records, one subscription file and service per type, one pacing gate per group, a
 * scheduler over every type and a controllable clock. Retry and cooldown timers fire only when the
 * test fires them. `restart()` builds new services on the same Vault and job record.
 */
async function world(options: { retry?: { maxAttempts: number; delaysMs: number[] }; capture?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-core-agnostic-'));
  const jobsDirectory = await mkdtemp(path.join(tmpdir(), 'xr-core-agnostic-jobs-'));
  roots.push(root, jobsDirectory);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  const timers: Timer[] = [];
  const setTimer = (run: () => void, ms: number) => {
    const timer: Timer = { ms, run, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const sources = { fake: new FakeSource('fake'), fake2: new FakeSource('fake2') };
  const gates = {
    fake: await PacingGate.open(FAKE.pacing!, { now, setTimer, statePath: null }),
    fake2: await PacingGate.open(FAKE2.pacing!, { now, setTimer, statePath: null }),
  };
  const plugins = [createFakePlugin(FAKE, sources.fake, gates.fake), createFakePlugin(FAKE2, sources.fake2, gates.fake2)];
  const indexed = new Set<string>();
  const search = {
    index: async (document: { id: string }) => { indexed.add(document.id); },
    remove: async (id: string) => { indexed.delete(id); },
  };
  const schedule = new MemoryScheduleStore();
  const build = async () => {
    const store = await JobStore.open(jobsDirectory, now);
    const vault = new MarkdownVault(root, { now });
    const collector: Collector = new Collector(vault, search, { recordEvent: (entry) => jobs.recordEvent(entry) });
    const stores = { fake: new JsonSubscriptionStore(root, 'fake', now), fake2: new JsonSubscriptionStore(root, 'fake2', now) };
    let services!: Record<'fake' | 'fake2', SubscriptionService>;
    const jobs: JobManager = new JobManager({
      vaultPath: root, store, plugins, documents: collector, subscriptions: stores, now, setTimer,
      pacing: [gates.fake, gates.fake2],
      limits: { discovery: 1, capture: options.capture ?? 2 },
      retry: options.retry ?? { maxAttempts: 1, delaysMs: [MINUTE] },
      checkSubscription: async (type, id) => (await services[type as 'fake' | 'fake2'].startRun({ trigger: 'manual', channelIds: [id] }))[0]!,
    });
    let scheduler!: CollectionScheduler;
    const service = (type: 'fake' | 'fake2') => new SubscriptionService(type, stores[type], jobs, {
      autoCollection: () => scheduler.isEnabled(),
      resolveTarget: (url, signal) => plugins.find((plugin) => plugin.id === type)!.resolveTarget!(url, { priority: 'interactive', signal }),
      documents: () => collector.list(),
      deleteDocument: (id) => collector.delete(id),
      recordDeletion: (entry) => collector.recordDeletion(entry),
      loginRequired: () => !sources[type].signedIn,
      now, removalSettleMs: 5_000,
    });
    services = { fake: service('fake'), fake2: service('fake2') };
    scheduler = new CollectionScheduler([services.fake, services.fake2], schedule, { now, pollIntervalMs: 24 * 60 * MINUTE });
    return { store, vault, collector, stores, jobs, services, scheduler };
  };
  let current = await build();
  const w = {
    root, jobsDirectory, clock, sources, gates, timers, indexed,
    get jobs() { return current.jobs; },
    get collector() { return current.collector; },
    get vault() { return current.vault; },
    get stores() { return current.stores; },
    get store() { return current.store; },
    get scheduler() { return current.scheduler; },
    service(type: 'fake' | 'fake2') { return current.services[type]; },
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); },
    /** Fires the timers that are due, as time passing would. */
    fire() {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
    },
    async subscribe(type: 'fake' | 'fake2', id: string, settings: Partial<FakeSettings> = {}): Promise<CollectionJob> {
      const added = await current.jobs.whenSettled((await current.services[type].add(feedUrl(type, id), settings)).job.id);
      expect(added.result).toMatchObject({ outcome: 'created' });
      return current.jobs.whenSettled(added.result!.followUpJobId!);
    },
    async subscription(type: 'fake' | 'fake2', id: string): Promise<SubscriptionRecord | undefined> {
      return (await current.stores[type].list()).find((record) => record.id === id);
    },
    async checkStatus(type: 'fake' | 'fake2', id: string) {
      return (await current.services[type].listSubscriptions()).find((entry) => entry.id === id)?.checkStatus;
    },
    async idle() { await vi.waitFor(() => expect(current.jobs.isBusy()).toBe(false)); },
    async restart() {
      await current.jobs.close();
      await current.store.flush();
      current = await build();
      await current.jobs.resume();
    },
    async close() {
      await current.scheduler.close();
      await current.jobs.close();
      await current.store.flush();
    },
  };
  return w;
}

const itemsOf = (job: CollectionJob) => job.items!.map((item) => [item.sourceId, item.skipReason ?? item.outcome]);

describe('single items of a type the core does not name (P-T2)', () => {
  it('collects one item into its type\'s folder with the type\'s own frontmatter, and deduplicates a repeated request', async () => {
    const w = await world();
    const first = await w.jobs.submitItem('fake', itemUrl('fake', 'alpha-1'));
    const repeated = await w.jobs.submitItem('fake', itemUrl('fake', 'alpha-1'));
    expect(first.job.kind).toBe('fake.item');
    expect(repeated).toMatchObject({ deduplicated: true, job: { id: first.job.id } });
    expect(await w.jobs.whenSettled(first.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created', documentId: 'fake:alpha-1' } });

    const again = await w.jobs.submit('fake', itemUrl('fake', 'alpha-1'));
    expect(await w.jobs.whenSettled(again.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'existing', documentId: 'fake:alpha-1' } });
    expect(w.sources.fake.captures).toEqual(['alpha-1']);

    const file = path.join(w.root, 'documents/fake/alpha-1.md');
    const front = parse((await readFile(file, 'utf8')).split('\n---\n')[0]!.replace(/^---\n/u, '')) as Record<string, any>;
    expect(front).toMatchObject({
      type: 'Article', title: '單篇 alpha-1', resource: itemUrl('fake', 'alpha-1'),
      collector: { id: 'fake:alpha-1', source: 'fake', source_id: 'alpha-1', publisher: 'fake 作者', fake_detail: { rating: 7 } },
    });
    expect(front.collector).not.toHaveProperty('subtitle');
    const document = await w.collector.read('fake:alpha-1');
    expect(document).toMatchObject({ sourceType: 'fake', sourceId: 'alpha-1', type: 'Article', fake: { rating: 7, note: null } });
    expect(w.indexed.has('fake:alpha-1')).toBe(true);
    await w.close();
  });

  it('keeps two types apart: the same key is two documents, and an address of one type is not the other\'s', async () => {
    const w = await world();
    const one = await w.jobs.submitItem('fake', itemUrl('fake', 'same-key'));
    const two = await w.jobs.submitItem('fake2', itemUrl('fake2', 'same-key'));
    expect(two.deduplicated).toBe(false);
    await w.jobs.whenSettled(one.job.id);
    await w.jobs.whenSettled(two.job.id);
    expect((await w.collector.list()).map((document) => document.id).sort()).toEqual(['fake2:same-key', 'fake:same-key']);
    expect(existsSync(path.join(w.root, 'documents/fake2/same-key.md'))).toBe(true);
    await expect(w.jobs.submitItem('fake', itemUrl('fake2', 'other'))).rejects.toMatchObject({ code: 'invalid_url' });
    await w.close();
  });
});

describe('subscriptions of a type the core does not name (P-T2)', () => {
  it('previews, subscribes and collects the newest items within the range at the first check', async () => {
    const w = await world();
    const keys = w.sources.fake.addFeed('news', w.clock.now, [1, 2, 3, 4, 5, 60]);
    const preview = await w.service('fake').preview(feedUrl('fake', 'news'));
    expect(preview).toEqual({
      channel: { id: 'news', title: 'fake 動態 news', url: feedUrl('fake', 'news') },
      subscription: null, settings: FAKE_DEFAULTS, autoCollection: true,
    });

    const first = await w.subscribe('fake', 'news', { maxItems: 3 });
    expect(first).toMatchObject({ kind: 'fake.feed', state: 'completed', scope: { trigger: 'subscribe' }, source: { type: 'fake', id: 'news' } });
    expect(itemsOf(first)).toEqual([[keys[0], 'created'], [keys[1], 'created'], [keys[2], 'created']]);
    expect(await w.subscription('fake', 'news')).toMatchObject({ enabled: true, settings: { ...FAKE_DEFAULTS, maxItems: 3 } });
    expect(JSON.parse(await readFile(path.join(w.root, 'settings/fake-feeds.json'), 'utf8'))).toMatchObject({ version: 1, feeds: [{ id: 'news' }] });
    expect(await w.service('fake').preview(feedUrl('fake', 'news'))).toMatchObject({ subscription: { enabled: true, settings: { maxItems: 3 } } });
    expect((await w.collector.read(`fake:${keys[0]}`))).toMatchObject({ publisher: { id: 'news', name: 'fake 動態 news' }, fake: { note: '來自 fake 動態 news' } });
    await w.close();
  });

  it('takes the newest N in range at every check without filling in for collected items, and remembers items outside the range', async () => {
    const w = await world();
    const keys = w.sources.fake.addFeed('daily', w.clock.now, [1, 2, 3, 4, 5]);
    // The listing dates the newest item within the range; its exact time, which the capture reads, is not.
    w.sources.fake.feed('daily').items.unshift({ key: 'daily-old', title: '舊文', publishedAt: new Date(w.clock.now.getTime() - 90 * DAY).toISOString(), listedAt: new Date(w.clock.now.getTime() - DAY / 2).toISOString() });
    w.sources.fake.feed('daily').items.unshift({ key: 'daily-soon', title: '預告', publishedAt: null, eligible: false });
    await w.jobs.whenSettled((await w.jobs.submitItem('fake', itemUrl('fake', keys[1]!))).job.id);
    w.sources.fake.captures.length = 0;

    const first = await w.subscribe('fake', 'daily', { maxItems: 3 });
    expect(itemsOf(first)).toEqual([['daily-old', 'out_of_range'], [keys[0], 'created']]);
    expect([...w.sources.fake.captures].sort()).toEqual(['daily-00', 'daily-old']);
    expect((await w.subscription('fake', 'daily'))!.outOfRange).toEqual([{ itemKey: 'daily-old', before: expect.any(String) }]);

    // An immediate check takes the same candidates and does not ask for the remembered item again.
    w.advance(MINUTE);
    const [immediate] = await w.service('fake').startRun({ trigger: 'manual', channelIds: ['daily'] });
    const checked = await w.jobs.whenSettled(immediate!.job.id);
    expect(checked.scope).toEqual({ trigger: 'manual' });
    expect(itemsOf(checked)).toEqual([]);
    expect([...w.sources.fake.captures].sort()).toEqual(['daily-00', 'daily-old']);

    // A scheduled check after the interval finds a new item and collects it.
    w.sources.fake.feed('daily').items.unshift({ key: 'daily-new', title: '新文', publishedAt: w.clock.now.toISOString() });
    w.advance(FAKE_DEFAULTS.intervalMinutes * MINUTE);
    await w.scheduler.checkNow();
    await w.idle();
    const scheduled = w.jobs.list({ limit: 50 }).jobs.find((job) => job.kind === 'fake.feed' && job.scope?.trigger === 'scheduled')!;
    expect(itemsOf(scheduled)).toEqual([['daily-new', 'created']]);
    expect([...w.sources.fake.captures].sort()).toEqual(['daily-00', 'daily-new', 'daily-old']);
    await w.close();
  });

  it('retries a transient failure automatically and leaves other failures to the next check', async () => {
    const w = await world({ retry: { maxAttempts: 3, delaysMs: [MINUTE] } });
    const [key] = w.sources.fake.addFeed('flaky', w.clock.now, [1]);
    w.sources.fake.fail(key!, new CollectorError('network_error', '連線中斷。'));
    const request = await w.jobs.submitItem('fake', itemUrl('fake', key!));
    await vi.waitFor(() => expect(w.jobs.get(request.job.id)).toMatchObject({ state: 'queued', retry: { attempts: 1, maxAttempts: 3 } }));
    w.fire();
    expect(await w.jobs.whenSettled(request.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created' }, retry: { attempts: 1 } });
    expect(w.sources.fake.captures).toEqual([key, key]);

    const [other] = w.sources.fake.addFeed('broken', w.clock.now, [1]);
    w.sources.fake.fail(other!, new CollectorError('capture_failed', '擷取失敗。'));
    const failed = await w.jobs.whenSettled((await w.jobs.submitItem('fake', itemUrl('fake', other!))).job.id);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'capture_failed' } });
    expect(failed.retry).toBeUndefined();
    await w.close();
  });

  it('holds only the requests of the group the source limited', async () => {
    const w = await world();
    const events: string[] = [];
    const record = w.jobs.recordEvent.bind(w.jobs);
    vi.spyOn(w.jobs, 'recordEvent').mockImplementation((entry) => { events.push(entry.eventType); record(entry); });
    w.sources.fake.fail('limited-1', new CollectorError('rate_limited', '來源暫時限制連線。'));
    const limited = await w.jobs.submitItem('fake', itemUrl('fake', 'limited-1'));
    await vi.waitFor(() => expect(w.jobs.get(limited.job.id)).toMatchObject({ state: 'queued', wait: { reason: 'rate_limited' } }));
    expect(w.gates.fake.status()).toMatchObject({ state: 'cooldown' });
    expect(w.gates.fake2.status()).toMatchObject({ state: 'idle' });

    const held = await w.jobs.submitItem('fake', itemUrl('fake', 'waiting-1'));
    const other = await w.jobs.submitItem('fake2', itemUrl('fake2', 'free-1'));
    expect(await w.jobs.whenSettled(other.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(w.jobs.get(held.job.id).state).toBe('queued');
    expect(w.sources.fake.captures).toEqual(['limited-1']);
    expect(events).toContain('fake-net.rate_limited');

    w.advance(10 * MINUTE);
    w.fire();
    expect(await w.jobs.whenSettled(limited.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(await w.jobs.whenSettled(held.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(events).toContain('fake-net.cooldown_ended');
    expect(events.some((event) => event.startsWith('fake2-net.'))).toBe(false);
    await w.close();
  });

  it('pauses and resumes a subscription', async () => {
    const w = await world();
    w.sources.fake.addFeed('rest', w.clock.now, [1]);
    await w.subscribe('fake', 'rest');
    const paused = await w.service('fake').setEnabled('rest', false);
    expect(paused).toMatchObject({ channel: { id: 'rest', enabled: false }, submission: null });
    await expect(w.service('fake').startRun({ trigger: 'manual', channelIds: ['rest'] })).rejects.toMatchObject({ code: 'channel_paused' });
    w.sources.fake.feed('rest').items.unshift({ key: 'rest-back', title: '回來', publishedAt: w.clock.now.toISOString() });
    const resumed = await w.service('fake').setEnabled('rest', true);
    const check = await w.jobs.whenSettled(resumed.submission!.job.id);
    expect(check).toMatchObject({ kind: 'fake.feed', scope: { trigger: 'resume' } });
    expect(itemsOf(check)).toEqual([['rest-back', 'created']]);
    await w.close();
  });

  it('removes a subscription with its documents, also one still capturing', async () => {
    const w = await world();
    const keys = w.sources.fake.addFeed('leaving', w.clock.now, [1]);
    await w.subscribe('fake', 'leaving');
    w.sources.fake.feed('leaving').items.unshift({ key: 'leaving-late', title: '晚到', publishedAt: w.clock.now.toISOString() });
    w.sources.fake.held.add('leaving-late');
    w.advance(MINUTE);
    const [check] = await w.service('fake').startRun({ trigger: 'manual', channelIds: ['leaving'] });
    await vi.waitFor(() => expect(w.sources.fake.running()).toEqual(['leaving-late']));

    const removal = w.service('fake').remove('leaving', { documents: 'delete' });
    await vi.waitFor(async () => expect(await w.collector.isDeletedFor({ sourceType: 'fake', sourceId: 'leaving-late' }, { explicitAt: null })).toBe(true));
    w.sources.fake.release('leaving-late');
    expect(await removal).toEqual({ documentsKept: 0, documentsDeleted: 1, documentsFailed: 0 });
    await w.jobs.whenSettled(check!.job.id);
    expect(await w.collector.list()).toEqual([]);
    expect(await w.stores.fake.list()).toEqual([]);
    const ledger = JSON.parse(await readFile(path.join(w.root, DELETIONS_FILE), 'utf8')) as { deleted: Array<{ sourceType: string; sourceId: string }> };
    expect(ledger.deleted.map((entry) => `${entry.sourceType}:${entry.sourceId}`).sort()).toEqual([`fake:${keys[0]}`, 'fake:leaving-late']);
    await w.close();
  });

  it('passes over a deleted item in later checks and collects it again on an explicit request', async () => {
    const w = await world();
    const [key] = w.sources.fake.addFeed('kept', w.clock.now, [1]);
    await w.subscribe('fake', 'kept');
    await w.collector.delete(`fake:${key}`);
    w.advance(MINUTE);
    const check = await w.jobs.whenSettled((await w.service('fake').startRun({ trigger: 'manual', channelIds: ['kept'] }))[0]!.job.id);
    expect(itemsOf(check)).toEqual([]);
    expect(w.sources.fake.captures).toEqual([key]);

    const explicit = await w.jobs.whenSettled((await w.jobs.submitItem('fake', itemUrl('fake', key!))).job.id);
    expect(explicit).toMatchObject({ state: 'completed', result: { outcome: 'created' } });
    expect(await w.collector.read(`fake:${key}`)).toMatchObject({ sourceType: 'fake', sourceId: key });
    await w.close();
  });

  it('resumes the work of a stopped manager without capturing saved items again', async () => {
    const w = await world({ capture: 1 });
    const keys = w.sources.fake.addFeed('resume', w.clock.now, [1, 2]);
    w.sources.fake.held.add(keys[0]!);
    const added = await w.jobs.whenSettled((await w.service('fake').add(feedUrl('fake', 'resume'))).job.id);
    await vi.waitFor(() => expect(w.sources.fake.running()).toEqual([keys[0]]));

    // The manager stops while the first capture runs: it finishes and saves, the second never starts.
    const restarting = w.restart();
    w.sources.fake.release(keys[0]!);
    await restarting;
    const resumed = await w.jobs.whenSettled(added.result!.followUpJobId!);
    expect(resumed).toMatchObject({ state: 'completed', recovery: { resumedCount: 1 } });
    expect(itemsOf(resumed)).toEqual([[keys[0], 'created'], [keys[1], 'created']]);
    expect(w.sources.fake.captures.filter((key) => key === keys[0])).toHaveLength(1);
    await w.close();
  });

  it('keeps a job of a type no plugin provides as interrupted and warns instead of running it', async () => {
    const w = await world({ capture: 1 });
    // A capture of another item holds the only capture slot, so the job is still queued when the manager stops.
    w.sources.fake2.held.add('busy-1');
    await w.jobs.submitItem('fake2', itemUrl('fake2', 'busy-1'));
    await vi.waitFor(() => expect(w.sources.fake2.running()).toEqual(['busy-1']));
    const job = await w.jobs.submitItem('fake2', itemUrl('fake2', 'orphan-1'));
    const closing = w.close();
    w.sources.fake2.release('busy-1');
    await closing;
    expect(w.sources.fake2.captures).toEqual(['busy-1']);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reopened = await JobStore.open(w.jobsDirectory, () => w.clock.now);
    const remaining = new FakeSource('fake');
    const manager = new JobManager({
      vaultPath: w.root, store: reopened, plugins: [createFakePlugin(FAKE, remaining)],
      documents: new Collector(new MarkdownVault(w.root)), subscriptions: {},
    });
    await manager.resume();
    await vi.waitFor(() => expect(manager.isBusy()).toBe(false));
    expect(manager.get(job.job.id)).toMatchObject({ kind: 'fake2.item', state: 'interrupted' });
    expect(remaining.captures).toEqual([]);
    expect(w.sources.fake2.captures).toEqual(['busy-1']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fake2.item'));
    warn.mockRestore();
    await manager.close();
  });
});

describe('the status of a subscription of a type the core does not name (P-T2)', () => {
  it('reports every check status, including a source that needs the user to sign in again', async () => {
    const w = await world({ capture: 1 });
    w.sources.fake.addFeed('status', w.clock.now, [1]);
    w.sources.fake.addFeed('other', w.clock.now, [1]);
    await w.subscribe('fake', 'status');
    await w.subscribe('fake', 'other');
    await w.scheduler.start();
    expect(await w.checkStatus('fake', 'status')).toEqual({ state: 'scheduled', nextCheckAt: (await w.subscription('fake', 'status'))!.nextCheckAt });

    // One check runs and holds its capture; the next one waits for its turn.
    w.sources.fake.feed('status').items.unshift({ key: 'status-new', title: '新', publishedAt: w.clock.now.toISOString() });
    w.sources.fake.held.add('status-new');
    w.advance(MINUTE);
    await w.service('fake').startRun({ trigger: 'manual', channelIds: ['status'] });
    await vi.waitFor(() => expect(w.sources.fake.running()).toEqual(['status-new']));
    expect(await w.checkStatus('fake', 'status')).toEqual({ state: 'updating', done: 0, total: 1 });
    w.sources.fake.release('status-new');
    await w.idle();

    w.sources.fake.listFailures.push(new CollectorError('rate_limited', '來源暫時限制連線。'));
    const [limited] = await w.service('fake').startRun({ trigger: 'manual', channelIds: ['other'] });
    await vi.waitFor(() => expect(w.jobs.get(limited!.job.id)).toMatchObject({ state: 'queued', wait: { reason: 'rate_limited' } }));
    expect(await w.checkStatus('fake', 'other')).toEqual({ state: 'queued' });
    w.advance(10 * MINUTE);
    w.fire();
    await w.jobs.whenSettled(limited!.job.id);

    await w.service('fake').setEnabled('status', false);
    expect(await w.checkStatus('fake', 'status')).toEqual({ state: 'paused' });
    await w.service('fake').setEnabled('status', true);
    await w.idle();

    await w.scheduler.updateSchedule({ enabled: false });
    expect(await w.checkStatus('fake', 'status')).toEqual({ state: 'auto_check_off' });
    await w.scheduler.updateSchedule({ enabled: true });

    w.sources.fake.signedIn = false;
    expect(await w.checkStatus('fake', 'status')).toEqual({ state: 'login_required' });
    expect(await w.checkStatus('fake2', 'status')).toBeUndefined();
    w.sources.fake.signedIn = true;
    expect((await w.checkStatus('fake', 'status'))?.state).toBe('scheduled');
    await w.close();
  });
});

describe('exchanging a Vault that holds several source types (P-T2)', () => {
  afterEach(cleanUp);

  /** A time after every collection the test makes; larger `n` is later. */
  const at = (n: number) => `2030-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
  const plugins = (): SourcePlugin[] => [
    ...youtubePlugins(), createFakePlugin(FAKE, new FakeSource('fake')), createFakePlugin(FAKE2, new FakeSource('fake2')),
  ];
  const document = (type: string, key: string): CapturedDocument => ({
    sourceType: type, key, sourceUrl: itemUrl(type, key), title: `${type} ${key}`, publisher: { id: null, name: `${type} 作者` },
    publishedAt: null, bodyMarkdown: `${key} 的內容。`, details: { rating: 3, note: null },
  });
  const feed = (type: string, id: string): SubscriptionRecord => ({
    id, title: `${type} 動態 ${id}`, url: feedUrl(type, id), enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
    settings: FAKE_DEFAULTS, nextCheckAt: '2099-01-01T00:00:00.000Z', lastDispatchedAt: null,
  });
  const items = async (root: string) => new Map([...await itemStates(registeredSource(await registeredFiles(root)))]
    .map(([key, state]) => [key, state.state === 'present' ? `present:${state.digest}` : `deleted:${state.at}`]));
  async function using<T>(machineOf: Machine, use: (workspace: VaultWorkspace) => Promise<T>): Promise<T> {
    const workspace = await open(machineOf, { plugins: plugins() }, false);
    try { return await use(workspace); } finally { await workspace.close(); }
  }
  async function exportFrom(machineOf: Machine, name: string): Promise<string> {
    await mkdir(machineOf.exports, { recursive: true });
    return using(machineOf, async (workspace) => (await workspace.exportTo(path.join(machineOf.exports, `${name}.zip`))).result!.exportPath!);
  }

  it('exports, compares, merges and replaces documents and subscriptions of every type beside YouTube\'s', async () => {
    const root = await temp();
    const a = await machine('A', root);
    const b = await machine('B', root);
    await seed(a.vault);
    await new MarkdownVault(a.vault).add(document('fake', 'shared-1'));
    await new MarkdownVault(a.vault).add(document('fake2', 'shared-2'));
    await new JsonSubscriptionStore(a.vault, 'fake').add(feed('fake', 'news'));
    const first = await exportFrom(a, 'a-1');
    const created = await importNewVault({ packageFile: first, folder: b.vault, profilePath: b.profile, createdBy: 'XR Collector test' });
    await new VaultSelection(path.join(b.profile, 'vault-selection.json')).write(created);
    expect(await items(b.vault)).toEqual(await items(a.vault));

    // B adds a document of one type, deletes one of the other and subscribes to a feed of the other.
    await new MarkdownVault(b.vault, { now: () => new Date(at(1)) }).add(document('fake', 'b-only'));
    await new Collector(new MarkdownVault(b.vault, { now: () => new Date(at(1)) })).delete('fake2:shared-2');
    await new JsonSubscriptionStore(b.vault, 'fake2', () => new Date(at(1))).add(feed('fake2', 'b-feed'));
    const file = await exportFrom(b, 'b-1');
    const replacing = await machine('A-replace', root);
    await cp(a.vault, replacing.vault, { recursive: true });

    await using(a, async (workspace) => {
      const { preview, status } = await importFile(workspace, file);
      expect(preview).toMatchObject({
        merge: { documents: { added: 1, updated: 0, removed: 1 }, subscriptions: { added: 1, updated: 0, removed: 0 } },
        localNewer: 0,
      });
      expect(status).toMatchObject({ state: 'completed', operation: 'import' });
      expect((await workspace.collector.list()).map((entry) => entry.id).sort()).toEqual(['fake:b-only', 'fake:shared-1', 'youtube:dQw4w9WgXcQ']);
      expect((await workspace.subscriptions.of('youtube')!.list()).map((row) => row.id)).toEqual(['UC123']);
      expect((await workspace.subscriptions.of('fake')!.list()).map((row) => row.id)).toEqual(['news']);
      expect((await workspace.subscriptions.of('fake2')!.list()).map((row) => row.id)).toEqual(['b-feed']);
    });
    expect(await items(a.vault)).toEqual(await items(b.vault));
    expect(existsSync(path.join(a.vault, 'settings/fake2-feeds.json'))).toBe(true);

    await using(replacing, async (workspace) => { await importFile(workspace, file, 'replace'); });
    expect(await items(replacing.vault)).toEqual(await items(b.vault));
  });

  it('derives a subscription\'s sign-in status from its plugin when the workspace assembles it', async () => {
    const root = await temp();
    const a = await machine('A', root);
    await seed(a.vault);
    await new JsonSubscriptionStore(a.vault, 'fake').add(feed('fake', 'news'));
    const source = new FakeSource('fake');
    const workspace = await open(a, { plugins: [...youtubePlugins(), createFakePlugin(FAKE, source), createFakePlugin(FAKE2, new FakeSource('fake2'))] }, false);
    try {
      const status = async () => (await workspace.subscriptions.of('fake')!.listSubscriptions()).find((entry) => entry.id === 'news')?.checkStatus.state;
      expect(await status()).not.toBe('login_required');
      source.signedIn = false;
      expect(await status()).toBe('login_required');
      expect((await workspace.subscriptions.of('youtube')!.listSubscriptions()).map((entry) => entry.checkStatus.state)).not.toContain('login_required');
      source.signedIn = true;
      expect(await status()).not.toBe('login_required');
    } finally {
      await workspace.close();
    }
  });
});
