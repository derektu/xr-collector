import type { CollectionJob, JobPhase, JobState, SkipReason } from '../core/types.js';
import { classifyYouTubeInput } from '../sources/youtube/url.js';
import { channelJobLabel } from './subscription-presentation.js';

export interface SubmitAction {
  label: string;
  enabled: boolean;
  /** Why the input cannot be submitted; empty input has no reason. */
  reason: string | null;
}

export interface YouTubeSubmitAction extends SubmitAction {
  /** A channel address opens the subscription confirmation; a video address is collected at once. */
  kind: 'video' | 'channel' | null;
}

/** The submit button follows the syntax of what was pasted, before anything is sent. */
export function youtubeSubmitAction(input: string): YouTubeSubmitAction {
  if (input.trim() === '') return { label: '加入', enabled: false, reason: null, kind: null };
  try {
    const kind = classifyYouTubeInput(input).kind;
    return { label: kind === 'video' ? '收集影片' : '訂閱頻道', enabled: true, reason: null, kind };
  } catch (error) {
    return { label: '加入', enabled: false, reason: error instanceof Error ? error.message : '無法辨識這個網址。', kind: null };
  }
}

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

export function jobStateLabel(job: CollectionJob): string {
  return STATE_LABELS[job.state];
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
};

export function skipReasonLabel(reason: SkipReason | undefined): string {
  return reason ? SKIP_LABELS[reason] : '略過';
}

/** What the finished job left behind, with saving and indexing stated separately. */
export function jobResultLabel(job: CollectionJob): string | null {
  if (job.state === 'failed' || job.state === 'interrupted') return job.error?.message ?? null;
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

export function hasActiveJobs(jobs: CollectionJob[]): boolean {
  return jobs.some((job) => job.state === 'queued' || job.state === 'running');
}
