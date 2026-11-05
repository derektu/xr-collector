import type { CollectionScheduleView, DeviceUpdateStatus, JobOverview, JobOverviewEntry } from '../core/types.js';
import type { Change } from '../core/changes.js';
import type { AutoPauseNotification } from '../notifications/types.js';
import { upcomingTime, upcomingTimeText, type UpcomingTime } from '../core/upcoming-time.js';

/** What the menu shows comes from jobs and their pacing, the network, the schedule and subscriptions, updates and notifications, and the open Vault. */
const MENU_STALE_AFTER: ReadonlySet<Change['kind']> = new Set(['job', 'pacing', 'connectivity', 'schedule', 'subscription', 'update', 'notifications', 'vault']);

/** True when the menu must read its state again after these changes. */
export function menuStaleAfter(changes: readonly Change[]): boolean {
  return changes.some((change) => MENU_STALE_AFTER.has(change.kind));
}

/**
 * The tray icon states, highest priority first: subscriptions need attention, the device has no
 * network, an App update is available, then the work state (work queued or running, nothing to do,
 * automatic checks off).
 */
export type TrayIcon = 'attention' | 'offline' | 'update_available' | 'collecting' | 'idle' | 'auto_check_off';

/** What the menu acts on; the menu's own items use these as their ids. */
export type TrayAction = 'open' | 'check_now' | 'toggle_auto_check' | 'jobs' | 'activity' | 'check_app_update' | 'quit'
  | `subscription:${string}`;

type MenuItem<Label> =
  | { kind: 'status'; label: Label }
  | { kind: 'action'; action: TrayAction; label: Label; checked?: boolean }
  | { kind: 'submenu'; label: Label; items: Array<{ action: TrayAction; label: Label }> }
  | { kind: 'separator' };

export type TrayMenuItem = MenuItem<string>;

export interface TrayMenu {
  icon: TrayIcon;
  /** An update shape over the existing work-state icon; no system notification. */
  updateBadge?: boolean;
  tooltip: string;
  items: TrayMenuItem[];
}

/** What the running work does, as its status line names it. */
export type RunningActivity = 'collecting' | 'checking' | 'retrying';

/** What a menu label says, before it is put into words. */
export type TrayLabel =
  | { text: 'open' }
  | { text: 'quit' }
  | { text: 'check_now' }
  | { text: 'auto_check' }
  | { text: 'jobs'; failed: number }
  | { text: 'activity' }
  | { text: 'offline' }
  | { text: 'offline_waiting'; waiting: number }
  | { text: 'check_on_reconnect' }
  | { text: 'auto_check_off' }
  | { text: 'running'; activity: RunningActivity; name: string; progress: { done: number; total: number } | null }
  | { text: 'queued'; count: number }
  | { text: 'no_work' }
  | { text: 'next_check'; at: UpcomingTime }
  | { text: 'attention'; count: number }
  | { text: 'subscription'; title: string }
  | { text: 'app_version'; version: string }
  /** `version`: the offered version while it is available or downloaded; `percent`: the download's progress once its size is known. */
  | { text: 'app_update'; phase: DeviceUpdateStatus['phase']; version: string | null; percent: number | null };

/** The work the tooltip names after the App name; `idle` only beside subscriptions that need attention. */
export type TrayWork = { state: 'offline' | 'auto_check_off' | 'idle' } | { state: 'collecting'; progress: { done: number; total: number } | null };

/** The tooltip: subscriptions that need attention, the work it names, and a newer App version behind the update shape. */
export interface TrayTooltip {
  attention: number;
  work: TrayWork | null;
  newVersion: string | null;
}

