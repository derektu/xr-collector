// Broken, log lines lose the titles their jobs learned later, and open screens miss recorded events.
import { describe, expect, it } from 'vitest';
import type { Change } from '../../../src/shared/api/changes.js';
import type { CollectionJob } from '../../../src/shared/jobs/job-types.js';
import { memoryJobRecords } from '../../../src/app/runtime/job-records.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';

const VAULT = '/vaults/records';
const VAULT_ID = 'vault-id';
const NOW = new Date('2026-10-15T06:00:00.000Z');

function job(id: string, title: string | null): CollectionJob {
  return {
    id, kind: 'youtube.video', state: 'running', phase: 'capture', vaultPath: VAULT, vaultId: VAULT_ID, parentId: null,
    source: { type: 'youtube', id, url: `https://example.test/${id}`, title }, createdAt: NOW.toISOString(), startedAt: NOW.toISOString(),
    finishedAt: null, updatedAt: NOW.toISOString(), progress: null, items: null, result: null, error: null,
  };
}

describe('job records', () => {
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
