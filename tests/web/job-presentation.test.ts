import { describe, expect, it } from 'vitest';
import type { CollectionJob } from '../../src/core/types.js';
import { jobPhaseLabel, jobProgressLabel, jobResultLabel } from '../../src/web/job-presentation.js';

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
});