/** The menu as the rules decide it; `trayMenu` puts its labels and tooltip into words. */
export interface TrayModel {
  icon: TrayIcon;
  updateBadge?: boolean;
  tooltip: TrayTooltip;
  items: Array<MenuItem<TrayLabel>>;
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

const separator = { kind: 'separator' } as const;
const open = { kind: 'action', action: 'open', label: { text: 'open' } } as const;
const quit = { kind: 'action', action: 'quit', label: { text: 'quit' } } as const;

/** The tray icon, its tooltip and its menu for the open Vault's work, or for no open Vault. */
export function trayMenu(state: TrayState | null, now: Date = new Date()): TrayMenu {
  return trayMenuText(trayModel(state, now));
}

/** The menu in words. */
export function trayMenuText(model: TrayModel): TrayMenu {
  const label = (value: TrayLabel) => trayLabelText(value);
  return {
    icon: model.icon,
    tooltip: trayTooltipText(model.tooltip),
    items: model.items.map((item): TrayMenuItem => {
      switch (item.kind) {
        case 'separator': return item;
        case 'status': return { kind: 'status', label: label(item.label) };
        case 'action': return { ...item, label: label(item.label) };
        case 'submenu': return { kind: 'submenu', label: label(item.label), items: item.items.map((child) => ({ action: child.action, label: label(child.label) })) };
      }
    }),
    ...(model.updateBadge ? { updateBadge: true } : {}),
  };
}

/** Which icon, tooltip and items the menu shows for the open Vault's work, or for no open Vault. */
export function trayModel(state: TrayState | null, now: Date = new Date()): TrayModel {
  if (!state) return { icon: 'idle', tooltip: { attention: 0, work: null, newVersion: null }, items: [open, separator, quit] };
  const actionable = state.actionable ?? [];
  if (!state.overview || !state.schedule) return withUpdateBadge({
    icon: actionable.length > 0 ? 'attention' : state.updateAvailable ? 'update_available' : 'idle',
    tooltip: { attention: actionable.length, work: null, newVersion: null },
    items: [open, ...actionableItems(actionable), separator, ...updateItems(state.update), quit],
  }, state.update);
  const { overview, schedule } = state;
  const [current] = overview.running;
  const waiting = overview.running.length + overview.queued.length;
  const offline = schedule.connectivity.state === 'offline';
  const status = offline ? offlineLines(waiting, schedule.enabled) : workLines(overview, schedule, now);
  const operational: TrayIcon = offline ? 'offline' : waiting > 0 ? 'collecting' : schedule.enabled ? 'idle' : 'auto_check_off';
  const icon: TrayIcon = actionable.length > 0 ? 'attention' : !offline && state.updateAvailable ? 'update_available' : operational;
  const shown = actionable.length > 0 || (icon === operational && operational !== 'idle');
  return withUpdateBadge({
    icon,
    tooltip: { attention: actionable.length, work: shown ? workOf(operational, current) : null, newVersion: null },
    items: [
      ...status.map((label) => ({ kind: 'status' as const, label })),
      ...actionableItems(actionable),
      separator,
      open,
      { kind: 'action', action: 'check_now', label: { text: 'check_now' } },
      { kind: 'action', action: 'toggle_auto_check', label: { text: 'auto_check' }, checked: schedule.enabled },
      separator,
      { kind: 'action', action: 'jobs', label: { text: 'jobs', failed: overview.failed.length } },
      { kind: 'action', action: 'activity', label: { text: 'activity' } },
      separator,
      ...updateItems(state.update),
      quit,
    ],
  }, state.update);
}

/** While offline the menu says what resumes once the network is back, not what is running. */
function offlineLines(waiting: number, autoCheck: boolean): TrayLabel[] {
  if (waiting > 0) return [{ text: 'offline' }, { text: 'offline_waiting', waiting }];
  return [{ text: 'offline' }, autoCheck ? { text: 'check_on_reconnect' } : { text: 'auto_check_off' }];
}

function workLines(overview: JobOverview, schedule: CollectionScheduleView, now: Date): TrayLabel[] {
  const [current] = overview.running;
  const lines: TrayLabel[] = [];
  if (current) lines.push(runningLine(current));
  if (overview.queued.length > 0) lines.push({ text: 'queued', count: overview.queued.length });
  if (overview.running.length === 0 && overview.queued.length === 0) {
    lines.push({ text: 'no_work' });
    if (!schedule.enabled) lines.push({ text: 'auto_check_off' });
    else if (schedule.nextCheck) lines.push({ text: 'next_check', at: upcomingTime(schedule.nextCheck.at, now) });
  }
  return lines;
}

function withUpdateBadge(menu: TrayModel, update: DeviceUpdateStatus | undefined): TrayModel {
  const version = (update?.ready ?? update?.offer)?.version;
  if (['attention', 'offline', 'update_available'].includes(menu.icon) || !version || version === update?.currentVersion) return menu;
  return { ...menu, updateBadge: true, tooltip: { ...menu.tooltip, newVersion: version } };
}

function actionableItems(actionable: AutoPauseNotification[]): Array<MenuItem<TrayLabel>> {
  if (actionable.length === 0) return [];
  return [{ kind: 'submenu', label: { text: 'attention', count: actionable.length },
    items: actionable.map((event) => ({ action: `subscription:${event.id}` as const, label: { text: 'subscription', title: event.title } })) }];
}

function updateItems(update: DeviceUpdateStatus | undefined): Array<MenuItem<TrayLabel>> {
  if (!update) return [];
  const offered = (update.ready ?? update.offer)?.version;
  const version = (update.phase === 'available' || update.phase === 'ready') && offered ? offered : null;
  const percent = update.phase === 'downloading' && update.progress && update.progress.total > 0
    ? Math.round(update.progress.transferred / update.progress.total * 100) : null;
  return [
    { kind: 'status', label: { text: 'app_version', version: update.currentVersion } },
    { kind: 'action', action: 'check_app_update', label: { text: 'app_update', phase: update.phase, version, percent } },
    separator,
  ];
}

function runningLine(entry: JobOverviewEntry): TrayLabel {
  const name = entry.title ?? displayAddress(entry.url);
  if (entry.status?.state === 'retrying') return { text: 'running', activity: 'retrying', name, progress: null };
  if (entry.progress) return { text: 'running', activity: 'collecting', name, progress: entry.progress };
  if (entry.status?.state === 'checking') return { text: 'running', activity: 'checking', name, progress: null };
  return { text: 'running', activity: 'collecting', name, progress: null };
}

function workOf(icon: TrayIcon, current: JobOverviewEntry | undefined): TrayWork {
  if (icon === 'offline' || icon === 'auto_check_off') return { state: icon };
  if (icon === 'collecting') return { state: 'collecting', progress: current?.progress ?? null };
  return { state: 'idle' };
}

/** An address without its scheme and `www.`, as the jobs page shows work whose title is unknown. */
function displayAddress(url: string): string {
  return url.replace(/^https?:\/\//u, '').replace(/^www\./u, '');
}

function progressText(progress: { done: number; total: number } | null): string {
  return progress ? `${progress.done}/${progress.total}` : '';
}

const UPDATE_PHASE_TEXT: Record<DeviceUpdateStatus['phase'], string> = {
  idle: '檢查 App 更新',
  checking: 'App 更新：正在檢查',
  available: 'App 更新：可下載',
  downloading: 'App 更新：下載中',
  verifying: 'App 更新：驗證下載',
  ready: 'App 更新：已下載待安裝',
  waiting: 'App 更新：等待工作完成',
  installing: 'App 更新：安裝中',
  up_to_date: '檢查 App 更新',
  error: 'App 更新：錯誤',
};

/** A menu label in words. */
export function trayLabelText(label: TrayLabel): string {
  switch (label.text) {
    case 'open': return '開啟 XR Collector';
    case 'quit': return '結束 XR Collector';
    case 'check_now': return '立即檢查所有訂閱';
    case 'auto_check': return '自動檢查';
    case 'jobs': return label.failed > 0 ? `工作（${label.failed} 項失敗）` : '工作';
    case 'activity': return '記錄';
    case 'offline': return '目前沒有網路';
    case 'offline_waiting': return `${label.waiting} 項工作等待中，恢復後自動接續`;
    case 'check_on_reconnect': return '恢復後自動檢查';
    case 'auto_check_off': return '自動檢查已關閉';
    case 'running': {
      if (label.activity === 'retrying') return `等待重試：${label.name}`;
      if (label.activity === 'checking') return `正在檢查：${label.name}`;
      return label.progress ? `正在收集：${label.name}　${progressText(label.progress)}` : `正在收集：${label.name}`;
    }
    case 'queued': return `排隊中 ${label.count} 項`;
    case 'no_work': return '沒有進行中的工作';
    case 'next_check': return `下次檢查 ${upcomingTimeText(label.at)}`;
    case 'attention': return `需要處理的訂閱（${label.count}）`;
    case 'subscription': return label.title;
    case 'app_version': return `版本 ${label.version}`;
    case 'app_update': {
      const text = UPDATE_PHASE_TEXT[label.phase];
      if (label.percent !== null) return `${text} ${label.percent}%`;
      return label.version ? `${text} ${label.version}` : text;
    }
  }
}

function workText(work: TrayWork): string {
  switch (work.state) {
    case 'offline': return '沒有網路';
    case 'auto_check_off': return '自動檢查已關閉';
    case 'collecting': return work.progress ? `收集中 ${progressText(work.progress)}` : '收集中';
    case 'idle': return '沒有進行中的工作';
  }
}

/** The tooltip in words: "XR Collector・1 個訂閱需要處理・收集中 3/10 · 有新版本 0.1.1". */
export function trayTooltipText(tooltip: TrayTooltip): string {
  const parts = ['XR Collector'];
  if (tooltip.attention > 0) parts.push(`${tooltip.attention} 個訂閱需要處理`);
  if (tooltip.work) parts.push(workText(tooltip.work));
  const text = parts.join('・');
  return tooltip.newVersion ? `${text} · 有新版本 ${tooltip.newVersion}` : text;
}
