import { jobKey, roleOf } from '../core/job-role.js';
import type { SourceDeclarations } from '../core/source-registry.js';
import type { SubscriptionTarget } from '../core/source-contract.js';
import type { CollectionJob, JobError, JobItem, JobResult, SkipReason } from '../core/job-types.js';
import { ACTIVE, progressOf, settledItem } from './check-items.js';

/**
 * Restarts that may find a job in the middle of a step before it stops resuming. A job that keeps
 * crashing the service would otherwise be resumed into the same crash on every start.
 */
export const MAX_UNCLEAN_STOPS = 3;

/** The error of a job that stopped resuming after MAX_UNCLEAN_STOPS. */
export const INTERRUPTED_REPEATEDLY = 'interrupted_repeatedly';

/** What resuming a Vault's interrupted jobs reads from and does through its job manager. */
export interface RecoveryHost {
  sources: SourceDeclarations;
  /** The Vault's stored jobs, newest first. */
  stored(): CollectionJob[];
  /** A stored job by ID. */
  storedJob(id: string): CollectionJob | undefined;
  /** Whether this process runs jobs of the source type. */
  runs(type: string): boolean;
  /** How the source type names one item, for an item whose collection record is missing. */
  itemName(type: string): string;
  /** Null while the subscription exists and is enabled; otherwise why its work stops. */
  stopped(type: string, id: string): Promise<SkipReason | null>;
  /** Ends an interrupted job with this outcome. */
  settle(job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null): void;
  /** Changes a job that is not running. */
  updateStored(job: CollectionJob, patch: Partial<CollectionJob>): void;
  /** Makes the job active again and, unless `queue` is false, returns it to its line or its retry wait. */
  restore(job: CollectionJob, options?: { queue: boolean }): CollectionJob;
  /** Hands a subscription request's target to the subscriptions, as a request that just resolved does. */
  subscribeResolved(job: CollectionJob, target: SubscriptionTarget): Promise<void>;
  /** A restored check past discovery waits for its restored items again, or ends when none is left. */
  watchItems(checkId: string): void;
}

/**
 * Continues the Vault's interrupted jobs. Each job keeps its trigger, finished items, saved
 * documents and failed attempts; a check job that had not recorded its items discovers them as any
 * check starting now would. A job that a later job of the same item or subscription took over, a
 * check job whose subscription was paused or removed, and a job that kept stopping the service in
 * mid-step end instead. A job of a source type this process does not run stays interrupted,
 * untouched. Subscription work is restored before items, in the order the jobs were accepted, so
 * items follow their subscription's state and the queue keeps its order.
 */
