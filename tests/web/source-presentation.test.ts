import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionJob, SubscriptionEntry, UrlRecognition } from '../../src/core/types.js';
import {
  activeJobs,
  currentRecognition,
  displayUrl,
  filterSources,
  initials,
  collectionEntryLabel,
  parseSourceListState,
  shortTimeLabel,
  sourceListSearch,
  sourcePath,
  sourceRouteForPath,
  checkTimesLine,
  nextCheckLabel,
} from '../../src/web/source-presentation.js';

const originalZone = process.env.TZ;
beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
afterEach(() => { process.env.TZ = originalZone; });

function source(overrides: Partial<SubscriptionEntry>): SubscriptionEntry {
  return {
    id: 'UC1', title: '頻道', url: 'https://www.youtube.com/channel/UC1/videos', enabled: true, addedAt: '2026-10-01T00:00:00.000Z',
    settings: { intervalMinutes: 30, backfillWindow: '1m', backfillMaxItems: 10 }, status: 'tracking', checkStatus: { state: 'scheduled', nextCheckAt: null }, lastError: null, activeJob: null, documentCount: 0, lastCollectedAt: null,
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
    expect(shortTimeLabel('2026-10-15T05:30:00.000Z', now)).toBe('今天 13:30');
    expect(shortTimeLabel('2026-10-14T13:05:00.000Z', now)).toBe('昨天 21:05');
    expect(shortTimeLabel('2026-10-13T16:30:00.000Z', now)).toBe('昨天 00:30');
    expect(shortTimeLabel('2026-10-12T16:30:00.000Z', now)).toBe('10-13 00:30');
    expect(shortTimeLabel('2025-12-31T01:00:00.000Z', now)).toBe('2025-12-31');
  });

  it('filters by type and by name', () => {
    const sources = [source({ id: 'a', title: 'Alpha Talks' }), source({ id: 'b', title: '財經八百' })];
    expect(filterSources(sources, { type: '', query: 'alpha' }).map((entry) => entry.id)).toEqual(['a']);
    expect(filterSources(sources, { type: 'youtube', query: '八百' }).map((entry) => entry.id)).toEqual(['b']);
    expect(filterSources(sources, { type: 'rss', query: '' })).toEqual([]);
  });

  it('keeps list filters and source detail addresses in the URL', () => {
    expect(sourceListSearch({ type: 'youtube', query: '財經' })).toBe('?type=youtube&q=%E8%B2%A1%E7%B6%93');
    expect(parseSourceListState('?type=youtube&q=%E8%B2%A1%E7%B6%93')).toEqual({ type: 'youtube', query: '財經' });
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
    const at = '2026-10-15T05:30:00.000Z';
    const item = { at, key: 'v1', title: '影片一', url: 'https://www.youtube.com/watch?v=v1', errorCode: 'no_subtitles', reason: '沒有字幕', attempts: 2 };
    expect(collectionEntryLabel({ kind: 'collected', at, key: 'v1', title: '影片一', documentId: 'youtube:v1' }, 'youtube')).toEqual({ title: '影片一', detail: '' });
    expect(collectionEntryLabel({ kind: 'failed', ...item, maxAttempts: 3 }, 'youtube').detail).toBe('沒有字幕・已試 2/3 次');
    expect(collectionEntryLabel({ kind: 'skipped', ...item, attempts: 3, skippedBy: 'limit' }, 'youtube').detail).toBe('已略過・已試 3 次');
    expect(collectionEntryLabel({ kind: 'skipped', ...item, reason: '影片不存在', attempts: 1, skippedBy: 'failure' }, 'youtube').detail).toBe('已略過・影片不存在');
    expect(collectionEntryLabel({ kind: 'failed', ...item, title: '', maxAttempts: 3 }, 'youtube').title).toBe('youtube.com/watch?v=v1');
    const check = { kind: 'check' as const, at, jobId: 'j', trigger: 'scheduled' as const, created: 0, failed: 0, error: null };
    expect(collectionEntryLabel(check, 'youtube').title).toBe('定時檢查・沒有新影片');
    expect(collectionEntryLabel({ ...check, created: 2 }, 'youtube').title).toBe('定時檢查・收集 2 支');
    expect(collectionEntryLabel({ ...check, trigger: 'manual', created: 1, failed: 1 }, 'youtube').title).toBe('立即檢查・收集 1 支・失敗 1 支');
    expect(collectionEntryLabel({ ...check, trigger: 'subscribe', error: { code: 'network_error', message: '無法連線到 YouTube。' } }, 'youtube').title)
      .toBe('首次收集・檢查失敗・網路錯誤');
  });

  it('names the subscriptions of the last and next check under the list, as their detail pages show them (A6)', () => {
    const now = new Date('2026-10-15T06:00:00.000Z');
    const lastCheck = { channelId: 'UC1', title: '財經八百', at: '2026-10-15T06:00:00.000Z' };
    const nextCheck = { channelId: 'UC2', title: '3Blue1Brown', at: '2026-10-15T06:30:00.000Z' };
    expect(checkTimesLine({ enabled: true, lastCheck, nextCheck }, now)).toBe('上次檢查 今天 14:00（財經八百） · 下次檢查 今天 14:30（3Blue1Brown）');
    expect(checkTimesLine({ enabled: false, lastCheck, nextCheck: null }, now)).toBe('上次檢查 今天 14:00（財經八百） · 自動檢查已關閉');
    expect(checkTimesLine({ enabled: true, lastCheck: null, nextCheck: null }, now)).toBe('上次檢查 尚未檢查');
    expect(nextCheckLabel({ enabled: true, nextCheckAt: nextCheck.at }, true, now)).toBe('今天 14:30');
    expect(nextCheckLabel({ enabled: true, nextCheckAt: nextCheck.at }, false, now)).toBe('自動檢查已關閉');
    expect(nextCheckLabel({ enabled: false, nextCheckAt: null }, true, now)).toBe('已暫停');
    expect(nextCheckLabel({ enabled: true, nextCheckAt: null }, true, now)).toBe('排隊中');
  });

  it('shortens names and addresses for display', () => {
    expect(initials('3Blue1Brown')).toBe('3B');
    expect(initials('合成頻道 A【合成】')).toBe('合成');
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
