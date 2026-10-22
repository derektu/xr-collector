import type { JobView, JobPhase, SkipReason } from '../core/types.js';
import { jobRole, sourceDeclaration } from '../core/source-registry.js';
import type { SourcePluginDeclaration } from '../plugins/types.js';
import { channelJobLabel } from './subscription-presentation.js';

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

export function jobKindLabel(job: JobView): string {
  const role = jobRole(job.kind)?.role;
  if (role === 'item') return nounOf(job);
  if (role === 'check') return channelJobLabel(job);
  return `訂閱${targetOf(job)}`;
}

/** Whether the job continued after the service restarted. */
export function recoveryLabel(job: Pick<JobView, 'state' | 'recovery'>): string | null {
  if (!job.recovery || job.recovery.resumedCount === 0) return null;
  return job.state === 'queued' || job.state === 'running' ? '服務重新啟動後已接續' : '曾中斷後接續';
}

/** The step a running job is in; check jobs past discovery are waiting for their items. */
export function jobPhaseLabel(job: JobView): string | null {
  if (job.state !== 'running' || !job.phase) return null;
  if (jobRole(job.kind)?.role === 'check' && job.phase === 'capture') return `收集${nounOf(job)}`;
  return phaseLabel(job, job.phase);
}

export function jobTitle(job: JobView): string {
  return job.source.title ?? job.source.url;
}

export function jobProgressLabel(job: JobView): string | null {
  const progress = job.progress;
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

/** What the finished job left behind, with saving and indexing stated separately. */
export function jobResultLabel(job: JobView): string | null {
  if (job.state === 'interrupted') return '已中斷，重新開啟時接續';
  if (job.state === 'failed') return job.error?.message ?? null;
  if (job.state !== 'completed' || !job.result) return null;
  const { result } = job;
  const role = jobRole(job.kind)?.role;
  if (role === 'item') {
    if (result.outcome === 'skipped') return `略過：${skipReasonLabel(result.skipReason)}`;
    const stored = result.outcome === 'created' ? '文件已保存' : '文件已存在';
    return result.indexed ? `${stored}・已更新搜尋` : `${stored}，搜尋更新失敗`;
  }
  if (role === 'add') {
    return result.outcome === 'created' ? '已訂閱，開始首次收集' : `這個${targetOf(job)}已在訂閱清單中`;
  }
  if (result.outcome === 'skipped') return `略過：${skipReasonLabel(result.skipReason)}`;
  if (result.outcome === 'empty') return `沒有新${nounOf(job)}`;
  if (result.outcome === 'partial') return `部分${nounOf(job)}收集失敗`;
  return result.outcome === 'created' ? '收集完成' : `沒有新${nounOf(job)}`;
}
