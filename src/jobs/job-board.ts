import { assertNever, jobKey, roleView, type RoleView } from '../core/job-role.js';
import type { SourceDeclarations } from '../core/source-registry.js';
import type { JobOverview, JobOverviewEntry, JobView } from '../core/job-types.js';
import type { WorkStatus } from '../core/subscription-types.js';

/** How long a failed single item or subscription request stays in the failed section. */
export const FAILED_RETENTION_MS = 7 * 86_400_000;

/** What the jobs page needs to know about work beyond the jobs themselves. */
export interface JobBoardContext {
  /** The source types whose job kinds the board reads. */
  sources: SourceDeclarations;
  now: Date;
  /** Where a job that has not started stands in its queue; smaller starts earlier. Unknown for jobs not in a queue. */
  queuePosition(job: JobView): number | undefined;
  /** Whether an item of this type and key already has a document. */
  hasDocument(type: string, key: string): Promise<boolean>;
}

/**
 * What a queued or running top-level job is doing. A job that has not started is queued, also
 * while its source cools down; once started it never is again. A started job retries while its own
 * step waits for a retry or a cooldown, and a check also while every item it still collects does;
 * otherwise a check is downloading once it knows items to collect and checking before.
 */
export function workStatus(sources: SourceDeclarations, job: JobView): WorkStatus {
  if (!job.startedAt) return { state: 'queued' };
  const own = retryOf(job);
  if (own) return own;
  const unfinished = (job.items ?? []).filter((item) => item.state === 'queued' || item.state === 'running');
  const items = unfinished.map(retryOf);
  if (items.length > 0 && items.every((item) => item !== null)) return earliest(items, (item) => item.at)!;
  const view = roleView(sources, job);
  if (view === null) return { state: 'downloading' };
  switch (view.role) {
    case 'check': return view.progress?.total ? { state: 'downloading' } : { state: 'checking' };
    case 'add': return { state: 'checking' };
    case 'item': return { state: 'downloading' };
    default: return assertNever(view);
  }
}

/** The retry a job or a check's item waits for: the cooldown's end, or its next attempt. */
function retryOf(work: Pick<JobView, 'wait' | 'retry'>): Extract<WorkStatus, { state: 'retrying' }> | null {
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
export async function jobOverview(jobs: readonly JobView[], context: JobBoardContext): Promise<JobOverview> {
  const running: JobOverviewEntry[] = [];
  const queued: Array<{ entry: JobOverviewEntry; position: number }> = [];
  for (const job of jobs) {
    const view = roleView(context.sources, job);
    if (!view || job.parentId !== null || (job.state !== 'queued' && job.state !== 'running')) continue;
    const status = workStatus(context.sources, job);
    const entry = entryOf(job, view, status);
    if (status.state === 'queued') queued.push({ entry, position: context.queuePosition(job) ?? Number.MAX_SAFE_INTEGER });
    else running.push(entry);
  }
  queued.sort((left, right) => left.position - right.position);
  return {
    running,
    queued: queued.map(({ entry }) => entry),
    failed: (await failedJobs(jobs, context)).map((job) => entryOf(job, roleView(context.sources, job)!, null)),
  };
}

/**
 * Failed single items and subscription requests the failed section lists, newest first: not
 * retried, not removed, younger than the retention, newer than every other job of the same target,
 * and, for an item, without a document of the same type and key.
 */
export async function failedJobs(jobs: readonly JobView[], context: Pick<JobBoardContext, 'sources' | 'now' | 'hasDocument'>): Promise<JobView[]> {
  const newest = new Map<string, JobView>();
  for (const job of jobs) {
    const role = roleView(context.sources, job)?.role;
    if (job.parentId !== null || (role !== 'item' && role !== 'add')) continue;
    const key = jobKey(context.sources, job);
    const current = newest.get(key);
    if (!current || job.createdAt > current.createdAt) newest.set(key, job);
  }
  const bound = context.now.getTime() - FAILED_RETENTION_MS;
  const failed: JobView[] = [];
  for (const job of newest.values()) {
    if (job.state !== 'failed' || job.retriedBy || job.dismissedAt) continue;
    if (!job.finishedAt || new Date(job.finishedAt).getTime() < bound) continue;
    const view = roleView(context.sources, job);
    if (view?.role === 'item' && view.key && await context.hasDocument(view.type, view.key)) continue;
    failed.push(job);
  }
  return failed.sort((left, right) => (right.finishedAt ?? '').localeCompare(left.finishedAt ?? ''));
}

function entryOf(job: JobView, view: RoleView, status: WorkStatus | null): JobOverviewEntry {
  return {
    jobId: job.id,
    type: view.type,
    role: view.role,
    title: job.source.title || null,
    url: job.source.url,
    publisher: view.role === 'item' ? view.publisher : null,
    progress: view.role === 'check' && view.progress ? { done: view.progress.done, total: view.progress.total } : null,
    status,
    error: job.state === 'failed' ? job.error : null,
    failedAt: job.state === 'failed' ? job.finishedAt : null,
  };
}

function earliest<T>(values: T[], at: (value: T) => string): T | null {
  return values.reduce<T | null>((best, value) => best === null || at(value) < at(best) ? value : best, null);
}
