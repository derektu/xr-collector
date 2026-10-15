import type { CollectionJob, JobItem, JobPhase, JobRetry, JobState, SkipReason } from '../core/types.js';
import { channelJobLabel } from './subscription-presentation.js';

const STATE_LABELS: Record<JobState, string> = {
  queued: '排隊中', running: '執行中', completed: '完成', failed: '失敗', interrupted: '已中斷',
};
const PHASE_LABELS: Record<JobPhase, string> = {
  resolve: '解析頻道', discover: '尋找影片', capture: '擷取字幕', save: '保存文件', index: '更新搜尋',
};

export function jobKindLabel(job: CollectionJob): string {
  if (job.kind === 'youtube.video') return '影片';
  if (job.kind === 'youtube.channel') return channelJobLabel(job);
  return '訂閱頻道';
}

export function jobStateLabel(job: Pick<CollectionJob, 'state' | 'retry'>): string {
  if (job.state === 'queued' && job.retry?.nextAttemptAt) return '等待重試';
  return STATE_LABELS[job.state];
}

/** The state of one video in a channel job. */
export function jobItemLabel(item: JobItem): string {
  if (item.outcome === 'created') return '新增';
  if (item.outcome === 'existing') return '已存在';
  if (item.outcome === 'skipped') return `略過・${skipReasonLabel(item.skipReason)}`;
  return jobStateLabel(item);
}

function clockTime(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Why a job waits and when it tries again: "無法連線…・14:02 自動重試（第 2／3 次）". */
export function retryLabel(retry: JobRetry | null | undefined): string | null {
  if (!retry?.nextAttemptAt) return null;
  return `${retry.lastError.message}・${clockTime(retry.nextAttemptAt)} 自動重試（第 ${retry.attempts + 1}／${retry.maxAttempts} 次）`;
}

/** Whether the job continued after the service restarted. */
export function recoveryLabel(job: Pick<CollectionJob, 'state' | 'recovery'>): string | null {
  if (!job.recovery || job.recovery.resumedCount === 0) return null;
  return job.state === 'queued' || job.state === 'running' ? '服務重新啟動後已接續' : '曾中斷後接續';
}

/** The step a running job is in; channel jobs past discovery are waiting for their videos. */
export function jobPhaseLabel(job: CollectionJob): string | null {
  if (job.state !== 'running' || !job.phase) return null;
  if (job.kind === 'youtube.channel' && job.phase === 'capture') return '收集影片';
  return PHASE_LABELS[job.phase];
}

export function jobTitle(job: CollectionJob): string {
  return job.source.title ?? job.source.url;
}

export function jobProgressLabel(job: CollectionJob): string | null {
  const progress = job.progress;
  if (!progress) return null;
  const skipped = progress.skipped ? `・略過 ${progress.skipped}` : '';
  return `已處理 ${progress.done} / ${progress.total}（新增 ${progress.created}・已存在 ${progress.existing}${skipped}・失敗 ${progress.failed}）`;
}

const SKIP_LABELS: Record<SkipReason, string> = {
  out_of_range: '超出補收範圍', subscription_paused: '訂閱已暫停', subscription_removed: '訂閱已移除',
  superseded: '已由較新的工作接續',
};

export function skipReasonLabel(reason: SkipReason | undefined): string {
  return reason ? SKIP_LABELS[reason] : '略過';
}

/** What the finished job left behind, with saving and indexing stated separately. */
export function jobResultLabel(job: CollectionJob): string | null {
  if (job.state === 'interrupted') return '已中斷，重新開啟時接續';
  if (job.state === 'failed') return job.error?.message ?? null;
  if (job.state !== 'completed' || !job.result) return null;
  const { result } = job;
  if (job.kind === 'youtube.video') {
    if (result.outcome === 'skipped') return `略過：${skipReasonLabel(result.skipReason)}`;
    const stored = result.outcome === 'created' ? '文件已保存' : '文件已存在';
    return result.indexed ? `${stored}・已更新搜尋` : `${stored}，搜尋更新失敗`;
  }
  if (job.kind === 'youtube.channel-add') {
    return result.outcome === 'created' ? '已訂閱，開始首次收集' : '這個頻道已在訂閱清單中';
  }
  if (result.outcome === 'skipped') return `略過：${skipReasonLabel(result.skipReason)}`;
  if (result.outcome === 'empty') return '沒有新影片';
  if (result.outcome === 'partial') return '部分影片收集失敗';
  return result.outcome === 'created' ? '收集完成' : '沒有新影片';
}
