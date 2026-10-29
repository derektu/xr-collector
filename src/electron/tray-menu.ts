import type { CollectionScheduleView, DeviceUpdateStatus, JobOverview, JobOverviewEntry } from '../core/types.js';
import type { AutoPauseNotification } from '../notifications/types.js';

/**
 * The tray icon states, highest priority first: subscriptions need attention, the device has no
 * network, an App update is available, then the work state (work queued or running, nothing to do,
 * automatic checks off).
 */
export type TrayIcon = 'attention' | 'offline' | 'update_available' | 'collecting' | 'idle' | 'auto_check_off';

/** What the menu acts on; the menu's own items use these as their ids. */
export type TrayAction = 'open' | 'check_now' | 'toggle_auto_check' | 'jobs' | 'activity' | 'check_app_update' | 'quit'
  | `subscription:${string}`;

export type TrayMenuItem =
  | { kind: 'status'; label: string }
  | { kind: 'action'; action: TrayAction; label: string; checked?: boolean }
  | { kind: 'submenu'; label: string; items: Array<{ action: TrayAction; label: string }> }
  | { kind: 'separator' };

export interface TrayMenu {
  icon: TrayIcon;
  /** An update shape over the existing work-state icon; no system notification. */
  updateBadge?: boolean;
  tooltip: string;
  items: TrayMenuItem[];
}

/**
 * The open Vault's work and schedule as the menu reads them from the app's API; null while no Vault
 * is open (Onboarding, or the Vault is unavailable).
 */
export interface TrayState {
  overview?: JobOverview;
  schedule?: CollectionScheduleView;
  update?: DeviceUpdateStatus;
  actionable?: AutoPauseNotification[];
  /** Contract for #36; #136 does not populate this from an update service. */
  updateAvailable?: boolean;
}

const separator: TrayMenuItem = { kind: 'separator' };
const open: TrayMenuItem = { kind: 'action', action: 'open', label: '開啟 XR Collector' };
const quit: TrayMenuItem = { kind: 'action', action: 'quit', label: '結束 XR Collector' };

/** The tray icon, its tooltip and its menu for the open Vault's work, or for no open Vault. */
export function trayMenu(state: TrayState | null, now: Date = new Date()): TrayMenu {
  if (!state) return { icon: 'idle', tooltip: 'XR Collector', items: [open, separator, quit] };
  const actionable = state.actionable ?? [];
  if (!state.overview || !state.schedule) return withUpdateBadge({
    icon: actionable.length > 0 ? 'attention' : state.updateAvailable ? 'update_available' : 'idle',
    tooltip: actionable.length > 0 ? `XR Collector・${actionable.length} 個訂閱需要處理` : 'XR Collector',
    items: [open, ...actionableItems(actionable), separator, ...updateItems(state.update), quit],
  }, state.update);
  const { overview, schedule } = state;
  const [current] = overview.running;
  const waiting = overview.running.length + overview.queued.length;
  const offline = schedule.connectivity.state === 'offline';
  const status = offline ? offlineLines(waiting, schedule.enabled) : workLines(overview, schedule, now);
  const operational: TrayIcon = offline ? 'offline' : waiting > 0 ? 'collecting' : schedule.enabled ? 'idle' : 'auto_check_off';
  const icon: TrayIcon = actionable.length > 0 ? 'attention' : !offline && state.updateAvailable ? 'update_available' : operational;
  const failed = overview.failed.length;
  return withUpdateBadge({
    icon,
    tooltip: actionable.length > 0 ? `XR Collector・${actionable.length} 個訂閱需要處理・${operationalLabel(operational, current)}` : tooltipFor(icon, current),
    items: [
      ...status.map((label): TrayMenuItem => ({ kind: 'status', label })),
      ...actionableItems(actionable),
      separator,
      open,
      { kind: 'action', action: 'check_now', label: '立即檢查所有訂閱' },
      { kind: 'action', action: 'toggle_auto_check', label: '自動檢查', checked: schedule.enabled },
      separator,
      { kind: 'action', action: 'jobs', label: failed > 0 ? `工作（${failed} 項失敗）` : '工作' },
      { kind: 'action', action: 'activity', label: '記錄' },
      separator,
      ...updateItems(state.update),
      quit,
    ],
  }, state.update);
}

