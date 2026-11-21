import { assertNever, jobKey, roleView, type RoleView } from '../../shared/jobs/job-role.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import type { JobOverview, JobOverviewEntry, JobView } from '../../shared/jobs/job-types.js';
import type { WorkStatus } from '../../shared/subscriptions/subscription-types.js';

export const FAILED_RETENTION_MS = 7 * 86_400_000;

export interface JobBoardContext {
  sources: SourceDeclarations;
  now: Date;
  queueJoinOrder(job: JobView): number | undefined;
  hasDocument(type: string, key: string): Promise<boolean>;
}

export function workStatus(sources: SourceDeclarations, job: JobView): WorkStatus {
  if (!job.startedAt) return { state: 'queued' };
  const own = retryOf(job);
  if (own) return own;
  const unfinished = (job.items ?? []).filter((item) => item.state === 'queued' || item.state === 'running');
  const retries = unfinished.map(retryOf).filter((retry) => retry !== null);
  if (retries.length === unfinished.length && isNonEmpty(retries)) return earliest(retries, (retry) => retry.at);
  const view = roleView(sources, job);
  if (view === null) return { state: 'downloading' };
  switch (view.role) {
    case 'check': return view.progress?.total ? { state: 'downloading' } : { state: 'checking' };
    case 'add': return { state: 'checking' };
    case 'item': return { state: 'downloading' };
    default: return assertNever(view);
  }
}

function retryOf(work: Pick<JobView, 'wait' | 'retry'>): Extract<WorkStatus, { state: 'retrying' }> | null {
  if (work.wait) return { state: 'retrying', at: work.wait.until, cause: { reason: 'rate_limited' } };
  if (!work.retry?.nextAttemptAt) return null;
  const { attempts, maxAttempts, nextAttemptAt, lastError } = work.retry;
  return { state: 'retrying', at: nextAttemptAt, cause: { reason: 'failed', error: lastError, attempt: attempts + 1, maxAttempts } };
}

export async function jobOverview(jobs: readonly JobView[], context: JobBoardContext): Promise<JobOverview> {
  const running: JobOverviewEntry[] = [];
  const queued: Array<{ entry: JobOverviewEntry; position: number }> = [];
  for (const job of jobs) {
    const view = roleView(context.sources, job);
    if (!view || job.parentId !== null || (job.state !== 'queued' && job.state !== 'running')) continue;
    const status = workStatus(context.sources, job);
    const entry = entryOf(job, view, status);
    if (status.state === 'queued') queued.push({ entry, position: context.queueJoinOrder(job) ?? Number.MAX_SAFE_INTEGER });
    else running.push(entry);
  }
  queued.sort((left, right) => left.position - right.position);
  return {
    running,
    queued: queued.map(({ entry }) => entry),
    failed: (await failedJobs(jobs, context)).map((job) => entryOf(job, roleView(context.sources, job)!, null)),
  };
}

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

type NonEmpty<T> = [T, ...T[]];

function isNonEmpty<T>(values: T[]): values is NonEmpty<T> {
  return values.length > 0;
}

function earliest<T>([first, ...rest]: NonEmpty<T>, at: (value: T) => string): T {
  return rest.reduce((best, value) => at(value) < at(best) ? value : best, first);
}
