import { jobRole } from '../core/source-registry.js';
import type { CollectionJob, JobOverview, JobOverviewEntry, JobRole, WorkStatus } from '../core/types.js';

/** How long a failed single item or subscription request stays in the failed section. */
export const FAILED_RETENTION_MS = 7 * 86_400_000;

/** What the jobs page needs to know about work beyond the jobs themselves. */
export interface JobBoardContext {
  now: Date;
  /** Where a job that has not started stands in its queue; smaller starts earlier. Unknown for jobs not in a queue. */
  queuePosition(job: CollectionJob): number | undefined;
  /** Whether an item of this type and key already has a document. */
  hasDocument(type: string, key: string): Promise<boolean>;
}

/**
 * What a queued or running top-level job is doing. A job that has not started is queued, also
 * while its source cools down; once started it never is again. A started job retries while its own
 * step waits for a retry or a cooldown, and a check also while every item it still collects does;
 * otherwise a check is downloading once it knows items to collect and checking before.
 */
export function workStatus(job: CollectionJob): WorkStatus {
  if (!job.startedAt) return { state: 'queued' };
  const own = retryOf(job);
  if (own) return own;
  const unfinished = (job.items ?? []).filter((item) => item.state === 'queued' || item.state === 'running');
  const items = unfinished.map(retryOf);
  if (items.length > 0 && items.every((item) => item !== null)) return earliest(items, (item) => item.at)!;
  switch (roleOf(job)) {
    case 'check': return job.progress?.total ? { state: 'downloading' } : { state: 'checking' };
    case 'add': return { state: 'checking' };
    default: return { state: 'downloading' };
  }
}

/** The retry a job or a check's item waits for: the cooldown's end, or its next attempt. */
function retryOf(work: Pick<CollectionJob, 'wait' | 'retry'>): Extract<WorkStatus, { state: 'retrying' }> | null {
  if (work.wait) return { state: 'retrying', at: work.wait.until, cause: { reason: 'rate_limited' } };
  if (!work.retry?.nextAttemptAt) return null;
  const { attempts, maxAttempts, nextAttemptAt, lastError } = work.retry;
  return { state: 'retrying', at: nextAttemptAt, cause: { reason: 'failed', error: lastError, attempt: attempts + 1, maxAttempts } };
}

/**
 * The jobs page from the Vault's top-level jobs, live ones with their items' current state. Work
 * that started is running until it finishes; work that has not started is queued in the order it
 * starts. Only the newest job of each target counts for the failed section.
 */
export async function jobOverview(jobs: readonly CollectionJob[], context: JobBoardContext): Promise<JobOverview> {
  const running: JobOverviewEntry[] = [];
  const queued: Array<{ entry: JobOverviewEntry; position: number }> = [];
  for (const job of jobs) {
    const role = roleOf(job);
    if (!role || job.parentId !== null || (job.state !== 'queued' && job.state !== 'running')) continue;
    const status = workStatus(job);
    const entry = entryOf(job, role, status);
    if (status.state === 'queued') queued.push({ entry, position: context.queuePosition(job) ?? Number.MAX_SAFE_INTEGER });
    else running.push(entry);
  }
  queued.sort((left, right) => left.position - right.position);
  return {
    running,
    queued: queued.map(({ entry }) => entry),
    failed: (await failedJobs(jobs, context)).map((job) => entryOf(job, roleOf(job)!, null)),
  };
}

/**
 * Failed single items and subscription requests the failed section lists, newest first: not
 * retried, not removed, younger than the retention, newer than every other job of the same target,
 * and, for an item, without a document of the same type and key.
 */
export async function failedJobs(jobs: readonly CollectionJob[], context: Pick<JobBoardContext, 'now' | 'hasDocument'>): Promise<CollectionJob[]> {
  const newest = new Map<string, CollectionJob>();
  for (const job of jobs) {
    const role = roleOf(job);
    if (job.parentId !== null || (role !== 'item' && role !== 'add')) continue;
    const key = targetKey(job, role);
    const current = newest.get(key);
    if (!current || job.createdAt > current.createdAt) newest.set(key, job);
  }
  const bound = context.now.getTime() - FAILED_RETENTION_MS;
  const failed: CollectionJob[] = [];
  for (const job of newest.values()) {
    if (job.state !== 'failed' || job.retriedBy || job.dismissedAt) continue;
    if (!job.finishedAt || new Date(job.finishedAt).getTime() < bound) continue;
    if (roleOf(job) === 'item' && job.source.id && await context.hasDocument(job.source.type, job.source.id)) continue;
    failed.push(job);
  }
  return failed.sort((left, right) => (right.finishedAt ?? '').localeCompare(left.finishedAt ?? ''));
}

function entryOf(job: CollectionJob, role: JobRole, status: WorkStatus | null): JobOverviewEntry {
  return {
    jobId: job.id,
    type: job.source.type,
    role,
    title: role === 'add' ? job.source.title ?? job.checkpoint?.subscribing?.title ?? null : job.source.title || null,
    url: job.source.url,
    publisher: role === 'item' ? job.source.publisher ?? null : null,
    progress: role === 'check' && job.progress ? { done: job.progress.done, total: job.progress.total } : null,
    status,
    error: job.state === 'failed' ? job.error : null,
    failedAt: job.state === 'failed' ? job.finishedAt : null,
  };
}

function earliest<T>(values: T[], at: (value: T) => string): T | null {
  return values.reduce<T | null>((best, value) => best === null || at(value) < at(best) ? value : best, null);
}

function roleOf(job: CollectionJob): JobRole | undefined {
  return jobRole(job.kind)?.role;
}

function targetKey(job: CollectionJob, role: JobRole): string {
  return role === 'item' ? `${job.source.type}:item:${job.source.id}` : `${job.source.type}:add:${job.source.url.toLowerCase()}`;
}
