import { describe, expect, it } from 'vitest';
import { scheduleDocumentRefresh } from '../../src/web/schedule-document-refresh.js';
import type { ChannelSchedule } from '../../src/core/types.js';

describe('scheduleDocumentRefresh', () => {
  it('refreshes the visible document list while an automatic collection is running', () => {
    const schedule: ChannelSchedule = {
      enabled: true,
      intervalMinutes: 1,
      status: 'running',
      lastAttemptAt: '2026-09-17T13:52:04.498Z',
      lastCompletedAt: null,
      nextRunAt: null,
      lastResult: null,
    };

    expect(scheduleDocumentRefresh(null, schedule)).toBe('progress');
  });
});
