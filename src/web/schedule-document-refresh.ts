import type { ChannelSchedule } from '../core/types.js';

export type ScheduleDocumentRefresh = 'progress' | 'completion' | null;

export function scheduleDocumentRefresh(
  observedCompletion: string | null,
  schedule: ChannelSchedule,
): ScheduleDocumentRefresh {
  if (
    schedule.lastCompletedAt
    && observedCompletion
    && schedule.lastCompletedAt !== observedCompletion
  ) {
    return 'completion';
  }
  if (schedule.status === 'running') return 'progress';
  return null;
}
