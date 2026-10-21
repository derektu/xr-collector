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
      checkSubscription: async (type, id) => (await services[type as 'fake' | 'fake2'].startRun({ trigger: 'manual', subscriptionIds: [id] }))[0]!,
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
      type: 'fake', target: { id: 'news', title: 'fake 動態 news', url: feedUrl('fake', 'news') },
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
    const [immediate] = await w.service('fake').startRun({ trigger: 'manual', subscriptionIds: ['daily'] });
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
    expect(paused).toMatchObject({ subscription: { id: 'rest', enabled: false }, submission: null });
    await expect(w.service('fake').startRun({ trigger: 'manual', subscriptionIds: ['rest'] })).rejects.toMatchObject({ code: 'subscription_paused' });
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
    const [check] = await w.service('fake').startRun({ trigger: 'manual', subscriptionIds: ['leaving'] });
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
    const check = await w.jobs.whenSettled((await w.service('fake').startRun({ trigger: 'manual', subscriptionIds: ['kept'] }))[0]!.job.id);
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
    await w.service('fake').startRun({ trigger: 'manual', subscriptionIds: ['status'] });
    await vi.waitFor(() => expect(w.sources.fake.running()).toEqual(['status-new']));
    expect(await w.checkStatus('fake', 'status')).toEqual({ state: 'updating', done: 0, total: 1 });
    w.sources.fake.release('status-new');
    await w.idle();

    w.sources.fake.listFailures.push(new CollectorError('rate_limited', '來源暫時限制連線。'));
    const [limited] = await w.service('fake').startRun({ trigger: 'manual', subscriptionIds: ['other'] });
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

  it('carries failed items of a subscription through export, merge, replace and a Vault made from a package (N69-T8)', async () => {
    const root = await temp();
    const a = await machine('A', root);
    const b = await machine('B', root);
    await seed(a.vault);
    const failed = (key: string, attempts: number) => ({ itemKey: key, title: key, attempts, errorCode: 'no_subtitles', failedAt: at(1), skipped: attempts >= 3 });
    await new JsonSubscriptionStore(a.vault, 'fake').add({ ...feed('fake', 'news'), failures: [failed('news-a', 1)] });
    const first = await exportFrom(a, 'a-1');
    const created = await importNewVault({ packageFile: first, folder: b.vault, profilePath: b.profile, createdBy: 'XR Collector test' });
    await new VaultSelection(path.join(b.profile, 'vault-selection.json')).write(created);
    const failuresIn = async (vault: string, type: string, id: string) =>
      (await new JsonSubscriptionStore(vault, type).list()).find((row) => row.id === id)?.failures;
    expect(await failuresIn(b.vault, 'fake', 'news')).toEqual([failed('news-a', 1)]);

    // B renames the feed and records its own failures; it also subscribes to a feed A does not have.
    const later = new JsonSubscriptionStore(b.vault, 'fake', () => new Date(at(2)));
    await later.update('news', { title: '新名稱', failures: [failed('news-b', 3)] });
    await new JsonSubscriptionStore(b.vault, 'fake2', () => new Date(at(2))).add({ ...feed('fake2', 'b-feed'), failures: [failed('b-1', 2)] });
    const file = await exportFrom(b, 'b-1');
    const replacing = await machine('A-replace', root);
    await cp(a.vault, replacing.vault, { recursive: true });

    await using(a, async (workspace) => { await importFile(workspace, file); });
    const merged = (await new JsonSubscriptionStore(a.vault, 'fake').list()).find((row) => row.id === 'news')!;
    expect(merged).toMatchObject({ title: '新名稱', failures: [failed('news-a', 1)] });
    expect(await failuresIn(a.vault, 'fake2', 'b-feed')).toEqual([failed('b-1', 2)]);

    // Replacing takes the package's subscriptions too, and like a merge keeps this Vault's collection progress of one it has.
    await using(replacing, async (workspace) => { await importFile(workspace, file, 'replace'); });
    expect((await new JsonSubscriptionStore(replacing.vault, 'fake').list()).find((row) => row.id === 'news'))
      .toMatchObject({ title: '新名稱', failures: [failed('news-a', 1)] });
    expect(await failuresIn(replacing.vault, 'fake2', 'b-feed')).toEqual([failed('b-1', 2)]);
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

describe('failed items of a type the core does not name (N69-T2–T7)', () => {
  const failure = (code: string) => new CollectorError(code, `${code}（測試）`);
  const check = async (w: Awaited<ReturnType<typeof world>>, id: string) => {
    w.advance(MINUTE);
    const [submission] = await w.service('fake').startRun({ trigger: 'manual', subscriptionIds: [id] });
    return w.jobs.whenSettled(submission!.job.id);
  };
  const failuresOf = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
    [...(await w.subscription('fake', id))?.failures ?? []].sort((left, right) => String(left.itemKey).localeCompare(String(right.itemKey)));

  it('counts one attempt per check, skips an item after the third or on a failure no retry changes, and forgets it once collected (N69-T2)', async () => {
    const w = await world();
    const [later, gone, flaky] = w.sources.fake.addFeed('f', w.clock.now, [1, 2, 3]);
    w.sources.fake.fail(later!, failure('no_subtitles'), failure('no_subtitles'), failure('no_subtitles'));
    w.sources.fake.fail(gone!, failure('video_unavailable'));
    // The retry policy here allows one attempt, so a transient failure outlasts the check at once.
    w.sources.fake.fail(flaky!, failure('network_error'));

    const first = await w.subscribe('fake', 'f');
    expect(first).toMatchObject({ state: 'completed', result: { outcome: 'partial' }, progress: { created: 0, failed: 3 } });
    expect(await failuresOf(w, 'f')).toEqual([
      { itemKey: later, title: 'f 第 0 篇', attempts: 1, errorCode: 'no_subtitles', failedAt: w.clock.now.toISOString(), skipped: false },
      { itemKey: gone, title: 'f 第 1 篇', attempts: 1, errorCode: 'video_unavailable', failedAt: w.clock.now.toISOString(), skipped: true },
      { itemKey: flaky, title: 'f 第 2 篇', attempts: 1, errorCode: 'network_error', failedAt: w.clock.now.toISOString(), skipped: false },
    ]);
    // Failed items leave the subscription's status alone.
    const listed = (await w.service('fake').listSubscriptions()).find((entry) => entry.id === 'f')!;
    expect(listed).toMatchObject({ status: 'tracking', lastError: null });

    const second = await check(w, 'f');
    expect(itemsOf(second)).toEqual([[later, null], [flaky, 'created']]);
    expect((await failuresOf(w, 'f')).map((entry) => [entry.itemKey, entry.attempts, entry.skipped])).toEqual([[later, 2, false], [gone, 1, true]]);

    await check(w, 'f');
    expect((await failuresOf(w, 'f')).map((entry) => [entry.itemKey, entry.attempts, entry.skipped])).toEqual([[later, 3, true], [gone, 1, true]]);
    const captures = w.sources.fake.captures.length;
    expect(itemsOf(await check(w, 'f'))).toEqual([]);
    expect(w.sources.fake.captures).toHaveLength(captures);
    await w.close();
  });

  it('counts nothing for a cooldown or a source that needs a new sign-in, and forgets items that are no longer candidates (N69-T2)', async () => {
    const w = await world();
    const [limited, signIn] = w.sources.fake.addFeed('g', w.clock.now, [1, 2]);
    w.sources.fake.fail(limited!, failure('rate_limited'));
    w.sources.fake.fail(signIn!, failure('login_needed'));
    const added = await w.service('fake').add(feedUrl('fake', 'g'), { maxItems: 2 });
    const subscribed = await w.jobs.whenSettled(added.job.id);
    await vi.waitFor(() => expect(w.gates.fake.status()).toMatchObject({ state: 'cooldown' }));
    w.advance(10 * MINUTE);
    w.fire();
    const first = await w.jobs.whenSettled(subscribed.result!.followUpJobId!);
    expect(itemsOf(first)).toEqual([[limited, 'created'], [signIn, null]]);
    expect(await failuresOf(w, 'g')).toEqual([]);

    // A failure of an item that later drops out of the newest N is forgotten at the next check.
    w.sources.fake.fail(signIn!, failure('no_subtitles'));
    await check(w, 'g');
    expect((await failuresOf(w, 'g')).map((entry) => entry.itemKey)).toEqual([signIn]);
    w.sources.fake.feed('g').items.unshift(
      { key: 'g-new-1', title: '新一', publishedAt: w.clock.now.toISOString() },
      { key: 'g-new-2', title: '新二', publishedAt: w.clock.now.toISOString() },
    );
    await check(w, 'g');
    expect(await failuresOf(w, 'g')).toEqual([]);
    await w.close();
  });

  it('keeps a skipped item in the newest N without taking an older one, and keeps the records of two types apart (N69-T3)', async () => {
    const w = await world();
    const keys = w.sources.fake.addFeed('n', w.clock.now, [1, 2, 3]);
    w.sources.fake2.addFeed('n', w.clock.now, [1, 2]);
    w.sources.fake.fail(keys[0]!, failure('video_unavailable'));
    const first = await w.subscribe('fake', 'n', { maxItems: 2 });
    expect(itemsOf(first)).toEqual([[keys[0], null], [keys[1], 'created']]);
    expect(itemsOf(await check(w, 'n'))).toEqual([]);
    expect(w.sources.fake.captures).not.toContain(keys[2]);

    const other = await w.subscribe('fake2', 'n', { maxItems: 2 });
    expect(other.progress).toMatchObject({ created: 2, failed: 0 });
    expect((await w.subscription('fake2', 'n'))?.failures).toBeUndefined();
    expect((await failuresOf(w, 'n')).map((entry) => entry.itemKey)).toEqual([keys[0]]);
    await w.close();
  });

  it('completes a check whose items all fail without an error status, and still fails a check whose listing fails (N69-T4)', async () => {
    const w = await world();
    const [only] = w.sources.fake.addFeed('a', w.clock.now, [1]);
    w.sources.fake.fail(only!, failure('no_subtitles'));
    const first = await w.subscribe('fake', 'a');
    expect(first).toMatchObject({ state: 'completed', result: { outcome: 'partial' }, error: null });
    let entry = (await w.service('fake').listSubscriptions()).find((candidate) => candidate.id === 'a')!;
    expect(entry).toMatchObject({ status: 'tracking', lastError: null, checkStatus: { state: 'scheduled' } });

    w.sources.fake.listFailures.push(failure('capture_failed'));
    const broken = await check(w, 'a');
    expect(broken).toMatchObject({ state: 'failed', error: { code: 'capture_failed' } });
    entry = (await w.service('fake').listSubscriptions()).find((candidate) => candidate.id === 'a')!;
    expect(entry).toMatchObject({ status: 'error', lastError: { code: 'capture_failed' } });
    await w.close();
  });

  it('lists running, queued and failed work for the jobs page, in the order it starts (N69-T5)', async () => {
    const w = await world({ capture: 1, retry: { maxAttempts: 3, delaysMs: [MINUTE] } });
    w.sources.fake2.fail('retry-1', failure('network_error'));
    const retrying = await w.jobs.submitItem('fake2', itemUrl('fake2', 'retry-1'));
    await vi.waitFor(() => expect(w.jobs.get(retrying.job.id)).toMatchObject({ retry: { attempts: 1 } }));
    w.sources.fake.addFeed('busy', w.clock.now, [1, 2, 3]);
    w.sources.fake.held.add('busy-00');
    const subscribed = await w.service('fake').add(feedUrl('fake', 'busy'));
    const check = (await w.jobs.whenSettled(subscribed.job.id)).result!.followUpJobId!;
    await vi.waitFor(() => expect(w.sources.fake.running()).toEqual(['busy-00']));
    const named = await w.jobs.submitItem('fake', itemUrl('fake', 'single-1'));
    w.sources.fake.fail('gone-1', failure('video_unavailable'));
    const failedOne = await w.jobs.submitItem('fake', itemUrl('fake', 'gone-1'));

    let overview = await w.jobs.overview();
    expect(overview.running).toEqual([expect.objectContaining({ jobId: check, role: 'check', title: 'fake 動態 busy', progress: { done: 0, total: 3 } })]);
    expect(overview.queued.map((entry) => [entry.jobId, entry.role, entry.title, Boolean(entry.retry)])).toEqual([
      [named.job.id, 'item', null, false], [failedOne.job.id, 'item', null, false], [retrying.job.id, 'item', null, true],
    ]);
    expect(overview.queued[2]).toMatchObject({ url: itemUrl('fake2', 'retry-1'), retry: { lastError: { code: 'network_error' } }, error: null });
    expect(overview.failed).toEqual([]);

    w.sources.fake.release('busy-00');
    await vi.waitFor(async () => expect((await w.jobs.overview()).failed.map((entry) => entry.jobId)).toEqual([failedOne.job.id]));
    w.fire();
    await w.idle();
    overview = await w.jobs.overview();
    expect(overview).toMatchObject({ running: [], queued: [] });
    expect(overview.failed).toEqual([expect.objectContaining({
      jobId: failedOne.job.id, role: 'item', type: 'fake', error: { code: 'video_unavailable', message: expect.any(String) }, failedAt: expect.any(String),
    })]);
    // The finished single item carries the publisher its capture reported.
    expect(w.jobs.get(named.job.id).source).toMatchObject({ title: '單篇 single-1', publisher: 'fake 作者' });
    expect(w.jobs.summary(new Date(0).toISOString())).toMatchObject({ active: 0, failed: 1 });
    await w.close();
  });

  it('keeps a failed single item until a retry succeeds, the user removes it, the item has a document or 7 days pass (N69-T6)', async () => {
    const w = await world();
    const failed = async (key: string, code = 'no_subtitles') => {
      w.sources.fake.fail(key, failure(code));
      return w.jobs.whenSettled((await w.jobs.submitItem('fake', itemUrl('fake', key))).job.id);
    };
    const listed = async () => (await w.jobs.overview()).failed.map((entry) => entry.url);

    const retried = await failed('retry-1');
    w.sources.fake.fail('retry-1', failure('no_subtitles'));
    const again = await w.jobs.whenSettled((await w.jobs.retry(retried.id)).job.id);
    expect((await w.jobs.overview()).failed.map((entry) => entry.jobId)).toEqual([again.id]);
    expect(await w.jobs.whenSettled((await w.jobs.retry(again.id)).job.id)).toMatchObject({ state: 'completed' });
    expect(await listed()).toEqual([]);

    const removed = await failed('remove-1');
    await expect(w.jobs.dismiss(again.id)).rejects.toMatchObject({ code: 'job_not_dismissable' });
    expect((await w.jobs.dismiss(removed.id)).dismissedAt).toBe(w.clock.now.toISOString());
    expect(await listed()).toEqual([]);
    await expect(w.jobs.dismiss(removed.id)).rejects.toMatchObject({ code: 'job_not_dismissable' });

    // A check of the feed that publishes the item collects it, and the failed entry leaves.
    w.sources.fake.addFeed('later', w.clock.now, [1]);
    const [inFeed] = w.sources.fake.feed('later').items.map((item) => item.key);
    await failed(inFeed!);
    expect((await w.jobs.overview()).failed).toHaveLength(1);
    await w.subscribe('fake', 'later');
    expect(await listed()).toEqual([]);

    const old = await failed('old-1');
    w.advance(7 * DAY - MINUTE);
    expect((await w.jobs.overview()).failed.map((entry) => entry.jobId)).toEqual([old.id]);
    w.advance(2 * MINUTE);
    expect(await listed()).toEqual([]);
    await w.restart();
    expect(await listed()).toEqual([]);
    await w.close();
  });

  it('builds the collection record from documents, failures and finished checks, newest first (N69-T7)', async () => {
    const { collectionRecord, COLLECTION_LIMIT } = await import('../../src/sources/source-catalog.js');
    const w = await world();
    const [failing, gone, ok] = w.sources.fake.addFeed('r', w.clock.now, [1, 2, 3]);
    w.sources.fake.fail(failing!, failure('no_subtitles'), failure('no_subtitles'));
    w.sources.fake.fail(gone!, failure('video_unavailable'));
    await w.subscribe('fake', 'r');
    const empty = await check(w, 'r');
    await w.service('fake').setEnabled('r', false);
    const subscription = (await w.service('fake').listSubscriptions()).find((entry) => entry.id === 'r')!;
    const documents = (await w.collector.list()).filter((document) => document.publisher.id === 'r');
    const record = collectionRecord('fake', subscription, documents, w.service('fake').checkJobs('r'));
    // The second check, a minute later, tried the failing item again; a check comes before the items of the same instant.
    expect(record.map((entry) => entry.kind === 'check' ? `check:${entry.created}/${entry.failed}` : `${entry.kind}:${entry.key}`)).toEqual([
      'check:0/1', `failed:${failing}`, 'check:1/2', `collected:${ok}`, `skipped:${gone}`,
    ]);
    // Pausing skips nothing that ran, so no extra check row appears.
    expect(record.find((entry) => entry.kind === 'failed')).toMatchObject({ reason: '沒有內文', attempts: 2, maxAttempts: 3, url: itemUrl('fake', failing!) });
    expect(record.find((entry) => entry.kind === 'skipped')).toMatchObject({ reason: '文章不存在', skippedBy: 'failure' });
    expect(empty.result?.outcome).toBe('partial');
    expect(COLLECTION_LIMIT).toBe(30);
    await w.close();
  });
});