export async function resumeInterrupted(host: RecoveryHost): Promise<void> {
  const { sources } = host;
  const superseded: CollectionJob[] = [];
  const pending: CollectionJob[] = [];
  const seen = new Set<string>();
  const unknownTypes = new Set<string>();
  // The list is newest first, so a job whose key was already seen has a later job of the same target.
  for (const job of host.stored()) {
    if (job.state === 'interrupted' && (!roleOf(sources, job) || !host.runs(job.source.type))) {
      unknownTypes.add(job.kind);
      continue;
    }
    const key = jobKey(sources, job);
    const later = seen.has(key);
    seen.add(key);
    if (job.state === 'interrupted') (later ? superseded : pending).push(job);
  }
  for (const kind of unknownTypes) console.warn(`Interrupted ${kind} jobs are kept and not resumed: their source type is not available`);
  pending.reverse();
  const settled = new Set<string>();
  const settle = (job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null) => {
    settled.add(job.id);
    host.settle(job, state, result, error);
  };
  /** Ends a check job and the items it queued, except items the user also submitted. */
  const skipCheck = (job: CollectionJob, reason: SkipReason) => {
    for (const child of pending) {
      if (child.parentId === job.id && !child.claimedByUser && !settled.has(child.id)) {
        settle(child, 'completed', { outcome: 'skipped', skipReason: reason }, null);
      }
    }
    if (job.items) {
      const items = job.items.map((item) => {
        const child = item.jobId ? host.storedJob(item.jobId) : undefined;
        // An item the user also submitted continues as the user's own job.
        if (child?.claimedByUser && child.state === 'interrupted') {
          return { ...item, state: 'completed' as const, outcome: 'skipped' as const, skipReason: reason, error: null };
        }
        return storedItem(host, job, item);
      });
      host.updateStored(job, { items, progress: progressOf(items) });
    }
    settle(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
  };
  const tooManyStops = (job: CollectionJob) => (job.recovery?.uncleanStops ?? 0) >= MAX_UNCLEAN_STOPS;
  const repeated: JobError = { code: INTERRUPTED_REPEATEDLY, message: '工作多次在執行中被中斷，已停止自動接續。可重新提交。' };

  for (const job of superseded) {
    if (roleOf(sources, job) === 'check') skipCheck(job, 'superseded');
    else if (!settled.has(job.id)) settle(job, 'completed', { outcome: 'skipped', skipReason: 'superseded' }, null);
  }
  const checkJobs: CollectionJob[] = [];
  // Subscription work first, so its items follow the subscription's state.
  for (const job of pending) {
    const role = roleOf(sources, job);
    if (role === 'item' || settled.has(job.id)) continue;
    if (tooManyStops(job)) {
      settle(job, 'failed', { outcome: 'failed' }, repeated);
      continue;
    }
    if (role === 'check') {
      const reason = await host.stopped(job.source.type, job.source.id!);
      if (reason) {
        skipCheck(job, reason);
        continue;
      }
      checkJobs.push(job);
    }
    const subscribing = role === 'add' ? job.checkpoint?.subscribing : undefined;
    if (subscribing && await host.stopped(job.source.type, subscribing.subscriptionId) !== 'subscription_removed') {
      // The subscription was written before the stop; its first check is dispatched now, before the
      // scheduler can start a check of the same subscription, so that check joins it.
      const restored = host.restore(job, { queue: false });
      await host.subscribeResolved(restored, { id: subscribing.subscriptionId, title: subscribing.title, url: subscribing.url });
      continue;
    }
    host.restore(job);
  }
  for (const job of pending) {
    if (roleOf(sources, job) !== 'item' || settled.has(job.id)) continue;
    if (tooManyStops(job)) settle(job, 'failed', { outcome: 'failed' }, repeated);
    else host.restore(job);
  }
  // Check jobs past discovery wait for their items again.
  for (const job of checkJobs) host.watchItems(job.id);
}

/**
 * A stored job made active again: queued, or running while a check past discovery waits for its
 * items, with its resume counted.
 */
export function resumedRecord(sources: SourceDeclarations, stored: CollectionJob, timestamp: string): CollectionJob {
  const waitsForItems = roleOf(sources, stored) === 'check' && stored.items !== null;
  return {
    ...stored,
    state: waitsForItems ? 'running' : 'queued',
    finishedAt: null,
    error: null,
    recovery: {
      ...stored.recovery,
      resumedCount: (stored.recovery?.resumedCount ?? 0) + 1,
      uncleanStops: stored.recovery?.uncleanStops ?? 0,
      lastInterruptedAt: stored.recovery?.lastInterruptedAt ?? stored.updatedAt,
      lastResumedAt: timestamp,
    },
    updatedAt: timestamp,
  };
}

/** What a resumed job's activity entry says, by how the service stopped. */
export function resumeMessage(stopReason: string): string {
  return stopReason === 'shutdown' ? '服務正常關閉後重新啟動，接續收集工作。'
    : stopReason === 'crash' ? '服務異常結束後重新啟動，接續收集工作。'
      : stopReason === 'vault_switch' ? '回到這個知識庫，接續收集工作。' : '服務重新啟動後接續收集工作。';
}

/** An item of a check job whose item job is not running here, as that job's record says it ended. */
export function storedItem(host: Pick<RecoveryHost, 'storedJob' | 'itemName'>, check: CollectionJob, item: JobItem): JobItem {
  const child = item.jobId ? host.storedJob(item.jobId) : undefined;
  if (child && child.state !== 'interrupted' && !ACTIVE.has(child.state)) return settledItem(item, child);
  if (!ACTIVE.has(item.state) && item.state !== 'interrupted') return item;
  return { ...item, state: 'failed', error: { code: 'interrupted', message: `找不到${host.itemName(check.source.type)}的收集紀錄。` } };
}
