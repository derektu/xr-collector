import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityLog } from '../../src/activity/activity-log.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { collectionRecord } from '../../src/sources/source-catalog.js';
import type { ActivityCheckSummary, CollectionJob, JobEvent, Subscription } from '../../src/core/types.js';

const VAULT = '/vault/activity-summary';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function terminal(id: string, at: string, options: {
  subscription?: string; sourceType?: string; trigger?: 'scheduled' | 'manual' | 'subscribe' | 'resume';
  result?: 'empty' | 'network_error' | 'other'; created?: number; existing?: number; failed?: number; skipped?: number;
  message?: string;
} = {}): JobEvent {
  const result = options.result ?? 'empty';
  return {
    eventId: `event-${id}`, timestamp: at, severity: result === 'network_error' ? 'error' : 'info',
    eventType: result === 'network_error' ? 'job.failed' : 'job.completed',
    message: options.message ?? (result === 'network_error' ? '無法連線。' : '沒有新內容。'),
    vaultPath: VAULT, jobId: id, sourceType: options.sourceType ?? 'youtube', sourceId: options.subscription ?? 'sub-a',
    subscriptionId: options.subscription ?? 'sub-a', sourceTitle: options.subscription ?? 'A',
    trigger: options.trigger ?? 'scheduled', outcome: result === 'network_error' ? 'failed' : result === 'empty' ? 'empty' : 'created',
    ...(result === 'network_error' ? { errorCode: 'network_error' } : {}),
    check: {
      trigger: options.trigger ?? 'scheduled', result, created: options.created ?? 0, existing: options.existing ?? 0,
      failed: options.failed ?? 0, skipped: options.skipped ?? 0,
    },
  };
}

function at(minute: number): string { return new Date(Date.UTC(2026, 9, 20, 8, minute)).toISOString(); }
const scope = { vaultPath: VAULT };

