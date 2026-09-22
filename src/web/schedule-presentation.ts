import type { ChannelSchedule } from '../core/types.js';

/** Presentation labels retained for the scheduled-collection page that will attach to the Shell later. */
export function scheduleTimingLabels(schedule: ChannelSchedule): {
  startLabel: string;
  completionLabel: string;
  nextRunLabel: string;
} {
  const running = schedule.status === 'running';
  return {
    startLabel: running ? '本次開始' : '上次開始',
    completionLabel: running ? '前次完成' : '上次完成',
    nextRunLabel: scheduleNextRunLabel(schedule),
  };
}

function scheduleNextRunLabel(schedule: ChannelSchedule): string {
  switch (schedule.status) {
    case 'paused': return '已暫停';
    case 'running': return `本次完成 ${formatScheduleInterval(schedule.intervalMinutes)}後`;
    case 'waiting_for_run': return '目前抓取完成後執行';
    case 'scheduled': return formatDateTime(schedule.nextRunAt);
  }
}

function formatScheduleInterval(minutes: number): string {
  if (minutes === 1440) return '1 天';
  if (minutes % 60 === 0) return `${minutes / 60} 小時`;
  return `${minutes} 分鐘`;
}

function formatDateTime(value: string | null): string {
  if (!value) return '尚無';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}
