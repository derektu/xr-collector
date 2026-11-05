// What the Subscriptions pages show: times relative to today in the device time zone, type and name
// filters and detail paths kept in the URL, active jobs counted once, collection record rows, why
// work waits for a retry, the last and next check, shortened names and addresses, and a URL
// recognition applied only to the address it answered.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionJob, SubscriptionEntry, UrlRecognition } from '../../src/core/types.js';
import { rssDeclaration } from '../../src/plugins/rss/shared.js';
import { youtubeDeclaration } from '../../src/plugins/youtube/shared.js';
import {
  activeJobs,
  checkTimes,
  collectionRow,
  currentRecognition,
  displayUrl,
  failureLabel,
  filterSources,
  initials,
  nextCheck,
  parseSourceListState,
  retryCause,
  shortTime,
  sourceListSearch,
  sourcePath,
  sourceRouteForPath,
  timeSpan,
} from '../../src/web/source-presentation.js';

const originalZone = process.env.TZ;
beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
afterEach(() => { process.env.TZ = originalZone; });

function source(overrides: Partial<SubscriptionEntry>): SubscriptionEntry {
  return {
    id: 'UC1', title: '頻道', url: 'https://www.youtube.com/channel/UC1/videos', enabled: true, addedAt: '2026-10-01T00:00:00.000Z',
    settings: { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 }, status: 'tracking', checkStatus: { state: 'scheduled', nextCheckAt: null }, lastError: null, activeJob: null, documentCount: 0, lastCollectedAt: null,
    type: 'youtube', kind: 'channel', kindLabel: 'YouTube 頻道', ...overrides,
  };
}

function job(overrides: Partial<CollectionJob>): CollectionJob {
  return {
    id: 'job', kind: 'youtube.channel', state: 'running', phase: 'capture', vaultPath: '/vault', parentId: null,
    source: { type: 'youtube', id: 'UC1', url: 'https://www.youtube.com/@one', title: '頻道一' },
    createdAt: '2026-10-15T00:00:00.000Z', startedAt: null, finishedAt: null, updatedAt: '2026-10-15T00:00:00.000Z',
    progress: null, items: null, result: null, error: null, ...overrides,
  };
}

