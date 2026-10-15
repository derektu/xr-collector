import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionJob } from '../../src/core/types.js';
import {
  jobItemLabel,
  jobKindLabel,
  jobPhaseLabel,
  jobProgressLabel,
  jobResultLabel,
  jobStateLabel,
  recoveryLabel,
  retryLabel,
} from '../../src/web/job-presentation.js';

const originalZone = process.env.TZ;
beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
afterEach(() => { process.env.TZ = originalZone; });

function job(overrides: Partial<CollectionJob>): CollectionJob {
  return {
    id: 'job-1', kind: 'youtube.video', state: 'completed', phase: 'index', vaultPath: '/vault', parentId: null,
    source: { type: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: '影片' },
    createdAt: '2026-10-15T00:00:00.000Z', startedAt: null, finishedAt: null, updatedAt: '2026-10-15T00:00:00.000Z',
    progress: null, items: null, result: null, error: null, ...overrides,
  };
}

describe('job presentation', () => {
  it('states saving and indexing separately for a video', () => {
    expect(jobResultLabel(job({ result: { outcome: 'created', saved: true, indexed: true } }))).toBe('文件已保存・已更新搜尋');
    expect(jobResultLabel(job({ result: { outcome: 'created', saved: true, indexed: false } }))).toBe('文件已保存，搜尋更新失敗');
    expect(jobResultLabel(job({ result: { outcome: 'existing', saved: true, indexed: true } }))).toBe('文件已存在・已更新搜尋');
  });

  it('describes channel progress and failures', () => {
    const channel = job({
      kind: 'youtube.channel', state: 'running', phase: 'capture',
      progress: { total: 10, done: 3, created: 2, existing: 0, failed: 1 },
    });
    expect(jobPhaseLabel(channel)).toBe('收集影片');
    expect(jobProgressLabel(channel)).toBe('已處理 3 / 10（新增 2・已存在 0・失敗 1）');
    expect(jobResultLabel(job({ state: 'failed', error: { code: 'no_subtitles', message: '這支影片沒有字幕。' } }))).toBe('這支影片沒有字幕。');
    expect(jobResultLabel(job({ kind: 'youtube.channel', result: { outcome: 'partial' } }))).toBe('部分影片收集失敗');
  });

  it('labels channel jobs by why they ran and states skipped work', () => {
    const scope = { mode: 'backfill' as const, windowStart: '2026-09-15T00:00:00.000Z', maxItems: 10, cursor: null };
    expect(jobKindLabel(job({ kind: 'youtube.channel', scope: { ...scope, trigger: 'subscribe' } }))).toBe('首次收集');
    expect(jobKindLabel(job({ kind: 'youtube.channel', scope: { ...scope, trigger: 'resume' } }))).toBe('恢復補收');
    expect(jobKindLabel(job({ kind: 'youtube.channel', scope: { ...scope, trigger: 'manual', mode: 'incremental' } }))).toBe('立即檢查');
    expect(jobKindLabel(job({ kind: 'youtube.channel' }))).toBe('頻道收集');
    expect(jobProgressLabel(job({ kind: 'youtube.channel', progress: { total: 3, done: 3, created: 1, existing: 0, failed: 0, skipped: 2 } })))
      .toBe('已處理 3 / 3（新增 1・已存在 0・略過 2・失敗 0）');
    expect(jobResultLabel(job({ kind: 'youtube.channel', result: { outcome: 'skipped', skipReason: 'subscription_paused' } }))).toBe('略過：訂閱已暫停');
    expect(jobResultLabel(job({ result: { outcome: 'skipped', skipReason: 'out_of_range' } }))).toBe('略過：超出補收範圍');
  });


  it('states retries, restarts and their outcome', () => {
    const lastError = { code: 'network_error', message: '無法連線到 YouTube，請稍後再試。' };
    const waiting = job({ state: 'queued', retry: { attempts: 1, maxAttempts: 3, nextAttemptAt: '2026-10-15T06:02:00.000Z', lastError } });
    expect(jobStateLabel(waiting)).toBe('等待重試');
    expect(retryLabel(waiting.retry)).toBe('無法連線到 YouTube，請稍後再試。・14:02 自動重試（第 2／3 次）');
    expect(retryLabel({ ...waiting.retry!, nextAttemptAt: null })).toBeNull();
    const recovery = { resumedCount: 1, uncleanStops: 0, lastInterruptedAt: '2026-10-15T06:00:00.000Z', lastResumedAt: '2026-10-15T06:01:00.000Z' };
    expect(recoveryLabel(job({ state: 'running', recovery }))).toBe('服務重新啟動後已接續');
    expect(recoveryLabel(job({ state: 'completed', recovery }))).toBe('曾中斷後接續');
    expect(recoveryLabel(job({ state: 'completed' }))).toBeNull();
    expect(jobResultLabel(job({ state: 'interrupted', error: { code: 'interrupted', message: '服務停止。' } }))).toBe('已中斷，重新開啟時接續');
    expect(jobItemLabel({ sourceId: 'a', title: 'a', url: 'u', jobId: 'j', state: 'queued', outcome: null, error: null, retry: waiting.retry! })).toBe('等待重試');
    expect(jobItemLabel({ sourceId: 'a', title: 'a', url: 'u', jobId: 'j', state: 'completed', outcome: 'skipped', skipReason: 'superseded', error: null }))
      .toBe('略過・已由較新的工作接續');
  });
});
