import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionJob, SourceEntry, SourceJobRecord, UrlRecognition } from '../../src/core/types.js';
import {
  activeJobs,
  backgroundStatus,
  collectingSummary,
  currentRecognition,
  displayUrl,
  filterSources,
  initials,
  jobRecordLabel,
  parseSourceListState,
  sharedPolicySummary,
  shortTimeLabel,
  showsSingleItems,
  sourceListSearch,
  sourcePath,
  sourceRouteForPath,
  sourceStatusLabel,
} from '../../src/web/source-presentation.js';

const originalZone = process.env.TZ;
beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
afterEach(() => { process.env.TZ = originalZone; });

function source(overrides: Partial<SourceEntry>): SourceEntry {
  return {
    id: 'UC1', title: '頻道', url: 'https://www.youtube.com/channel/UC1/videos', enabled: true, addedAt: '2026-10-01T00:00:00.000Z',
    status: 'tracking', lastError: null, activeJob: null, documentCount: 0, lastCollectedAt: null,
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
  it('labels each status, with item progress while collecting', () => {
    expect(sourceStatusLabel(source({}))).toBe('追蹤中');
    expect(sourceStatusLabel(source({ status: 'collecting', activeJob: { id: 'j', done: 4, total: 10 } }))).toBe('收集中 4／10');
    expect(sourceStatusLabel(source({ status: 'collecting', activeJob: { id: 'j', done: 0, total: 0 } }))).toBe('收集中');
    expect(sourceStatusLabel(source({ status: 'paused', enabled: false }))).toBe('已暫停');
    expect(sourceStatusLabel(source({ status: 'error', lastError: { code: 'network_error', message: '連線失敗' } }))).toBe('錯誤');
  });

  it('formats times relative to today in the device time zone', () => {
    const now = new Date('2026-10-15T06:00:00.000Z'); // 14:00 in Taipei
    expect(shortTimeLabel('2026-10-15T05:30:00.000Z', now)).toBe('今天 13:30');
    expect(shortTimeLabel('2026-10-14T13:05:00.000Z', now)).toBe('昨天 21:05');
    expect(shortTimeLabel('2026-10-13T16:30:00.000Z', now)).toBe('昨天 00:30');
    expect(shortTimeLabel('2026-10-12T16:30:00.000Z', now)).toBe('10-13 00:30');
    expect(shortTimeLabel('2025-12-31T01:00:00.000Z', now)).toBe('2025-12-31');
  });

  it('filters by type and by name, and shows the single-item row only unfiltered', () => {
    const sources = [source({ id: 'a', title: 'Alpha Talks' }), source({ id: 'b', title: '財經八百' })];
    expect(filterSources(sources, { type: '', query: 'alpha' }).map((entry) => entry.id)).toEqual(['a']);
    expect(filterSources(sources, { type: 'youtube', query: '八百' }).map((entry) => entry.id)).toEqual(['b']);
    expect(filterSources(sources, { type: 'rss', query: '' })).toEqual([]);
    expect(showsSingleItems({ type: '', query: '' }, 3)).toBe(true);
    expect(showsSingleItems({ type: '', query: '' }, 0)).toBe(false);
    expect(showsSingleItems({ type: 'youtube', query: '' }, 3)).toBe(false);
    expect(showsSingleItems({ type: '', query: 'a' }, 3)).toBe(false);
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

  it('counts each active top-level job once and words the sidebar state', () => {
    const jobs = [
      job({ id: 'a', progress: { total: 10, done: 4, created: 4, existing: 0, failed: 0 } }),
      job({ id: 'b', state: 'queued', source: { type: 'youtube', id: null, url: 'https://youtu.be/x', title: null } }),
      job({ id: 'c', state: 'completed' }),
      job({ id: 'd', kind: 'youtube.video', parentId: 'a' }),
    ];
    const active = activeJobs(jobs);
    expect(active.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(collectingSummary(active)).toBe('正在收集 2 項：頻道一（4／10）、https://youtu.be/x');
    expect(backgroundStatus(2, { enabled: true })).toEqual({ tone: 'busy', text: '背景收集中' });
    expect(backgroundStatus(0, { enabled: true })).toEqual({ tone: 'on', text: '自動收集開啟' });
    expect(backgroundStatus(0, { enabled: false })).toEqual({ tone: 'off', text: '自動收集已暫停' });
  });

  it('describes collection records and the shared settings', () => {
    const now = new Date('2026-10-15T06:00:00.000Z');
    const record = (overrides: Partial<SourceJobRecord>): SourceJobRecord => ({
      id: 'r', state: 'completed', trigger: 'scheduled', createdAt: '2026-10-15T05:00:00.000Z', startedAt: null,
      finishedAt: '2026-10-15T05:30:00.000Z', progress: { total: 1, done: 1, created: 1, existing: 0, failed: 0 }, outcome: 'created', error: null,
      retry: null, resumedCount: 0, ...overrides,
    });
    expect(jobRecordLabel(record({}), now)).toEqual({ title: '定時檢查', detail: '今天 13:30 · 新增 1', active: false });
    expect(jobRecordLabel(record({ trigger: 'subscribe', progress: { total: 0, done: 0, created: 0, existing: 0, failed: 0 }, outcome: 'empty' }), now).detail).toBe('今天 13:30 · 沒有新影片');
    expect(jobRecordLabel(record({ state: 'running', progress: { total: 10, done: 4, created: 4, existing: 0, failed: 0 } }), now)).toEqual({ title: '定時檢查', detail: '4／10', active: true });
    expect(jobRecordLabel(record({ state: 'failed', trigger: 'manual', error: { code: 'network_error', message: '無法連線' } }), now).detail).toBe('今天 13:30 · 無法連線');
    // Work that continued after a restart, waits for a retry, or waits for its Vault to open again.
    const waiting = { attempts: 1, maxAttempts: 3, nextAttemptAt: '2026-10-15T06:02:00.000Z', lastError: { code: 'network_error', message: '無法連線' } };
    expect(jobRecordLabel(record({ state: 'running', resumedCount: 1, retry: waiting, progress: { total: 10, done: 4, created: 4, existing: 0, failed: 0 } }), now).detail)
      .toBe('4／10 · 等待重試 · 已接續');
    expect(jobRecordLabel(record({ resumedCount: 1 }), now).detail).toBe('今天 13:30 · 新增 1・曾中斷後接續');
    expect(jobRecordLabel(record({ state: 'interrupted' }), now).detail).toBe('今天 13:30 · 已中斷，重新開啟時接續');
    expect(sharedPolicySummary({ enabled: true, intervalMinutes: 30, backfillWindow: '1m', backfillMaxItems: 10 }))
      .toBe('每 30 分鐘檢查新影片；首次訂閱與恢復時補收最近 1 個月內最新的最多 10 支未收集影片。');
    expect(sharedPolicySummary({ enabled: true, intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 5 })).toMatch(/^每 1 小時檢查新影片/u);
    expect(sharedPolicySummary({ enabled: true, intervalMinutes: 1440, backfillWindow: '2w', backfillMaxItems: 5 })).toMatch(/^每天檢查新影片/u);
    expect(sharedPolicySummary({ enabled: false, intervalMinutes: 30, backfillWindow: '2w', backfillMaxItems: 5 })).toMatch(/^自動收集已暫停/u);
  });

  it('shortens names and addresses for display', () => {
    expect(initials('3Blue1Brown')).toBe('3B');
    expect(initials('合成頻道 A【合成】')).toBe('合成');
    expect(displayUrl('https://www.youtube.com/channel/UC1/videos')).toBe('youtube.com/channel/UC1');
  });

  it('applies a recognition answer only to the address it was given for', () => {
    const collect = { id: 'collect' as const, label: '收集影片', primary: true, request: { method: 'POST' as const, path: '/api/youtube/collect', body: { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' } } };
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