describe('source presentation (T-09)', () => {
  it('formats times relative to today in the device time zone', () => {
    const now = new Date('2026-10-15T06:00:00.000Z'); // 14:00 in Taipei
    expect(shortTime('2026-10-15T05:30:00.000Z', now)).toEqual({ day: 'today', time: '13:30' });
    expect(shortTime('2026-10-14T13:05:00.000Z', now)).toEqual({ day: 'yesterday', time: '21:05' });
    expect(shortTime('2026-10-13T16:30:00.000Z', now)).toEqual({ day: 'yesterday', time: '00:30' });
    expect(shortTime('2026-10-12T16:30:00.000Z', now)).toEqual({ day: 'this_year', date: '10-13', time: '00:30' });
    expect(shortTime('2025-12-31T01:00:00.000Z', now)).toEqual({ day: 'earlier', date: '2025-12-31' });
  });

  it('filters by type and by name', () => {
    const sources = [source({ id: 'a', title: 'Alpha Talks' }), source({ id: 'b', title: '財經八百' })];
    expect(filterSources(sources, { type: '', query: 'alpha' }).map((entry) => entry.id)).toEqual(['a']);
    expect(filterSources(sources, { type: 'youtube', query: '八百' }).map((entry) => entry.id)).toEqual(['b']);
    expect(filterSources(sources, { type: 'rss', query: '' })).toEqual([]);
  });

  it('keeps list filters and source detail addresses in the URL', () => {
    const filters = { type: 'youtube', query: '財經' };
    expect(sourceListSearch(filters)).toBe('?type=youtube&q=%E8%B2%A1%E7%B6%93');
    expect(parseSourceListState('?type=youtube&q=%E8%B2%A1%E7%B6%93')).toEqual(filters);
    expect(sourceListSearch({ type: '', query: '' })).toBe('');
    expect(sourcePath('youtube', 'UC/1')).toBe('/sources/youtube/UC%2F1');
    expect(sourceRouteForPath('/sources/youtube/UC%2F1')).toEqual({ type: 'youtube', id: 'UC/1' });
    expect(sourceRouteForPath('/sources/youtube/')).toBeNull();
    expect(sourceRouteForPath('/documents/x')).toBeNull();
  });

  it('counts each active top-level job once', () => {
    const jobs = [
      job({ id: 'a', progress: { total: 10, done: 4, created: 4, existing: 0, failed: 0 } }),
      job({ id: 'b', state: 'queued', source: { type: 'youtube', id: null, url: 'https://youtu.be/x', title: null } }),
      job({ id: 'c', state: 'completed' }),
      job({ id: 'd', kind: 'youtube.video', parentId: 'a' }),
    ];
    const active = activeJobs(jobs);
    expect(active.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('describes the rows of a collection record (N69-T11)', () => {
    const now = new Date('2026-10-15T06:00:00.000Z');
    const at = '2026-10-15T05:30:00.000Z';
    const item = { at, key: 'v1', title: 'Video one', url: 'https://www.youtube.com/watch?v=v1', errorCode: 'no_subtitles', reason: 'no subtitles', attempts: 2 };
    expect(collectionRow({ kind: 'collected', at, key: 'v1', title: item.title, documentId: 'youtube:v1' })).toEqual({ kind: 'collected', title: item.title });
    expect(collectionRow({ kind: 'failed', ...item, maxAttempts: 3 })).toEqual({ kind: 'failed', title: item.title, reason: item.reason, attempts: 2, maxAttempts: 3 });
    expect(collectionRow({ kind: 'skipped', ...item, attempts: 3, skippedBy: 'limit' })).toEqual({ kind: 'skipped', title: item.title, skippedBy: 'limit', attempts: 3 });
    expect(collectionRow({ kind: 'skipped', ...item, reason: 'gone', attempts: 1, skippedBy: 'failure' })).toEqual({ kind: 'skipped', title: item.title, skippedBy: 'failure', reason: 'gone' });
    expect(collectionRow({ kind: 'failed', ...item, title: '', maxAttempts: 3 })).toMatchObject({ title: 'youtube.com/watch?v=v1' });
    const check = { kind: 'check' as const, at, jobId: 'j', trigger: 'scheduled' as const, created: 0, failed: 0, error: null };
    expect(collectionRow(check)).toEqual({ kind: 'check', outcome: 'empty' });
    expect(collectionRow({ ...check, created: 2 })).toEqual({ kind: 'check', outcome: 'collected', parts: [{ result: 'created', count: 2 }] });
    expect(collectionRow({ ...check, trigger: 'manual', failed: 1 })).toEqual({ kind: 'check', outcome: 'collected', parts: [{ result: 'failed', count: 1 }] });
    expect(collectionRow({ ...check, created: 3, failed: 2 })).toEqual({ kind: 'check', outcome: 'collected', parts: [{ result: 'created', count: 3 }, { result: 'failed', count: 2 }] });
    const error = { code: 'network_error', message: 'unreachable' };
    expect(collectionRow({ ...check, trigger: 'subscribe', created: 1, error })).toEqual({ kind: 'check', outcome: 'error', error });
    const group = { kind: 'check-group' as const, at, firstAt: '2026-10-14T05:30:00.000Z', groupId: 'g', trigger: 'scheduled' as const, count: 12, message: 'done' };
    expect(collectionRow({ ...group, result: 'empty' }, now)).toEqual({
      kind: 'check-group', result: 'empty', message: 'done', count: 12,
      span: { sameDay: false, start: { day: 'yesterday', time: '13:30' }, end: { day: 'today', time: '13:30' } },
    });
    expect(collectionRow({ ...group, firstAt: at, result: 'network_error', count: 5, errorCode: 'network_error' }, now))
      .toMatchObject({ result: 'network_error', count: 5, span: { sameDay: true } });
    expect(collectionRow({ ...group, result: 'created', count: 1 }, now)).toMatchObject({ result: 'other', count: 1, span: null });
  });

  it('says why work waits for a retry, in the source type\'s words for a failure it names', () => {
    const error = { code: 'network_error', message: 'unreachable' };
    expect(retryCause('youtube', { reason: 'rate_limited' })).toEqual({ reason: 'rate_limited', source: youtubeDeclaration.label });
    expect(retryCause('unregistered', { reason: 'rate_limited' })).toEqual({ reason: 'rate_limited', source: 'unregistered' });
    expect(retryCause('rss', { reason: 'failed', error, attempt: 2, maxAttempts: 3 })).toEqual({ reason: 'failed', error, attempt: 2, maxAttempts: 3 });
    expect(failureLabel('rss', error)).toBe(rssDeclaration.failureLabels?.network_error);
    expect(failureLabel('rss', { code: 'no_subtitles', message: 'own message' })).toBe('own message');
    expect(failureLabel('unregistered', error)).toBe(error.message);
  });

  it('compacts same-day ranges and keeps both dates and crossing years', () => {
    const now = new Date(2026, 9, 24, 12);
    const iso = (year: number, month: number, day: number, hour: number) => new Date(year, month, day, hour).toISOString();
    expect(timeSpan(iso(2026, 9, 24, 8), iso(2026, 9, 24, 14), now)).toEqual({ sameDay: true, start: { day: 'today', time: '08:00' }, endTime: '14:00' });
    expect(timeSpan(iso(2026, 9, 23, 23), iso(2026, 9, 24, 1), now)).toEqual({ sameDay: false, start: { day: 'yesterday', time: '23:00' }, end: { day: 'today', time: '01:00' } });
    expect(timeSpan(iso(2026, 9, 10, 8), iso(2026, 9, 11, 9), now)).toEqual({ sameDay: false, start: { day: 'date', date: '10-10', time: '08:00' }, end: { day: 'date', date: '10-11', time: '09:00' } });
    expect(timeSpan(iso(2025, 2, 1, 8), iso(2025, 2, 1, 9), now)).toMatchObject({ sameDay: true, start: { day: 'date', date: '2025-03-01' } });
    expect(timeSpan(iso(2025, 11, 31, 23), iso(2026, 0, 1, 1), now)).toEqual({
      sameDay: false, start: { day: 'date', date: '2025-12-31', time: '23:00' }, end: { day: 'date', date: '2026-01-01', time: '01:00' },
    });
  });

  it('names the subscriptions of the last and next check under the list, as their detail pages show them (A6)', () => {
    const now = new Date('2026-10-15T06:00:00.000Z');
    const lastCheck = { channelId: 'UC1', title: 'Money 800', at: '2026-10-15T06:00:00.000Z' };
    const next = { channelId: 'UC2', title: '3Blue1Brown', at: '2026-10-15T06:30:00.000Z' };
    const last = { at: { day: 'today', time: '14:00' }, title: lastCheck.title };
    expect(checkTimes({ enabled: true, lastCheck, nextCheck: next }, now)).toEqual({ last, next: { state: 'scheduled', at: { day: 'today', time: '14:30' }, title: next.title } });
    expect(checkTimes({ enabled: false, lastCheck, nextCheck: next }, now)).toEqual({ last, next: { state: 'auto_check_off' } });
    expect(checkTimes({ enabled: true, lastCheck: null, nextCheck: null }, now)).toEqual({ last: null, next: { state: 'none' } });
    expect(nextCheck({ enabled: true, nextCheckAt: next.at }, true, now)).toEqual({ state: 'scheduled', at: { day: 'today', time: '14:30' } });
    expect(nextCheck({ enabled: true, nextCheckAt: next.at }, null, now)).toEqual({ state: 'scheduled', at: { day: 'today', time: '14:30' } });
    expect(nextCheck({ enabled: true, nextCheckAt: next.at }, false, now)).toEqual({ state: 'auto_check_off' });
    expect(nextCheck({ enabled: false, nextCheckAt: null }, true, now)).toEqual({ state: 'paused' });
    expect(nextCheck({ enabled: true, nextCheckAt: null }, true, now)).toEqual({ state: 'queued' });
  });

  it('shortens names and addresses for display', () => {
    expect(initials('3Blue1Brown')).toBe('3B');
    expect(initials('【Synthetic】 Channel')).toBe('SY');
    expect(initials(' ')).toBe('?');
    expect(displayUrl('https://www.youtube.com/channel/UC1/videos')).toBe('youtube.com/channel/UC1');
  });

  it('applies a recognition answer only to the address it was given for', () => {
    const collect = { id: 'collect' as const, label: '收集影片', primary: true, request: { method: 'POST' as const, path: '/api/items', body: { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' } } };
    const recognition: UrlRecognition = {
      status: 'ready', sourceType: 'youtube', kind: 'video', kindLabel: 'YouTube 影片', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      target: { id: 'aaaaaaaaaaa', title: null, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
      subscription: null, policy: null, actions: [collect], login: null, message: null,
    };
    const answer = { input: 'youtu.be/aaaaaaaaaaa', recognition };
    expect(currentRecognition(answer, '  youtu.be/aaaaaaaaaaa ')).toEqual({ recognition, primary: collect });
    // The input changed while the next recognition waits: the old card and its action no longer apply.
    expect(currentRecognition(answer, 'youtu.be/bbbbbbbbbbb')).toBeNull();
    expect(currentRecognition(null, 'youtu.be/aaaaaaaaaaa')).toBeNull();
    expect(currentRecognition({ input: 'x', recognition: { ...recognition, actions: [] } }, 'x')).toEqual({ recognition: { ...recognition, actions: [] }, primary: null });
  });
});
