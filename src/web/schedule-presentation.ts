import type { ChannelSchedule } from '../core/types.js';

/** Presentation labels retained for the scheduled-collection page that will attach to the Shell later. */
export function scheduleTimingLabels(schedule: ChannelSchedule): {
  startLabel: string;
  completionLabel: string;
  nextRunLabel: string;
} {
  const running = schedule.status === 'running';
  return {
    startLabel: running ? '本次派工' : '上次派工',
    completionLabel: running ? '前次完成' : '上次完成',
    nextRunLabel: schedule.status === 'paused' ? '已暫停' : formatDateTime(schedule.nextRunAt),
  };
}

function formatDateTime(value: string | null): string {
  if (!value) return '尚無';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}
