import { jobKey, roleOf } from '../../shared/jobs/job-role.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import type { SubscriptionTarget } from '../../shared/sources/source-contract.js';
import type { CollectionJob, JobError, JobItem, JobRecovery, JobResult, JobStopKind, SkipReason } from '../../shared/jobs/job-types.js';
import { ACTIVE, progressOf, settledItem } from './check-items.js';

export const MAX_UNCLEAN_STOPS = 3;

export const INTERRUPTED_REPEATEDLY = 'interrupted_repeatedly';

export type InterruptedJob = CollectionJob & { state: 'interrupted'; recovery: JobRecovery };

function isInterrupted(job: CollectionJob): job is InterruptedJob {
  return job.state === 'interrupted' && job.recovery !== undefined;
}

export interface RecoveryHost {
  sources: SourceDeclarations;
  stored(): CollectionJob[];
  storedJob(id: string): CollectionJob | undefined;
  runs(type: string): boolean;
  itemName(type: string): string;
  stopped(type: string, id: string): Promise<SkipReason | null>;
  settle(job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null): void;
  updateStored(job: CollectionJob, patch: Partial<CollectionJob>): void;
  restore(job: InterruptedJob, options?: { queue: boolean }): CollectionJob;
  subscribeResolved(job: CollectionJob, target: SubscriptionTarget): Promise<void>;
  watchItems(checkId: string): void;
}

export async function resumeInterrupted(host: RecoveryHost): Promise<void> {
  const { sources } = host;
  const superseded: InterruptedJob[] = [];
  const pending: InterruptedJob[] = [];
  const seen = new Set<string>();
  const unknownTypes = new Set<string>();
  for (const job of host.stored()) {
    if (job.state === 'interrupted' && (!roleOf(sources, job) || !host.runs(job.source.type))) {
      unknownTypes.add(job.kind);
      continue;
    }
    const key = jobKey(sources, job);
    const later = seen.has(key);
    seen.add(key);
    if (isInterrupted(job)) (later ? superseded : pending).push(job);
  }
  for (const kind of unknownTypes) console.warn(`Interrupted ${kind} jobs are kept and not resumed: their source type is not available`);
  pending.reverse();
  const settled = new Set<string>();
  const settle = (job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null) => {
    settled.add(job.id);
    host.settle(job, state, result, error);
  };
  const skipCheck = (job: CollectionJob, reason: SkipReason) => {
    for (const child of pending) {
      if (child.parentId === job.id && !child.claimedByUser && !settled.has(child.id)) {
        settle(child, 'completed', { outcome: 'skipped', skipReason: reason }, null);
      }
    }
    if (job.items) {
      const items = job.items.map((item) => {
        const child = item.jobId ? host.storedJob(item.jobId) : undefined;
        if (child?.claimedByUser && child.state === 'interrupted') {
          return { ...item, state: 'completed' as const, outcome: 'skipped' as const, skipReason: reason, error: null };
        }
        return storedItem(host, job, item);
      });
      host.updateStored(job, { items, progress: progressOf(items) });
    }
    settle(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
  };
  const tooManyStops = (job: InterruptedJob) => job.recovery.uncleanStops >= MAX_UNCLEAN_STOPS;
  const repeated: JobError = { code: INTERRUPTED_REPEATEDLY, message: '工作多次在執行中被中斷，已停止自動接續。可重新提交。' };

  for (const job of superseded) {
    if (roleOf(sources, job) === 'check') skipCheck(job, 'superseded');
    else if (!settled.has(job.id)) settle(job, 'completed', { outcome: 'skipped', skipReason: 'superseded' }, null);
  }
  const checkJobs: CollectionJob[] = [];
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
  for (const job of checkJobs) host.watchItems(job.id);
}

export function resumedRecord(sources: SourceDeclarations, stored: InterruptedJob, timestamp: string): CollectionJob & { recovery: JobRecovery } {
  const waitsForItems = roleOf(sources, stored) === 'check' && stored.items !== null;
  return {
    ...stored,
    state: waitsForItems ? 'running' : 'queued',
    finishedAt: null,
    error: null,
    recovery: { ...stored.recovery, resumedCount: stored.recovery.resumedCount + 1, lastResumedAt: timestamp },
    updatedAt: timestamp,
  };
}

const RESUME_MESSAGES: Record<JobStopKind, string> = {
  shutdown: '服務正常關閉後重新啟動，接續收集工作。',
  crash: '服務異常結束後重新啟動，接續收集工作。',
  vault_switch: '回到這個知識庫，接續收集工作。',
};

export function resumeMessage(stopReason: JobStopKind): string {
  return RESUME_MESSAGES[stopReason];
}

export function storedItem(host: Pick<RecoveryHost, 'storedJob' | 'itemName'>, check: CollectionJob, item: JobItem): JobItem {
  const child = item.jobId ? host.storedJob(item.jobId) : undefined;
  if (child && child.state !== 'interrupted' && !ACTIVE.has(child.state)) return settledItem(item, child);
  if (!ACTIVE.has(item.state) && item.state !== 'interrupted') return item;
  return { ...item, state: 'failed', error: { code: 'interrupted', message: `找不到${host.itemName(check.source.type)}的收集紀錄。` } };
}
