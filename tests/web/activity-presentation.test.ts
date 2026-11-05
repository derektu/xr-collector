import { describe, expect, it } from 'vitest';
import type { CollectionJob } from '../../src/core/job-types.js';
import type { JobEvent } from '../../src/core/activity-types.js';
import {
  activityQuery,
  activityStateSearch,
  diagnostics,
  eventLevel,
  eventLine,
  localDayStart,
  logProblem,
  logTime,
  mergeNewest,
  parseActivityState,
  summaryRange,
} from '../../src/web/activity-presentation.js';

// The Activity page: level labels, what each log line says and whose it is, filters kept in the
// address and turned into a query, log write problems, check summary ranges, and diagnostics of a
// job for a bug report (A-T11).

const base = { eventId: 'e1', timestamp: '2026-10-15T06:00:00.000Z', vaultPath: '/v', jobId: 'j1', message: 'message' } as const;

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
    expect(eventLevel({ severity: 'debug' })).toBe('DEBUG');
    expect(eventLevel({ severity: 'info' })).toBe('INFO');
    expect(eventLevel({ severity: 'warning' })).toBe('WARN');
    expect(eventLevel({ severity: 'error' })).toBe('ERROR');
  });

  it('leads a line with its source and tells subscription requests from collection', () => {
    const source = '3Blue1Brown';
    expect(eventLine({ ...base, eventType: 'job.accepted', sourceTitle: source, jobRole: 'check' })).toEqual({ line: 'accepted', source, adding: false });
    expect(eventLine({ ...base, eventType: 'job.started', sourceTitle: source, jobRole: 'check' })).toEqual({ line: 'started', source, adding: false });
    expect(eventLine({ ...base, eventType: 'job.accepted', sourceTitle: source, jobRole: 'add' })).toEqual({ line: 'accepted', source, adding: true });
    expect(eventLine({ ...base, eventType: 'job.started', sourceTitle: null, jobRole: 'add' })).toEqual({ line: 'started', source: null, adding: true });
    expect(eventLine({ ...base, eventType: 'document.saved', sourceTitle: source })).toEqual({ line: 'document_saved', source });
    expect(eventLine({ ...base, eventType: 'subscription.added', sourceTitle: source })).toEqual({ line: 'subscription_added', source });
    expect(eventLine({ ...base, eventType: 'job.failed', sourceTitle: source })).toEqual({ line: 'failed', source, message: base.message });
    expect(eventLine({ ...base, eventType: 'job.completed', sourceTitle: source, jobRole: 'add' })).toEqual({ line: 'subscribed', source });
    expect(eventLine({ ...base, eventType: 'schedule.updated' })).toEqual({ line: 'message', source: null, message: base.message });
  });

  // The message only ever shows: rewording what the server says changes neither which completions
  // read as collected nor whose title leads a line. Every message here is arbitrary text.
  it('tells a collected completion and its result from the event fields, whatever the message says', () => {
    const source = '3Blue1Brown';
    const completed = { ...base, eventType: 'job.completed', sourceTitle: source, message: 'any wording' } as const;
    const counts = { trigger: 'manual', result: 'other', created: 2, existing: 1, failed: 1, skipped: 3 } as const;
    expect(eventLine({ ...completed, jobRole: 'item', outcome: 'created' }))
      .toEqual({ line: 'collected', source, collected: { result: 'stored', indexed: true } });
    expect(eventLine({ ...completed, jobRole: 'item', outcome: 'created', indexed: false }))
      .toEqual({ line: 'collected', source, collected: { result: 'stored', indexed: false } });
    expect(eventLine({ ...completed, jobRole: 'check', outcome: 'partial', check: counts }))
      .toEqual({ line: 'collected', source, collected: { result: 'counts', created: 2, existing: 1, skipped: 3, failed: 1 } });
    expect(eventLine({ ...completed, jobRole: 'check', outcome: 'empty', check: { ...counts, result: 'empty', created: 0, existing: 0, failed: 0, skipped: 0 } }))
      .toEqual({ line: 'collected', source, collected: { result: 'nothing_new' } });
    // An item already stored, a skipped job, and a check recorded without its counts keep their message.
    for (const event of [
      { ...completed, jobRole: 'item', outcome: 'existing' },
      { ...completed, jobRole: 'item', outcome: 'skipped' },
      { ...completed, jobRole: 'check', outcome: 'skipped', check: counts },
      { ...completed, jobRole: 'check', outcome: 'created' },
    ] as const) expect(eventLine(event)).toEqual({ line: 'completed', source, message: completed.message });
    expect(eventLine({ ...completed, eventType: 'job.failed', jobRole: 'item', outcome: 'failed' })).toMatchObject({ line: 'failed' });
  });

  it('leads a plain message with its source unless the event says the message names it', () => {
    const source = '3Blue1Brown';
    const naming = `paused ${source}`;
    expect(eventLine({ ...base, eventType: 'subscription.paused', sourceTitle: source, message: naming, namesSource: true })).toEqual({ line: 'message', source: null, message: naming });
    expect(eventLine({ ...base, eventType: 'subscription.paused', sourceTitle: source, message: 'paused', namesSource: true })).toEqual({ line: 'message', source: null, message: 'paused' });
    expect(eventLine({ ...base, eventType: 'job.retry_scheduled', sourceTitle: source, message: naming })).toEqual({ line: 'message', source, message: naming });
  });

  it('keeps filters in the address and turns them into a query with local day bounds', () => {
    const state = parseActivityState('?mode=raw&type=documents&minLevel=warning&source=UC1&range=today&job=job-9&group=g1&return=%2Factivity');
    expect(state).toEqual({ mode: 'raw', recordType: 'documents', minLevel: 'warning', source: 'UC1', range: 'today', job: 'job-9', group: 'g1', returnTo: '/activity' });
    expect(activityStateSearch(state)).toBe('?mode=raw&type=documents&minLevel=warning&source=UC1&range=today&job=job-9&group=g1&return=%2Factivity');
    expect(parseActivityState('?type=bogus&minLevel=fatal&range=year')).toEqual({ mode: 'summary', recordType: 'all', minLevel: 'info', source: null, range: '30d', job: null, group: null, returnTo: null });
    expect(activityStateSearch(parseActivityState(''))).toBe('');

    const now = new Date(2026, 9, 15, 0, 30);
    expect(activityQuery(state, now)).toEqual({ severity: ['warning', 'error'], eventType: ['document.saved'], subscriptionId: 'UC1', jobId: 'job-9', since: new Date(2026, 9, 15).toISOString() });
    expect(activityQuery({ mode: 'summary', recordType: 'documents', minLevel: 'error', source: null, range: '7d', job: null, group: null, returnTo: null }, now)).toEqual({ severity: ['error'], eventType: ['document.saved'], since: new Date(2026, 9, 9).toISOString() });
    expect(activityQuery({ mode: 'summary', recordType: 'all', minLevel: 'debug', source: null, range: '30d', job: null, group: null, returnTo: null }, now)).toEqual({ severity: ['debug', 'info', 'warning', 'error'] });
    expect(localDayStart(now).getHours()).toBe(0);
    expect(localDayStart(now).getDate()).toBe(15);
  });

  it('reports events waiting to be written and events lost', () => {
    const health = { state: 'ok' as const, pending: 0, dropped: 0, lastFailureAt: null, lastError: null, skippedLines: 3 };
    expect(logProblem(null)).toBeNull();
    expect(logProblem(health)).toBeNull();
    expect(logProblem({ ...health, state: 'failing', pending: 4 })).toEqual({ state: 'failing', pending: 4, dropped: null });
    expect(logProblem({ ...health, state: 'failing', pending: 4, dropped: 1 })).toEqual({ state: 'failing', pending: 4, dropped: 1 });
    expect(logProblem({ ...health, dropped: 2 })).toEqual({ state: 'lost', dropped: 2 });
  });

  it('shows both dates for a summary spanning local midnight and one time for a singleton', () => {
    const first = '2026-10-20T15:59:00.000Z';
    const last = '2026-10-20T16:01:00.000Z';
    expect(summaryRange(first, last)).toBe(`${logTime(first)}–${logTime(last)}`);
    expect(summaryRange(last, last)).toBe(logTime(last));
  });

  it('builds diagnostics in time order with error codes and masked detail', () => {
    const error = { code: 'network_error', message: 'unreachable' };
    const failed = job({ state: 'failed', error, retry: { attempts: 3, maxAttempts: 3, nextAttemptAt: null, lastError: error } });
    const events: JobEvent[] = [
      { ...base, eventId: 'b', timestamp: '2026-10-15T05:00:09.000Z', severity: 'error', eventType: 'job.failed', errorCode: 'network_error', message: 'unreachable', detail: 'ERROR: timed out\nCookie: [masked]' },
      { ...base, eventId: 'a', timestamp: '2026-10-15T05:00:00.000Z', severity: 'info', eventType: 'job.accepted', message: 'accepted' },
    ];
    const report = diagnostics(failed, events);
    expect(report).toMatchObject({ id: 'job-1', state: 'failed', error, retry: { attempts: 3, maxAttempts: 3 }, resumedCount: null, retryOf: null, retriedBy: null });
    expect(report.events).toEqual([
      { timestamp: '2026-10-15T05:00:00.000Z', level: 'INFO', eventType: 'job.accepted', errorCode: null, message: 'accepted', detail: [] },
      { timestamp: '2026-10-15T05:00:09.000Z', level: 'ERROR', eventType: 'job.failed', errorCode: 'network_error', message: 'unreachable', detail: ['ERROR: timed out', 'Cookie: [masked]'] },
    ]);
    const resumed = { resumedCount: 0, uncleanStops: 0, lastInterruptedAt: null, lastResumedAt: null };
    expect(diagnostics(job({ recovery: resumed, retryOf: 'job-0', retriedBy: 'job-2' }), [])).toMatchObject({ resumedCount: 0, retryOf: 'job-0', retriedBy: 'job-2' });
  });

  it('adds a fresh first page above loaded entries without repeating any', () => {
    const entry = (id: string) => ({ ...base, eventId: id, severity: 'info' as const, eventType: 'job.started' });
    expect(mergeNewest([entry('b'), entry('a')], [entry('c'), entry('b')]).map((item) => item.eventId)).toEqual(['c', 'b', 'a']);
  });
});
