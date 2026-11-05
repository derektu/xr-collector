import type { ChannelJobTrigger, JobError, JobView, JobPhase, SkipReason } from '../core/types.js';
import { assertNever, roleOf, roleView } from '../core/job-role.js';
import { sourceDeclaration } from '../core/source-registry.js';
import type { SourcePluginDeclaration } from '../core/source-contract.js';
import { triggerLabel } from './subscription-presentation.js';

/** The declaration of a job's source type. */
function declarationOf(job: Pick<JobView, 'source'>): SourcePluginDeclaration | undefined {
  return sourceDeclaration(job.source.type);
}

function nounOf(job: Pick<JobView, 'source'>): string {
  return declarationOf(job)?.item.noun ?? '';
}

function targetOf(job: Pick<JobView, 'source'>): string {
  return declarationOf(job)?.subscription?.targetNoun ?? '';
}

/** The label of a step; the source type names the steps that depend on its items and targets. */
function phaseLabel(job: JobView, phase: JobPhase): string {
  const own = declarationOf(job)?.phaseLabels?.[phase];
  if (own) return own;
  switch (phase) {
    case 'resolve': return `解析${targetOf(job)}`;
    case 'discover': return `尋找${nounOf(job)}`;
    case 'capture': return `擷取${nounOf(job)}`;
    case 'save': return '保存文件';
    case 'index': return '更新搜尋';
  }
}

/** What a job is: one item, a check of a subscription and why it ran, or subscribing to an address (also a job of an unknown kind). */
export type JobKindView = { kind: 'item' } | { kind: 'check'; trigger: ChannelJobTrigger | null } | { kind: 'subscribe' };

export function jobKind(job: JobView): JobKindView {
  const view = roleView(job);
  if (view === null) return { kind: 'subscribe' };
  switch (view.role) {
    case 'item': return { kind: 'item' };
    case 'check': return { kind: 'check', trigger: view.trigger };
    case 'add': return { kind: 'subscribe' };
    default: return assertNever(view);
  }
}

export function jobKindLabel(job: JobView): string {
  const kind = jobKind(job);
  switch (kind.kind) {
    case 'item': return nounOf(job);
    case 'check': return triggerLabel(kind.trigger, job.source.type);
    case 'subscribe': return `訂閱${targetOf(job)}`;
  }
}

/** Whether the job continued after the service restarted: `continuing` while it is still unfinished, `continued` after. */
export function recovery(job: Pick<JobView, 'state' | 'recovery'>): 'continuing' | 'continued' | null {
  if (!job.recovery || job.recovery.resumedCount === 0) return null;
  return job.state === 'queued' || job.state === 'running' ? 'continuing' : 'continued';
}

export function recoveryLabel(job: Pick<JobView, 'state' | 'recovery'>): string | null {
  const state = recovery(job);
  if (state === null) return null;
  return state === 'continuing' ? '服務重新啟動後已接續' : '曾中斷後接續';
}

/** The step of a running job; `collect_items` is a check past discovery, waiting for its items. */
export type JobStep = JobPhase | 'collect_items';

export function jobStep(job: JobView): JobStep | null {
  if (job.state !== 'running' || !job.phase) return null;
  if (roleOf(job) === 'check' && job.phase === 'capture') return 'collect_items';
  return job.phase;
}

/** The step a running job is in. */
export function jobPhaseLabel(job: JobView): string | null {
  const step = jobStep(job);
  if (step === null) return null;
  return step === 'collect_items' ? `收集${nounOf(job)}` : phaseLabel(job, step);
}

export function jobTitle(job: JobView): string {
  return job.source.title ?? job.source.url;
}

/** A job's counts; `skipped` is null when nothing was skipped. */
export interface JobProgressView {
  done: number;
  total: number;
  created: number;
  existing: number;
  failed: number;
  skipped: number | null;
}

export function jobProgress(job: JobView): JobProgressView | null {
  const progress = job.progress;
  if (!progress) return null;
  const { done, total, created, existing, failed } = progress;
  return { done, total, created, existing, failed, skipped: progress.skipped || null };
}

export function jobProgressLabel(job: JobView): string | null {
  const progress = jobProgress(job);
  if (!progress) return null;
  const skipped = progress.skipped ? `・略過 ${progress.skipped}` : '';
  return `已處理 ${progress.done} / ${progress.total}（新增 ${progress.created}・已存在 ${progress.existing}${skipped}・失敗 ${progress.failed}）`;
}

const SKIP_LABELS: Record<SkipReason, string> = {
  out_of_range: '超出收集範圍', subscription_paused: '訂閱已暫停', subscription_removed: '訂閱已移除',
  superseded: '已由較新的工作接續', deleted: '文件已刪除',
};

export function skipReasonLabel(reason: SkipReason | undefined): string {
  return reason ? SKIP_LABELS[reason] : '略過';
}

/**
 * What a finished job left behind: an interruption, a failure with its error, skipped work, an
 * item's document (stored new or found existing) and whether search took it, a subscription
 * made or already there, or what a check collected.
 */
export type JobResultView =
  | { result: 'interrupted' }
  | { result: 'failed'; error: JobError | null }
  | { result: 'skipped'; reason: SkipReason | undefined }
  | { result: 'item'; stored: 'created' | 'existing'; indexed: boolean }
  | { result: 'subscribed' | 'already_subscribed' }
  | { result: 'collected' | 'partial' | 'nothing_new' };

export function jobResult(job: JobView): JobResultView | null {
  if (job.state === 'interrupted') return { result: 'interrupted' };
  if (job.state === 'failed') return { result: 'failed', error: job.error ?? null };
  if (job.state !== 'completed' || !job.result) return null;
  const { result } = job;
  const role = roleOf(job);
  if (role === 'item') {
    if (result.outcome === 'skipped') return { result: 'skipped', reason: result.skipReason };
    return { result: 'item', stored: result.outcome === 'created' ? 'created' : 'existing', indexed: Boolean(result.indexed) };
  }
  if (role === 'add') return { result: result.outcome === 'created' ? 'subscribed' : 'already_subscribed' };
  // A check, and a finished job of an unregistered type, which reads like one.
  if (result.outcome === 'skipped') return { result: 'skipped', reason: result.skipReason };
  if (result.outcome === 'partial') return { result: 'partial' };
  return { result: result.outcome === 'created' ? 'collected' : 'nothing_new' };
}

/** What the finished job left behind, with saving and indexing stated separately. */
export function jobResultLabel(job: JobView): string | null {
  const view = jobResult(job);
  if (view === null) return null;
  switch (view.result) {
    case 'interrupted': return '已中斷，重新開啟時接續';
    case 'failed': return view.error?.message ?? null;
    case 'skipped': return `略過：${skipReasonLabel(view.reason)}`;
    case 'item': {
      const stored = view.stored === 'created' ? '文件已保存' : '文件已存在';
      return view.indexed ? `${stored}・已更新搜尋` : `${stored}，搜尋更新失敗`;
    }
    case 'subscribed': return '已訂閱，開始首次收集';
    case 'already_subscribed': return `這個${targetOf(job)}已在訂閱清單中`;
    case 'partial': return `部分${nounOf(job)}收集失敗`;
    case 'collected': return '收集完成';
    case 'nothing_new': return `沒有新${nounOf(job)}`;
  }
}
