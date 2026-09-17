import { describe, expect, it } from 'vitest';
import { scheduleTimingLabels } from '../src/web/App.js';
import type { ChannelSchedule } from '../src/core/types.js';

describe('scheduleTimingLabels', () => {
  it('distinguishes the current run start from the previous completion', () => {
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
      startLabel: '本次開始',
      completionLabel: '前次完成',
      nextRunLabel: '本次完成 1 分鐘後',
    });
  });
});
