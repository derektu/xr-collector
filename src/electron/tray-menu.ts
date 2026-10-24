import type { CollectionSchedule, JobOverview, JobOverviewEntry } from '../core/types.js';

/** The three tray icons: nothing to do, work queued or running, automatic checks off. */
export type TrayIcon = 'idle' | 'collecting' | 'auto_check_off';

/** What the menu acts on; the menu's own items use these as their ids. */
export type TrayAction = 'open' | 'check_now' | 'toggle_auto_check' | 'jobs' | 'activity' | 'quit';

export type TrayMenuItem =
  | { kind: 'status'; label: string }
  | { kind: 'action'; action: TrayAction; label: string; checked?: boolean }
  | { kind: 'separator' };

export interface TrayMenu {
  icon: TrayIcon;
  tooltip: string;
  items: TrayMenuItem[];
}

/**
 * The open Vault's work and schedule as the menu reads them from the app's API; null while no Vault
 * is open (Onboarding, or the Vault is unavailable).
 */
export interface TrayState {
  overview: JobOverview;
  schedule: CollectionSchedule;
}

const separator: TrayMenuItem = { kind: 'separator' };
const open: TrayMenuItem = { kind: 'action', action: 'open', label: '開啟 XR Collector' };
const quit: TrayMenuItem = { kind: 'action', action: 'quit', label: '結束 XR Collector' };

/** The tray icon, its tooltip and its menu for the open Vault's work, or for no open Vault. */
export function trayMenu(state: TrayState | null, now: Date = new Date()): TrayMenu {
  if (!state) return { icon: 'idle', tooltip: 'XR Collector', items: [open, separator, quit] };
  const { overview, schedule } = state;
  const [current] = overview.running;
  const busy = overview.running.length > 0 || overview.queued.length > 0;
  const status: string[] = [];
  if (current) status.push(runningLine(current));
  if (overview.queued.length > 0) status.push(`排隊中 ${overview.queued.length} 項`);
  if (!busy) {
    status.push('沒有進行中的工作');
    if (!schedule.enabled) status.push('自動檢查已關閉');
    else if (schedule.nextCheck) status.push(`下次檢查 ${clockLabel(schedule.nextCheck.at, now)}`);
  }
  const icon: TrayIcon = busy ? 'collecting' : schedule.enabled ? 'idle' : 'auto_check_off';
  const failed = overview.failed.length;
  return {
    icon,
    tooltip: tooltipFor(icon, current),
    items: [
      ...status.map((label): TrayMenuItem => ({ kind: 'status', label })),
      separator,
      open,
      { kind: 'action', action: 'check_now', label: '立即檢查所有訂閱' },
      { kind: 'action', action: 'toggle_auto_check', label: '自動檢查', checked: schedule.enabled },
      separator,
      { kind: 'action', action: 'jobs', label: failed > 0 ? `工作（${failed} 項失敗）` : '工作' },
      { kind: 'action', action: 'activity', label: '記錄' },
      separator,
      quit,
    ],
  };
}

function runningLine(entry: JobOverviewEntry): string {
  const name = entry.title ?? displayAddress(entry.url);
  if (entry.status?.state === 'retrying') return `等待重試：${name}`;
  if (entry.progress) return `正在收集：${name}　${entry.progress.done}/${entry.progress.total}`;
  if (entry.status?.state === 'checking') return `正在檢查：${name}`;
  return `正在收集：${name}`;
}

function tooltipFor(icon: TrayIcon, current: JobOverviewEntry | undefined): string {
  if (icon === 'auto_check_off') return 'XR Collector・自動檢查已關閉';
  if (icon !== 'collecting') return 'XR Collector';
  return current?.progress ? `XR Collector・收集中 ${current.progress.done}/${current.progress.total}` : 'XR Collector・收集中';
}

/** An address without its scheme and `www.`, as the jobs page shows work whose title is unknown. */
function displayAddress(url: string): string {
  return url.replace(/^https?:\/\//u, '').replace(/^www\./u, '');
}

/** "18:52" today, "明天 08:00" tomorrow, "10-26 08:00" later. */
function clockLabel(value: string, now: Date): string {
  const date = new Date(value);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOf = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime();
  if (date.getTime() < startOf(1)) return time;
  if (date.getTime() < startOf(2)) return `明天 ${time}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
