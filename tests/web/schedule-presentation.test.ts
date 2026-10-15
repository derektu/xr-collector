import { describe, expect, it } from 'vitest';
import { scheduleTimingLabels } from '../../src/web/schedule-presentation.js';
import type { ChannelSchedule } from '../../src/core/types.js';

describe('scheduleTimingLabels', () => {
  it('distinguishes the current dispatch from the previous completion', () => {
    const schedule: ChannelSchedule = {
      enabled: true,
      intervalMinutes: 1,
      status: 'running',
      lastAttemptAt: '2026-09-17T14:03:35.335Z',
      lastCompletedAt: '2026-09-17T14:02:31.143Z',
      nextRunAt: null,
      lastResult: null,
    };

    expect(scheduleTimingLabels(schedule)).toEqual({
      startLabel: '本次派工',
      completionLabel: '前次完成',
      nextRunLabel: '尚無',
    });
    expect(scheduleTimingLabels({ ...schedule, status: 'paused', enabled: false }).nextRunLabel).toBe('已暫停');
  });
});