/** While offline the menu says what resumes once the network is back, not what is running. */
function offlineLines(waiting: number, autoCheck: boolean): string[] {
  if (waiting > 0) return ['目前沒有網路', `${waiting} 項工作等待中，恢復後自動接續`];
  return ['目前沒有網路', autoCheck ? '恢復後自動檢查' : '自動檢查已關閉'];
}

function workLines(overview: JobOverview, schedule: CollectionScheduleView, now: Date): string[] {
  const [current] = overview.running;
  const lines: string[] = [];
  if (current) lines.push(runningLine(current));
  if (overview.queued.length > 0) lines.push(`排隊中 ${overview.queued.length} 項`);
  if (overview.running.length === 0 && overview.queued.length === 0) {
    lines.push('沒有進行中的工作');
    if (!schedule.enabled) lines.push('自動檢查已關閉');
    else if (schedule.nextCheck) lines.push(`下次檢查 ${clockLabel(schedule.nextCheck.at, now)}`);
  }
  return lines;
}

function withUpdateBadge(menu: TrayMenu, update: DeviceUpdateStatus | undefined): TrayMenu {
  const version = (update?.ready ?? update?.offer)?.version;
  if (['attention', 'offline', 'update_available'].includes(menu.icon) || !version || version === update?.currentVersion) return menu;
  return { ...menu, updateBadge: true, tooltip: `${menu.tooltip} · 有新版本 ${version}` };
}

function actionableItems(actionable: AutoPauseNotification[]): TrayMenuItem[] {
  if (actionable.length === 0) return [];
  return [{ kind: 'submenu', label: `需要處理的訂閱（${actionable.length}）`,
    items: actionable.map((event) => ({ action: `subscription:${event.id}` as const, label: event.title })) }];
}

function updateItems(update: DeviceUpdateStatus | undefined): TrayMenuItem[] {
  if (!update) return [];
  const version = (update.ready ?? update.offer)?.version;
  const progress = update.progress && update.progress.total > 0
    ? ` ${Math.round(update.progress.transferred / update.progress.total * 100)}%` : '';
  const labels: Record<DeviceUpdateStatus['phase'], string> = {
    idle: '檢查 App 更新',
    checking: 'App 更新：正在檢查',
    available: version ? `App 更新：可下載 ${version}` : 'App 更新：可下載',
    downloading: `App 更新：下載中${progress}`,
    verifying: 'App 更新：驗證下載',
    ready: version ? `App 更新：已下載待安裝 ${version}` : 'App 更新：已下載待安裝',
    waiting: 'App 更新：等待工作完成',
    installing: 'App 更新：安裝中',
    up_to_date: '檢查 App 更新',
    error: 'App 更新：錯誤',
  };
  return [
    { kind: 'status', label: `版本 ${update.currentVersion}` },
    { kind: 'action', action: 'check_app_update', label: labels[update.phase] },
    separator,
  ];
}

function runningLine(entry: JobOverviewEntry): string {
  const name = entry.title ?? displayAddress(entry.url);
  if (entry.status?.state === 'retrying') return `等待重試：${name}`;
  if (entry.progress) return `正在收集：${name}　${entry.progress.done}/${entry.progress.total}`;
  if (entry.status?.state === 'checking') return `正在檢查：${name}`;
  return `正在收集：${name}`;
}

function tooltipFor(icon: TrayIcon, current: JobOverviewEntry | undefined): string {
  if (icon === 'offline') return 'XR Collector・沒有網路';
  if (icon === 'auto_check_off') return 'XR Collector・自動檢查已關閉';
  if (icon !== 'collecting') return 'XR Collector';
  return current?.progress ? `XR Collector・收集中 ${current.progress.done}/${current.progress.total}` : 'XR Collector・收集中';
}

function operationalLabel(icon: TrayIcon, current: JobOverviewEntry | undefined): string {
  if (icon === 'offline') return '沒有網路';
  if (icon === 'auto_check_off') return '自動檢查已關閉';
  if (icon === 'collecting') return current?.progress ? `收集中 ${current.progress.done}/${current.progress.total}` : '收集中';
  return '沒有進行中的工作';
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
