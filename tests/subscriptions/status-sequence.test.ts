// Guards the developer, not the user.
// The judgments the recorded subscription flows make: the status texts a subscription shows, in the
// order the status model allows, the Jobs page sections a job passes through, and which collection
// check belongs to a failed job. A wrong judgment here passes or fails the flow for the wrong reason.
import { describe, expect, it } from 'vitest';
import { checkRecordForJob } from '../../.claude/skills/verify/flows/subscription-failures.mjs';
import { distinct, jobSectionChecks, subscriptionPhase, subscriptionSequenceChecks } from '../../.claude/skills/verify/flows/lib/status-sequence.mjs';

type Check = { id: string; ok: boolean; actual: unknown };
const failed = (checks: Check[]) => checks.filter((check) => !check.ok).map((check) => check.id);
const sequence = (...values: string[]) => subscriptionSequenceChecks('A', values, { total: 5 }) as Check[];

describe('subscription status sequence', () => {
  it('matches a collection check by job identity when event and job timestamps differ', () => {
    const recordAt = '2026-10-26T03:04:09.841Z';
    const jobFinishedAt = '2026-10-26T03:04:09.840Z';
    const record = checkRecordForJob([
      { kind: 'check', jobId: 'other-job', at: jobFinishedAt },
      { kind: 'check', jobId: 'failed-job', at: recordAt },
    ], 'failed-job');
    expect(record).toMatchObject({ jobId: 'failed-job', at: recordAt });
    expect(record?.at).not.toBe(jobFinishedAt);
  });

  it('classifies the status texts of the status model', () => {
    expect(subscriptionPhase('排隊中')).toEqual({ phase: 'queued' });
    expect(subscriptionPhase('檢查中')).toEqual({ phase: 'checking' });
    expect(subscriptionPhase('下載中 2/5')).toEqual({ phase: 'downloading', done: 2, total: 5 });
    for (const next of ['下次 18:52', '下次 明天 08:00', '下次 10-24 08:00']) expect(subscriptionPhase(next)).toEqual({ phase: 'scheduled' });
    for (const other of ['更新中 2/5', '執行中', '下載中', '下次']) expect(subscriptionPhase(other)).toEqual({ phase: 'unknown' });
  });

  it('passes the full sequence and one that skips 排隊中 and 檢查中', () => {
    expect(failed(sequence('排隊中', '檢查中', '下載中 0/5', '下載中 1/5', '下載中 4/5', '下次 18:52'))).toEqual([]);
    expect(failed(sequence('下載中 0/5', '下載中 3/5', '下次 18:52'))).toEqual([]);
  });

  it('fails a return to 排隊中 after the check started and names the segment', () => {
    const checks = sequence('排隊中', '下載中 1/5', '排隊中', '下載中 2/5', '下次 18:52');
    expect(failed(checks)).toEqual(['A.status.no-requeue', 'A.status.forward']);
    expect(checks.find((check) => check.id === 'A.status.no-requeue')?.actual).toEqual(['下載中 1/5 → 排隊中']);
  });

  it('fails a text outside the status model and lists it', () => {
    const checks = sequence('排隊中', '更新中 1/5', '下載中 2/5', '下次 18:52');
    expect(failed(checks)).toEqual(['A.status.known']);
    expect(checks[0].actual).toEqual(['更新中 1/5']);
  });

  it('fails progress that goes back, a wrong total, no 下載中 and an end other than 下次', () => {
    expect(failed(sequence('下載中 3/5', '下載中 2/5', '下次 18:52'))).toEqual(['A.status.progress']);
    expect(failed(sequence('下載中 1/4', '下次 18:52'))).toEqual(['A.status.progress']);
    expect(failed(sequence('檢查中', '下次 18:52'))).toEqual(['A.status.downloading-seen']);
    expect(failed(sequence('下載中 1/5', '下載中 4/5'))).toEqual(['A.status.final']);
  });

  it('gives every check a value, also when nothing was sampled', () => {
    for (const check of sequence()) expect(check.actual).not.toBeUndefined();
  });

  it('collapses samples into distinct consecutive values', () => {
    expect(distinct([{ value: 'a' }, { value: 'a' }, { value: 'b' }, { value: 'a' }])).toEqual(['a', 'b', 'a']);
  });
});

describe('job sections', () => {
  it('fails a job that returns to 排隊中 after 進行中', () => {
    expect(failed(jobSectionChecks('A', ['queued', 'running']) as Check[])).toEqual([]);
    const checks = jobSectionChecks('B', ['queued', 'running', 'queued', 'running']) as Check[];
    expect(failed(checks)).toEqual(['B.jobs.no-requeue']);
    expect(checks[0].actual).toEqual(['running → queued']);
  });

  it('fails a job never seen on the Jobs page', () => {
    const checks = jobSectionChecks('A', []) as Check[];
    expect(failed(checks)).toEqual(['A.jobs.no-requeue']);
    expect(checks[0].actual).toEqual([]);
  });
});
