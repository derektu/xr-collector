import { roleOf } from '../../shared/jobs/job-role.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import type { CollectionJob, JobError, JobRecovery, JobResult, JobStopKind, SkipReason } from '../../shared/jobs/job-types.js';

export const MAX_UNCLEAN_STOPS = 3;

export const INTERRUPTED_REPEATEDLY = 'interrupted_repeatedly';

export type InterruptedJob = CollectionJob & { state: 'interrupted'; recovery: JobRecovery };

function isInterrupted(job: CollectionJob): job is InterruptedJob {
  return job.state === 'interrupted' && job.recovery !== undefined;
}

export interface RecoveryHost {
  sources: SourceDeclarations;
  stored(): CollectionJob[];
  runs(type: string): boolean;
  stopped(type: string, id: string): Promise<SkipReason | null>;
  settle(job: CollectionJob, state: 'completed' | 'failed', result: JobResult, error: JobError | null): void;
  restore(job: InterruptedJob): void;
}

export async function resumeInterrupted(host: RecoveryHost): Promise<void> {
  const { sources } = host;
  const pending: InterruptedJob[] = [];
  const unknownTypes = new Set<string>();
  for (const job of host.stored()) {
    if (!isInterrupted(job)) continue;
    if (!roleOf(sources, job) || !host.runs(job.source.type)) unknownTypes.add(job.kind);
    else pending.push(job);
  }
  for (const kind of unknownTypes) console.warn(`Interrupted ${kind} jobs are kept and not resumed: their source type is not available`);
  pending.reverse().sort(byCreatedAtAscending);
  const repeated: JobError = { code: INTERRUPTED_REPEATEDLY, message: '工作多次在執行中被中斷，已停止自動接續。可重新提交。' };
  const skipped = new Set<string>();
  for (const job of pending) {
    if (roleOf(sources, job) !== 'check') continue;
    const reason = await host.stopped(job.source.type, job.source.id!);
    if (!reason) continue;
    for (const child of pending) {
      if (child.parentId !== job.id) continue;
      skipped.add(child.id);
      host.settle(child, 'completed', { outcome: 'skipped', skipReason: reason }, null);
    }
    skipped.add(job.id);
    host.settle(job, 'completed', { outcome: 'skipped', skipReason: reason }, null);
  }
  for (const job of pending) {
    if (skipped.has(job.id)) continue;
    if (job.recovery.uncleanStops >= MAX_UNCLEAN_STOPS) host.settle(job, 'failed', { outcome: 'failed' }, repeated);
    else host.restore(job);
  }
}

function byCreatedAtAscending(a: CollectionJob, b: CollectionJob): number {
  return a.createdAt.localeCompare(b.createdAt);
}

export function resumedRecord(sources: SourceDeclarations, stored: InterruptedJob, timestamp: string): CollectionJob & { recovery: JobRecovery } {
  const startsOver = roleOf(sources, stored) !== 'item';
  return {
    ...stored,
    state: 'queued',
    finishedAt: null,
    error: null,
    ...(startsOver ? { phase: null, items: null, progress: null } : {}),
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
