import type { CollectionJob, JobItem, JobProgress, JobState } from '../core/types.js';

/** States of a job that is not finished. */
export const ACTIVE: ReadonlySet<JobState> = new Set(['queued', 'running']);

/** A check job's item once the item job that collects it has finished. */
export function settledItem(item: JobItem, child: CollectionJob): JobItem {
  const { wait: _wait, ...rest } = item;
  return {
    ...rest,
    state: child.state,
    outcome: child.result?.outcome === 'created' || child.result?.outcome === 'existing' || child.result?.outcome === 'skipped'
      ? child.result.outcome : null,
    ...(child.result?.skipReason ? { skipReason: child.result.skipReason } : {}),
    error: child.error,
    ...(child.retry ? { retry: child.retry } : {}),
  };
}

/** A check job's progress over its items. */
export function progressOf(items: JobItem[]): JobProgress {
  const progress: JobProgress = { total: items.length, done: 0, created: 0, existing: 0, failed: 0, skipped: 0 };
  for (const item of items) {
    if (ACTIVE.has(item.state)) continue;
    progress.done += 1;
    if (item.state === 'completed' && item.outcome) progress[item.outcome] = (progress[item.outcome] ?? 0) + 1;
    else progress.failed += 1;
  }
  return progress;
}
