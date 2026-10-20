import { describe, expect, it } from 'vitest';
import type { CollectionJob, JobEvent } from '../../src/core/types.js';
import {
  activityQuery,
  activityStateSearch,
  diagnosticsText,
  eventLevel,
  eventText,
  jobStatusText,
  localDayStart,
  logWarning,
  mergeNewest,
  parseActivityState,
  summaryLabel,
} from '../../src/web/activity-presentation.js';

// Activity page wording and filters (A-T11).

const base = { eventId: 'e1', timestamp: '2026-10-15T06:00:00.000Z', vaultPath: '/v', jobId: 'j1', message: '訊息' } as const;

function job(overrides: Partial<CollectionJob>): CollectionJob {
  return {
    id: 'job-1', kind: 'youtube.video', state: 'completed', phase: null, vaultPath: '/v', parentId: null,
    source: { type: 'youtube', id: 'abc', url: 'https://www.youtube.com/watch?v=abc', title: 'Me at the zoo' },
    createdAt: '2026-10-15T05:00:00.000Z', startedAt: '2026-10-15T05:00:01.000Z', finishedAt: '2026-10-15T05:00:09.000Z',
    updatedAt: '2026-10-15T05:00:09.000Z', progress: null, items: null, result: null, error: null, ...overrides,
  };
}

describe('activity presentation', () => {
  it('derives level labels from severity, type and outcome', () => {
    expect(eventLevel({ severity: 'error', eventType: 'job.failed' })).toBe('ERR');
    expect(eventLevel({ severity: 'warning', eventType: 'job.retry_scheduled' })).toBe('WARN');
    expect(eventLevel({ severity: 'info', eventType: 'document.saved' })).toBe('OK');
    expect(eventLevel({ severity: 'info', eventType: 'job.completed', outcome: 'created' })).toBe('DONE');
    expect(eventLevel({ severity: 'info', eventType: 'job.completed', outcome: 'skipped' })).toBe('SKIP');
    expect(eventLevel({ severity: 'info', eventType: 'job.started' })).toBe('INFO');
  });

  it('prefixes the source title and the reason a channel job started', () => {
    expect(eventText({ ...base, eventType: 'job.accepted', sourceTitle: '3Blue1Brown', trigger: 'scheduled', message: '已接受收集工作。' }))
      .toBe('3Blue1Brown：定時檢查・已接受收集工作。');
    expect(eventText({ ...base, eventType: 'document.saved', sourceTitle: '影片', trigger: 'scheduled', parentJobId: 'p', message: '文件已保存。' }))
      .toBe('影片：文件已保存。');
    expect(eventText({ ...base, eventType: 'schedule.updated', message: '已暫停自動收集。' })).toBe('已暫停自動收集。');
    expect(eventText({ ...base, eventType: 'subscription.paused', sourceTitle: '3Blue1Brown', message: '已暫停「3Blue1Brown」。' }))
      .toBe('已暫停「3Blue1Brown」。');
  });

  it('keeps filters in the address and turns them into a query with local day bounds', () => {
    const state = parseActivityState('?level=errors&source=UC1&range=today&job=job-9');
    expect(state).toEqual({ level: 'errors', source: 'UC1', range: 'today', job: 'job-9' });
    expect(activityStateSearch(state)).toBe('?level=errors&source=UC1&range=today&job=job-9');
    expect(parseActivityState('?level=bogus&range=year')).toEqual({ level: 'all', source: null, range: '30d', job: null });
    expect(activityStateSearch(parseActivityState(''))).toBe('');

    const now = new Date(2026, 9, 15, 0, 30);
    expect(activityQuery(state, now)).toEqual({ severity: ['warning', 'error'], subscriptionId: 'UC1', jobId: 'job-9', since: new Date(2026, 9, 15).toISOString() });
    expect(activityQuery({ level: 'added', source: null, range: '7d', job: null }, now)).toEqual({ eventType: ['document.saved'], since: new Date(2026, 9, 9).toISOString() });
    expect(activityQuery({ level: 'all', source: null, range: '30d', job: null }, now)).toEqual({});
    expect(localDayStart(now).getHours()).toBe(0);
    expect(localDayStart(now).getDate()).toBe(15);
  });

  it('words the summary, job rows and log warnings', () => {
    expect(summaryLabel({ active: 2, completed: 14, failed: 1 })).toBe('進行中 2 · 今天完成 14 · 失敗 1');
    expect(jobStatusText(job({ result: { outcome: 'created', saved: true, indexed: true } }))).toBe('已加入');
    expect(jobStatusText(job({
      kind: 'youtube.channel', state: 'running', phase: 'capture', scope: { trigger: 'scheduled' },
      progress: { total: 10, done: 4, created: 4, existing: 0, failed: 0 },
    }))).toBe('收集影片 4／10');
    expect(jobStatusText(job({ state: 'failed', error: { code: 'network_error', message: '無法連線到 YouTube，請稍後再試。（已嘗試 3 次）' } })))
      .toBe('無法連線到 YouTube，請稍後再試。（已嘗試 3 次）');
    expect(logWarning(null)).toBeNull();
    expect(logWarning({ state: 'ok', pending: 0, dropped: 0, lastFailureAt: null, lastError: null, skippedLines: 3 })).toBeNull();
    expect(logWarning({ state: 'failing', pending: 4, dropped: 0, lastFailureAt: 'x', lastError: 'EACCES', skippedLines: 0 }))
      .toBe('記錄暫時無法寫入，4 筆記錄等待補寫。');
    expect(logWarning({ state: 'ok', pending: 0, dropped: 2, lastFailureAt: 'x', lastError: 'EACCES', skippedLines: 0 }))
      .toBe('有 2 筆記錄未能寫入而遺失。');
  });

  it('builds diagnostics in time order with error codes and masked detail', () => {
    const failed = job({ state: 'failed', error: { code: 'network_error', message: '無法連線' }, retry: { attempts: 3, maxAttempts: 3, nextAttemptAt: null, lastError: { code: 'network_error', message: '無法連線' } } });
    const events: JobEvent[] = [
      { ...base, eventId: 'b', timestamp: '2026-10-15T05:00:09.000Z', severity: 'error', eventType: 'job.failed', errorCode: 'network_error', message: '無法連線', detail: 'ERROR: timed out\nCookie: [已遮蔽]' },
      { ...base, eventId: 'a', timestamp: '2026-10-15T05:00:00.000Z', severity: 'info', eventType: 'job.accepted', message: '已接受收集工作。' },
    ];
    const text = diagnosticsText(failed, events);
    expect(text).toContain('工作：job-1');
    expect(text).toContain('錯誤：network_error：無法連線');
    expect(text).toContain('自動重試：已嘗試 3／3 次');
    expect(text.indexOf('job.accepted')).toBeLessThan(text.indexOf('job.failed'));
    expect(text).toContain('    Cookie: [已遮蔽]');
  });

  it('adds a fresh first page above loaded entries without repeating any', () => {
    const entry = (id: string) => ({ ...base, eventId: id, severity: 'info' as const, eventType: 'job.started' });
    expect(mergeNewest([entry('b'), entry('a')], [entry('c'), entry('b')]).map((item) => item.eventId)).toEqual(['c', 'b', 'a']);
  });
});