describe('activity check summaries (#96 A1-A5)', () => {
  it('groups twelve scheduled empty checks once and never counts retry events as checks (A1)', async () => {
    const log = ActivityLog.memory({ now: () => new Date(at(59)) });
    for (let index = 0; index < 12; index += 1) {
      log.record({ ...terminal(`check-${index}`, at(index), { existing: 5 }), eventId: `done-${index}` });
      log.record({ ...terminal(`retry-${index}`, at(index)), eventId: `retry-${index}`, jobId: `check-${index}`, eventType: 'job.retry_scheduled', check: undefined, severity: 'warning' });
    }
    const page = await log.summary({ view: 'summary' }, scope);
    const groups = page.entries.filter((entry) => entry.kind === 'check');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 12, firstFinishedAt: at(0), lastFinishedAt: at(11), result: 'empty' });
    expect((await log.group(groups[0]!.groupId, scope)).checks).toHaveLength(12);
  });

  it('keeps empty, network errors with different messages, then empty as exactly three runs (A2)', async () => {
    const log = ActivityLog.memory({ now: () => new Date(at(59)) });
    const results = [...Array(3).fill('empty'), ...Array(2).fill('network_error'), ...Array(4).fill('empty')] as Array<'empty' | 'network_error'>;
    results.forEach((result, index) => log.record(terminal(`c${index}`, at(index), { result, message: index === 3 ? '逾時。' : '無法連線。' })));
    const groups = (await log.summary({ view: 'summary' }, scope)).entries.filter((entry) => entry.kind === 'check');
    expect(groups.map((group) => [group.result, group.count])).toEqual([['empty', 4], ['network_error', 2], ['empty', 3]]);
  });

  it('uses per-source subscription chronology and treats manual/content/skipped checks as boundaries (A3)', async () => {
    const log = ActivityLog.memory({ now: () => new Date(at(59)) });
    log.record(terminal('a1', at(1)));
    log.record(terminal('b1', at(2), { subscription: 'sub-b' }));
    log.record(terminal('a2', at(3)));
    log.record(terminal('manual', at(4), { trigger: 'manual' }));
    log.record(terminal('content', at(5), { result: 'other', created: 1 }));
    log.record({ ...terminal('child-failed', at(5), { result: 'other' }), eventId: 'child-item', jobId: 'item-1', parentJobId: 'content', check: undefined, eventType: 'subscription.item_failed', severity: 'warning' });
    log.record(terminal('skipped', at(6), { result: 'other', skipped: 1 }));
    log.record({ ...terminal('child-skipped', at(6), { result: 'other' }), eventId: 'child-skip-a3', jobId: 'item-2', parentJobId: 'skipped', check: undefined, eventType: 'subscription.item_skipped' });
    log.record(terminal('a3', at(7)));
    log.record(terminal('rss-a', at(8), { sourceType: 'rss' }));
    log.record(terminal('subscribe', at(9), { trigger: 'subscribe' }));
    log.record(terminal('resume', at(10), { trigger: 'resume' }));
    log.record({ ...terminal('other-error', at(11), { result: 'other', message: '權限不足。' }), severity: 'error', errorCode: 'login_required', eventType: 'job.failed' });
    const entries = (await log.summary({ view: 'summary' }, scope)).entries;
    const checks = entries.filter((entry) => entry.kind === 'check');
    expect(checks.find((entry) => entry.sourceType === 'youtube' && entry.subscriptionId === 'sub-a' && entry.firstFinishedAt === at(1))).toMatchObject({ count: 2 });
    expect(checks.filter((entry) => entry.sourceType === 'youtube' && entry.subscriptionId === 'sub-a').map((entry) => entry.count)).toEqual([1, 1, 1, 1, 1, 1, 1, 2]);
    expect(checks.filter((entry) => entry.subscriptionId === 'sub-a').map((entry) => entry.trigger)).toEqual(expect.arrayContaining(['manual', 'subscribe', 'resume']));
    expect(checks.find((entry) => entry.sourceType === 'rss')).toMatchObject({ count: 1 });
    expect(entries.some((entry) => entry.kind === 'event' && entry.event.eventId === 'child-item')).toBe(true);
    expect(entries.some((entry) => entry.kind === 'event' && entry.event.eventId === 'child-skip-a3')).toBe(true);
  });

  it('returns exact group membership and complete root/child events while raw remains unchanged (A4)', async () => {
    const log = ActivityLog.memory({ now: () => new Date(at(59)) });
    log.record({ ...terminal('c1', at(2)), eventId: 'c1-start', timestamp: at(1), eventType: 'job.started', check: undefined });
    log.record({ ...terminal('child', at(2), { result: 'other' }), eventId: 'child-skip', jobId: 'item-1', parentJobId: 'c1', check: undefined, eventType: 'subscription.item_skipped' });
    log.record(terminal('c1', at(3)));
    log.record(terminal('c2', at(4)));
    const raw = await log.query({}, scope);
    const summary = await log.summary({ view: 'summary' }, scope);
    const group = summary.entries.find((entry) => entry.kind === 'check')!;
    const detail = await log.group(group.groupId, scope);
    expect(raw.events.map((event) => event.eventId)).toEqual(['event-c2', 'event-c1', 'child-skip', 'c1-start']);
    expect(detail.checks.map((check) => check.jobId)).toEqual(['c2', 'c1']);
    expect(detail.checks[0]).toMatchObject({ created: 0, existing: 0, failed: 0, skipped: 0 });
    expect(detail.checks[1]!.events.map((event) => event.eventId)).toEqual(['c1-start', 'child-skip', 'event-c1']);
  });

  it('projects one readable lifecycle while raw retains subscription and job diagnostics (F3)', async () => {
    const log = ActivityLog.memory({ now: () => new Date(at(59)) });
    const event = (eventId: string, minute: number, eventType: string, jobId: string, jobRole: 'add' | 'check' | 'item'): JobEvent => ({
      eventId, timestamp: at(minute), severity: 'info', eventType, message: eventType,
      vaultPath: VAULT, jobId, jobRole, sourceType: 'youtube', sourceTitle: 'A', subscriptionId: 'sub-a',
    });
    log.record(event('add-accepted', 1, 'job.accepted', 'add', 'add'));
    log.record(event('add-started', 2, 'job.started', 'add', 'add'));
    const subscriptionAdded = event('subscription-added', 3, 'subscription.added', 'add', 'add');
    subscriptionAdded.jobId = null;
    delete subscriptionAdded.jobRole;
    log.record(subscriptionAdded);
    log.record(event('add-completed', 4, 'job.completed', 'add', 'add'));
    log.record(event('collect-accepted', 5, 'job.accepted', 'collect', 'check'));
    log.record(event('collect-started', 6, 'job.started', 'collect', 'check'));
    log.record({ ...event('document-saved', 7, 'document.saved', 'item', 'item'), parentJobId: 'collect', documentId: 'youtube:v1' });
    log.record(terminal('collect', at(8), { trigger: 'subscribe', result: 'other', created: 1 }));
    log.record(event('running-accepted', 8, 'job.accepted', 'running', 'check'));
    log.record({ ...event('running-started', 9, 'job.started', 'running', 'check'), trigger: 'subscribe' });
    log.record({ ...event('running-child-started', 10, 'job.started', 'running-child', 'item'), parentJobId: 'running' });
    log.record({ ...event('running-child-saved', 11, 'document.saved', 'running-child', 'item'), parentJobId: 'running', documentId: 'youtube:v2' });
    log.record({ ...event('running-child-completed', 12, 'job.completed', 'running-child', 'item'), parentJobId: 'running', outcome: 'created' });
    log.record(event('empty-started', 13, 'job.started', 'empty', 'check'));
    log.record(terminal('empty', at(14)));
    log.record(event('item-started', 15, 'job.started', 'single', 'item'));
    log.record({ ...event('item-saved', 16, 'document.saved', 'single', 'item'), documentId: 'youtube:v3' });
    log.record({ ...event('item-completed', 17, 'job.completed', 'single', 'item'), outcome: 'created' });

    const raw = await log.query({}, scope);
    expect(raw.events.map((entry) => entry.eventId)).toEqual(expect.arrayContaining([
      'add-accepted', 'add-started', 'subscription-added', 'add-completed', 'collect-accepted', 'collect-started',
      'document-saved', 'event-collect', 'running-accepted', 'running-started', 'empty-started', 'event-empty',
      'running-child-started', 'running-child-saved', 'running-child-completed', 'item-started', 'item-saved', 'item-completed',
    ]));
    const summary = await log.summary({ view: 'summary' }, scope);
    const visible = summary.entries.filter((entry) => entry.kind === 'event').map((entry) => entry.event.eventId);
    expect(visible).toEqual(['item-saved', 'item-started', 'running-child-saved', 'running-started', 'document-saved', 'collect-started', 'subscription-added']);
    expect(summary.entries.filter((entry) => entry.kind === 'check')).toHaveLength(2);
  });

  it('keeps same-millisecond summary lifecycle in newest-first causal order (F2)', async () => {
    const log = ActivityLog.memory({ now: () => new Date(at(59)) });
    const timestamp = at(20);
    log.record({ eventId: '000000000001-added', timestamp, severity: 'info', eventType: 'subscription.added', message: 'added',
      vaultPath: VAULT, jobId: null, sourceType: 'youtube', sourceTitle: 'A', subscriptionId: 'sub-a' });
    log.record({ eventId: '000000000002-start', timestamp, severity: 'info', eventType: 'job.started', message: 'started',
      vaultPath: VAULT, jobId: 'collect', jobRole: 'check', sourceType: 'youtube', sourceTitle: 'A', subscriptionId: 'sub-a', trigger: 'subscribe' });
    log.record({ ...terminal('collect', timestamp, { trigger: 'subscribe', result: 'other', created: 1 }), eventId: '000000000003-complete' });
    const entries = (await log.summary({ view: 'summary' }, scope)).entries;
    expect(entries.map((entry) => entry.kind === 'event' ? entry.event.eventId : entry.jobId))
      .toEqual(['collect', '000000000002-start', '000000000001-added']);
  });

  it('freezes pages across arrivals and applies severity only after result boundaries (A5)', async () => {
    const log = ActivityLog.memory({ now: () => new Date(at(59)) });
    log.record({ ...terminal('old', at(1)), eventId: 'system', jobId: null, check: undefined, eventType: 'collection.resumed' });
    log.record(terminal('e1', at(2), { result: 'network_error' }));
    log.record(terminal('empty', at(3)));
    log.record(terminal('e2', at(4), { result: 'network_error' }));
    const first = await log.summary({ view: 'summary', limit: 1 }, scope);
    log.record(terminal('e3', at(5), { result: 'network_error' }));
    const second = await log.summary({ view: 'summary', limit: 10, cursor: first.nextCursor! }, scope);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.kind === 'event' ? entry.event.eventId : entry.groupId)).size).toBe(4);
    const refreshed = await log.summary({ view: 'summary' }, scope);
    expect(refreshed.entries.find((entry) => entry.kind === 'check' && entry.lastFinishedAt === at(5))).toMatchObject({ count: 2 });
    const errors = await log.summary({ view: 'summary', severity: ['error'] }, scope);
    expect(errors.entries.filter((entry) => entry.kind === 'check').map((entry) => entry.count)).toEqual([2, 1]);
  });

  it('applies document and level filters after grouping without exposing check rows (L4-L5)', async () => {
    const log = ActivityLog.memory({ now: () => new Date(at(59)) });
    log.record(terminal('empty-a', at(1)));
    log.record({ ...terminal('empty-a', at(1)), eventId: 'saved', jobId: 'item-a', parentJobId: 'empty-a', check: undefined,
      severity: 'info', eventType: 'document.saved', documentId: 'youtube:v1' });
    log.record(terminal('error', at(2), { result: 'network_error' }));
    log.record(terminal('empty-b', at(3)));
    const documents = await log.summary({ view: 'summary', eventType: ['document.saved'], severity: ['info', 'warning', 'error'] }, scope);
    expect(documents.entries).toHaveLength(1);
    expect(documents.entries[0]).toMatchObject({ kind: 'event', event: { eventType: 'document.saved' } });
    const empty = await log.summary({ view: 'summary', eventType: ['document.saved'], severity: ['error'] }, scope);
    expect(empty.entries).toEqual([]);
    const all = await log.summary({ view: 'summary' }, scope);
    expect(all.entries.filter((entry) => entry.kind === 'check').map((entry) => entry.result)).toEqual(['empty', 'network_error', 'empty']);
  });
});

