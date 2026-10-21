import { jobRole } from '../core/source-registry.js';
import type { CollectionJob, JobOverview, JobOverviewEntry, JobRole } from '../core/types.js';

/** How long a failed single item or subscription request stays in the failed section. */
export const FAILED_RETENTION_MS = 7 * 86_400_000;

/** What the jobs page needs to know about work beyond the jobs themselves. */
export interface JobBoardContext {
  now: Date;
  /** Where a queued job stands in its queue; smaller starts earlier. Unknown for jobs not in a queue. */
  queuePosition(job: CollectionJob): number | undefined;
  /** Whether an item of this type and key already has a document. */
  hasDocument(type: string, key: string): Promise<boolean>;
}

/**
 * A running check job that is not collecting anything itself: its own step waits for a cooldown
 * or a retry, none of its unfinished items is running, or every unfinished item waits.
 */
export function waitsForTurn(job: CollectionJob): boolean {
  if (job.wait || job.retry?.nextAttemptAt) return true;
  const unfinished = (job.items ?? []).filter((item) => item.state === 'queued' || item.state === 'running');
  if (unfinished.length === 0) return false;
  return unfinished.every((item) => item.state === 'queued' || item.wait || item.retry?.nextAttemptAt);
}

/**
 * The jobs page from the Vault's top-level jobs, live ones with their items' current state. A check
 * runs while it lists its subscription or one of its items is collecting, and is queued otherwise;
 * other work runs while its step runs and is not waiting. Only the newest job of each target counts
 * for the failed section.
 */
export async function jobOverview(jobs: readonly CollectionJob[], context: JobBoardContext): Promise<JobOverview> {
  const running: JobOverviewEntry[] = [];
  const ready: Array<{ entry: JobOverviewEntry; position: number }> = [];
  const waiting: Array<{ entry: JobOverviewEntry; at: string }> = [];
  for (const job of jobs) {
    const role = roleOf(job);
    if (!role || job.parentId !== null || (job.state !== 'queued' && job.state !== 'running')) continue;
    const entry = entryOf(job, role);
    const isRunning = role === 'check'
      ? job.state === 'running' && !waitsForTurn(job)
      : job.state === 'running' && !job.wait;
    if (isRunning) running.push(entry);
    else if (entry.wait || entry.retry) waiting.push({ entry, at: entry.wait?.until ?? entry.retry!.nextAttemptAt });
    else ready.push({ entry, position: positionOf(job, context) });
  }
  ready.sort((left, right) => left.position - right.position);
  waiting.sort((left, right) => left.at.localeCompare(right.at));
  return {
    running,
    queued: [...ready.map(({ entry }) => entry), ...waiting.map(({ entry }) => entry)],
    failed: (await failedJobs(jobs, context)).map((job) => entryOf(job, roleOf(job)!)),
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

function entryOf(job: CollectionJob, role: JobRole): JobOverviewEntry {
  const unfinished = (job.items ?? []).filter((item) => item.state === 'queued' || item.state === 'running');
  // A check whose remaining items all wait shows the wait that ends first.
  const itemWaits = unfinished.length > 0 && unfinished.every((item) => item.wait || item.retry?.nextAttemptAt);
  const wait = job.wait ?? (itemWaits ? earliest(unfinished.flatMap((item) => item.wait ? [item.wait] : []), (value) => value.until) : null);
  const retrySource = job.retry?.nextAttemptAt ? job.retry
    : itemWaits && !wait ? earliest(unfinished.flatMap((item) => item.retry?.nextAttemptAt ? [item.retry] : []), (value) => value.nextAttemptAt!) : null;
  return {
    jobId: job.id,
    type: job.source.type,
    role,
    title: role === 'add' ? job.source.title ?? job.checkpoint?.subscribing?.title ?? null : job.source.title || null,
    url: job.source.url,
    publisher: role === 'item' ? job.source.publisher ?? null : null,
    progress: role === 'check' && job.progress ? { done: job.progress.done, total: job.progress.total } : null,
    wait: wait ?? null,
    retry: retrySource?.nextAttemptAt ? { nextAttemptAt: retrySource.nextAttemptAt, lastError: retrySource.lastError } : null,
    error: job.state === 'failed' ? job.error : null,
    failedAt: job.state === 'failed' ? job.finishedAt : null,
  };
}

function positionOf(job: CollectionJob, context: JobBoardContext): number {
  const own = context.queuePosition(job);
  if (own !== undefined) return own;
  return Number.MAX_SAFE_INTEGER;
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
