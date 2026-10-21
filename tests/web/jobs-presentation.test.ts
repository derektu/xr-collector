import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobOverviewEntry } from '../../src/core/types.js';
import { jobEntryLabel } from '../../src/web/jobs-presentation.js';

const entry = (overrides: Partial<JobOverviewEntry>): JobOverviewEntry => ({
  jobId: 'j', type: 'youtube', role: 'item', title: null, url: 'https://www.youtube.com/watch?v=dQ8vR2kLm4E', publisher: null,
  progress: null, wait: null, retry: null, error: null, failedAt: null, ...overrides,
});

describe('jobs page rows (N69-T11)', () => {
  const timeZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
  afterEach(() => { process.env.TZ = timeZone; });

  it('names a check, a subscription request and an item, with the address while the title is unknown', () => {
    expect(jobEntryLabel(entry({ role: 'check', title: 'All-In Podcast' }))).toMatchObject({ title: 'All-In Podcast', named: true, subtitle: '頻道・檢查' });
    expect(jobEntryLabel(entry({ role: 'add', url: 'https://www.youtube.com/@acquired' }))).toMatchObject({ title: 'youtube.com/@acquired', named: false, subtitle: '頻道・新增訂閱' });
    expect(jobEntryLabel(entry({}))).toMatchObject({ title: 'youtube.com/watch?v=dQ8vR2kLm4E', named: false, subtitle: null });
    expect(jobEntryLabel(entry({ title: 'Big Ideas 2026', publisher: 'ARK Invest' }))).toMatchObject({ title: 'Big Ideas 2026', subtitle: 'ARK Invest' });
  });

  it('draws every entry with its source type\'s icon, whatever the work is', () => {
    for (const role of ['check', 'add', 'item'] as const) expect(jobEntryLabel(entry({ role })).icon).toBe('youtube');
    expect(jobEntryLabel(entry({ type: 'unregistered', role: 'check', title: 'x' }))).toMatchObject({ icon: 'file', subtitle: '檢查' });
  });

  it('says why queued work waits and when it goes on, and why failed work failed', () => {
    const retry = { nextAttemptAt: '2026-10-20T02:35:00.000Z', lastError: { code: 'network_error', message: '無法連線到 YouTube，請稍後再試。' } };
    expect(jobEntryLabel(entry({ retry })).waiting).toEqual({ text: '網路錯誤・10:35 重試', tone: 'retry' });
    expect(jobEntryLabel(entry({ wait: { reason: 'rate_limited', until: '2026-10-20T02:42:00.000Z' } })).waiting)
      .toEqual({ text: 'YouTube 限制連線・10:42 繼續', tone: 'cooldown' });
    expect(jobEntryLabel(entry({ error: { code: 'no_subtitles', message: '這支影片沒有字幕。' } })).reason).toBe('沒有字幕');
    expect(jobEntryLabel(entry({ role: 'add', error: { code: 'invalid_subscription', message: '無法辨認這個 YouTube 頻道。' } })).reason).toBe('無法辨認這個 YouTube 頻道。');
  });
});