describe('durable summary retention (#96 A6)', () => {
  it('keeps same-millisecond raw pagination ordered and unique across restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-events-'));
    roots.push(root);
    const fixed = new Date(at(20));
    let store = await JobStore.open(root, () => fixed);
    const write = (message: string) => store.event({
      severity: 'info', eventType: 'system.test', message, vaultPath: VAULT, jobId: null,
    });
    write('one'); write('two'); write('three');
    await store.close();
    store = await JobStore.open(root, () => fixed);
    write('four');
    const first = await store.activity.query({ limit: 2 }, scope);
    const second = await store.activity.query({ limit: 2, cursor: first.nextCursor! }, scope);
    expect([...first.events, ...second.events].map((event) => event.message)).toEqual(['four', 'three', 'two', 'one']);
    expect(new Set([...first.events, ...second.events].map((event) => event.eventId)).size).toBe(4);
    await store.close();
  });

  it('expires an existing summary cursor when retention removes part of its frozen snapshot', async () => {
    let now = new Date(Date.UTC(2026, 9, 20, 9));
    const log = ActivityLog.memory({ now: () => now });
    log.record({ ...terminal('system-1', at(1)), eventId: 'system-1', jobId: null, check: undefined, eventType: 'collection.resumed' });
    log.record({ ...terminal('system-2', at(2)), eventId: 'system-2', jobId: null, check: undefined, eventType: 'collection.paused' });
    const first = await log.summary({ view: 'summary', limit: 1 }, scope);
    expect(first.nextCursor).toBeTruthy();
    now = new Date(Date.UTC(2026, 10, 21, 9));
    await expect(log.summary({ view: 'summary', limit: 1, cursor: first.nextCursor! }, scope))
      .rejects.toMatchObject({ code: 'activity_snapshot_expired' });
  });

  it('expires cached detail when an early event crosses retention before its completed check', async () => {
    let now = new Date('2026-10-31T08:00:00.000Z');
    const log = ActivityLog.memory({ now: () => now });
    log.record({ ...terminal('edge', '2026-10-01T09:30:00.000Z'), eventId: 'edge-start', timestamp: '2026-10-01T08:30:00.000Z', eventType: 'job.started', check: undefined });
    log.record(terminal('edge', '2026-10-01T09:30:00.000Z'));
    const group = (await log.summary({ view: 'summary' }, scope)).entries.find((entry) => entry.kind === 'check')!;
    expect((await log.group(group.groupId, scope)).checks[0]!.events).toHaveLength(2);
    now = new Date('2026-10-31T09:00:00.000Z');
    await expect(log.group(group.groupId, scope)).rejects.toMatchObject({ code: 'activity_group_expired' });
  });

  it('takes the subscription detail limit after grouping', () => {
    const subscription = { id: 'sub-a', title: 'A', url: 'https://example.test/a', enabled: true, addedAt: at(0), settings: {} } as Subscription;
    const summaries: ActivityCheckSummary[] = Array.from({ length: 35 }, (_, index) => ({
      kind: 'check', groupId: `g${index}`, jobId: `j${index}`, sourceType: 'youtube', subscriptionId: 'sub-a', sourceTitle: 'A', trigger: 'scheduled',
      result: 'empty', created: 0, existing: 5, failed: 0, skipped: 0, count: 12,
      firstFinishedAt: at(index), lastFinishedAt: at(index), severity: 'info', message: '沒有新影片。',
    }));
    const rows = collectionRecord('youtube', subscription, [], [], summaries);
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.kind === 'check-group' && row.count === 12)).toBe(true);

    const failed = collectionRecord('youtube', subscription, [], [], [{
      ...summaries[0]!, groupId: 'failed-group', jobId: 'actual-job', count: 1, result: 'other', severity: 'error',
      errorCode: 'login_required', message: '需要重新登入。',
    }]);
    expect(failed[0]).toMatchObject({ kind: 'check', jobId: 'actual-job', groupId: 'failed-group', error: { code: 'login_required', message: '需要重新登入。' } });
  });

  it('survives restart and jobs.json pruning, then expires details at the retention boundary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-summary-'));
    roots.push(root);
    let now = new Date(Date.UTC(2026, 9, 20, 9));
    let store = await JobStore.open(root, () => now);
    for (let index = 0; index < 1005; index += 1) store.put(finishedJob(`f${index}`, at(index % 60)));
    for (let index = 0; index < 12; index += 1) store.activity.record(terminal(`durable-${index}`, at(index)));
    await store.close();
    store = await JobStore.open(root, () => now);
    expect(store.list(VAULT)).toHaveLength(1000);
    let page = await store.activity.summary({ view: 'summary' }, scope);
    const group = page.entries.find((entry) => entry.kind === 'check')!;
    expect(group.count).toBe(12);
    expect((await store.activity.group(group.groupId, scope)).checks).toHaveLength(12);
    now = new Date(Date.UTC(2026, 10, 21, 9));
    await expect(store.activity.group(group.groupId, scope)).rejects.toMatchObject({ code: 'activity_group_expired' });
    await store.activity.purge();
    page = await store.activity.summary({ view: 'summary' }, scope);
    expect(page.entries).toHaveLength(0);
    await store.close();
  });
});

function finishedJob(id: string, timestamp: string): CollectionJob {
  return {
    id, kind: 'youtube-video', state: 'completed', phase: null, vaultPath: VAULT, parentId: null,
    source: { type: 'youtube', id, url: `https://example.test/${id}`, title: id }, createdAt: timestamp,
    startedAt: timestamp, finishedAt: timestamp, updatedAt: timestamp, progress: null, items: null,
    result: { outcome: 'existing' }, error: null,
  };
}
