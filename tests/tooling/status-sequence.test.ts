// Guards the developer, not the user.
// The judgments the recorded subscription flows make: the statuses a subscription row shows, in the
// order the status model allows, the Jobs page sections a job passes through, and which collection
// check belongs to a failed job. A wrong judgment here passes or fails the flow for the wrong reason.
import { describe, expect, it } from 'vitest';
// @ts-expect-error The verify skill flows are executable JavaScript without type declarations.
import { checkRecordForJob } from '../../.claude/skills/verify/flows/subscription-failures.mjs';
// @ts-expect-error The verify skill flows are executable JavaScript without type declarations.
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

  it('reads the sampled statuses of the status chip', () => {
    expect(subscriptionPhase('queued')).toEqual({ phase: 'queued' });
    expect(subscriptionPhase('downloading 2/5')).toEqual({ phase: 'downloading', done: 2, total: 5 });
    expect(subscriptionPhase('failing 3')).toEqual({ phase: 'failing', failures: 3 });
  });

  it('passes the full sequence and one that skips queued and checking', () => {
    expect(failed(sequence('queued', 'checking', 'downloading 0/5', 'downloading 1/5', 'downloading 4/5', 'scheduled'))).toEqual([]);
    expect(failed(sequence('downloading 0/5', 'downloading 3/5', 'scheduled'))).toEqual([]);
  });

  it('fails a return to queued after the check started and names the segment', () => {
    const checks = sequence('queued', 'downloading 1/5', 'queued', 'downloading 2/5', 'scheduled');
    expect(failed(checks)).toEqual(['A.status.no-requeue', 'A.status.forward']);
    expect(checks.find((check) => check.id === 'A.status.no-requeue')?.actual).toEqual(['downloading 1/5 → queued']);
  });

  it('fails a phase outside a check and lists it', () => {
    const checks = sequence('queued', 'retrying', 'downloading 2/5', 'scheduled');
    expect(failed(checks)).toEqual(['A.status.known']);
    expect(checks[0]?.actual).toEqual(['retrying']);
  });

  it('fails progress that goes back, a wrong total, no downloading and an end other than scheduled', () => {
    expect(failed(sequence('downloading 3/5', 'downloading 2/5', 'scheduled'))).toEqual(['A.status.progress']);
    expect(failed(sequence('downloading 1/4', 'scheduled'))).toEqual(['A.status.progress']);
    expect(failed(sequence('checking', 'scheduled'))).toEqual(['A.status.downloading-seen']);
    expect(failed(sequence('downloading 1/5', 'downloading 4/5'))).toEqual(['A.status.final']);
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
    expect(checks[0]?.actual).toEqual(['running → queued']);
  });

  it('fails a job never seen on the Jobs page', () => {
    const checks = jobSectionChecks('A', []) as Check[];
    expect(failed(checks)).toEqual(['A.jobs.no-requeue']);
    expect(checks[0]?.actual).toEqual([]);
  });
});
