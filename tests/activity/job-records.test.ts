// The job record and the activity log are kept apart and meet in the job records: a job whose events
// the log had to drop says its timeline is incomplete, a log line shows the title its job learned
// after the line was written, and each recorded event reaches the screens that follow changes.
// Broken, the Jobs page would show a partial timeline as complete, or the log would lose titles.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Change } from '../../src/core/changes.js';
import type { CollectionJob } from '../../src/core/job-types.js';
import { memoryJobRecords, openJobRecords } from '../../src/runtime/job-records.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';

const VAULT = '/vaults/records';
const NOW = new Date('2026-10-15T06:00:00.000Z');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function job(id: string, title: string | null): CollectionJob {
  return {
    id, kind: 'youtube.video', state: 'running', phase: 'capture', vaultPath: VAULT, parentId: null,
    source: { type: 'youtube', id, url: `https://example.test/${id}`, title }, createdAt: NOW.toISOString(), startedAt: NOW.toISOString(),
    finishedAt: null, updatedAt: NOW.toISOString(), progress: null, items: null, result: null, error: null,
  };
}

describe('job records', () => {
  it('marks a job whose events the log dropped, on disk', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xr-job-records-'));
    directories.push(directory);
    const records = await openJobRecords(directory, PRODUCT_SOURCES, {
      now: () => NOW, setTimer: () => () => undefined, append: async () => { throw new Error('disk full'); },
    });
    records.jobs.put(job('dropped', 'A'));
    records.jobs.put(job('kept', 'B'));
    records.jobs.event({ eventType: 'job.started', message: '開始', vaultPath: VAULT, jobId: 'dropped' });
    for (let index = 0; index < 1000; index += 1) records.jobs.event({ eventType: 'job.started', message: '開始', vaultPath: VAULT, jobId: 'kept' });
    await records.jobs.flush();
    const stored = JSON.parse(await readFile(path.join(directory, 'jobs.json'), 'utf8')) as { jobs: CollectionJob[] };
    expect(stored.jobs.map((entry) => [entry.id, entry.activityIncomplete ?? false])).toEqual([['dropped', true], ['kept', false]]);
    await records.close();
  });

  it('shows the title a job learned after its events were written, and notes each recorded event', async () => {
    const changes: Change[] = [];
    const records = memoryJobRecords(PRODUCT_SOURCES, { now: () => NOW, noteChange: (change) => changes.push(change) });
    records.jobs.put(job('video', null));
    records.jobs.event({ eventType: 'job.started', message: '開始', vaultPath: VAULT, jobId: 'video' });
    records.jobs.put(job('video', '後來知道的標題'));
    const [started] = (await records.views.query({}, { vaultPath: VAULT })).events;
    expect(started).toMatchObject({ eventType: 'job.started', sourceTitle: '後來知道的標題' });
    expect(changes.filter((change) => change.kind === 'activity')).toHaveLength(1);
  });
});
