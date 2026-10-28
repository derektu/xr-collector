import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionScheduleView, DeviceUpdateStatus, JobOverview, JobOverviewEntry } from '../../src/core/types.js';
import { CloseHintRecord } from '../../src/electron/close-hint.js';
import { trayMenu } from '../../src/electron/tray-menu.js';
import type { TrayMenu } from '../../src/electron/tray-menu.js';
import type { AutoPauseNotification } from '../../src/notifications/types.js';

const now = new Date('2026-10-24T10:24:00+08:00');
const entry = (overrides: Partial<JobOverviewEntry>): JobOverviewEntry => ({
  jobId: 'j', type: 'youtube', role: 'check', title: 'Acquired', url: 'https://www.youtube.com/@acquired', publisher: null,
  progress: null, status: { state: 'queued' }, error: null, failedAt: null, ...overrides,
});
const overview = (overrides: Partial<JobOverview> = {}): JobOverview => ({ running: [], queued: [], failed: [], ...overrides });
const schedule = (overrides: Partial<CollectionScheduleView> = {}): CollectionScheduleView => ({
  enabled: true, status: 'scheduled', lastCheck: null, connectivity: { state: 'online', checkedAt: null },
  nextCheck: { type: 'youtube', subscriptionId: 's', title: 'Acquired', at: '2026-10-24T18:52:00+08:00' }, ...overrides,
});
const update = (overrides: Partial<DeviceUpdateStatus> = {}): DeviceUpdateStatus => ({ phase: 'up_to_date', currentVersion: '0.1.0',
  target: 'darwin-arm64', variant: 'chinese', installerAvailable: true, offer: null, ready: null, lastAttempt: null, progress: null,
  lastCheckAttemptAt: '2026-10-24T00:00:00.000Z', checkedAt: '2026-10-24T00:00:00.000Z', message: '已是最新版。', errorCode: null, ...overrides });

const status = (menu: TrayMenu) => menu.items.flatMap((item) => item.kind === 'status' ? [item.label] : []);
const actions = (menu: TrayMenu) => menu.items.flatMap((item) => item.kind === 'action' ? [item.label] : []);
const alert = (id: string, title: string): AutoPauseNotification => ({
  id, title, vaultId: 'vault', sourceType: 'youtube', subscriptionId: id, failureCount: 5,
  error: { code: 'network_error', message: '無法連線' }, autoPausedAt: `2026-10-24T0${id.length}:00:00.000Z`,
  delivery: 'attempted', deliveryMessage: null,
});

describe('tray menu (#32 T1)', () => {
  const timeZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
  afterEach(() => { process.env.TZ = timeZone; });

  it('offers only opening and quitting while no Vault is open', () => {
    const menu = trayMenu(null, now);
    expect(menu).toMatchObject({ icon: 'idle', tooltip: 'XR Collector' });
    expect(status(menu)).toEqual([]);
    expect(actions(menu)).toEqual(['開啟 XR Collector', '結束 XR Collector']);
  });

  it('shows when the next check runs while idle, today, tomorrow or later', () => {
    const menu = trayMenu({ overview: overview(), schedule: schedule() }, now);
    expect(menu).toMatchObject({ icon: 'idle', tooltip: 'XR Collector' });
    expect(status(menu)).toEqual(['沒有進行中的工作', '下次檢查 18:52']);
    expect(actions(menu)).toEqual(['開啟 XR Collector', '立即檢查所有訂閱', '自動檢查', '工作', '記錄', '結束 XR Collector']);
    expect(menu.items).toContainEqual({ kind: 'action', action: 'toggle_auto_check', label: '自動檢查', checked: true });
    const at = (value: string) => status(trayMenu({ overview: overview(), schedule: schedule({ nextCheck: { type: 'youtube', subscriptionId: 's', title: 'A', at: value } }) }, now))[1];
    expect(at('2026-10-25T08:00:00+08:00')).toBe('下次檢查 明天 08:00');
    expect(at('2026-10-26T08:00:00+08:00')).toBe('下次檢查 10-26 08:00');
    expect(status(trayMenu({ overview: overview(), schedule: schedule({ nextCheck: null }) }, now))).toEqual(['沒有進行中的工作']);
  });

  it('says automatic checks are off, with its own icon and an unchecked switch', () => {
    const menu = trayMenu({ overview: overview(), schedule: schedule({ enabled: false, status: 'paused', nextCheck: null }) }, now);
    expect(menu).toMatchObject({ icon: 'auto_check_off', tooltip: 'XR Collector・自動檢查已關閉' });
    expect(status(menu)).toEqual(['沒有進行中的工作', '自動檢查已關閉']);
    expect(menu.items).toContainEqual({ kind: 'action', action: 'toggle_auto_check', label: '自動檢查', checked: false });
  });

  it('names the running work with its progress, and counts the queue', () => {
    const running = entry({ progress: { done: 3, total: 10 }, status: { state: 'downloading' } });
    const menu = trayMenu({ overview: overview({ running: [running], queued: [entry({}), entry({})] }), schedule: schedule({ enabled: false }) }, now);
    expect(menu).toMatchObject({ icon: 'collecting', tooltip: 'XR Collector・收集中 3/10' });
    expect(status(menu)).toEqual(['正在收集：Acquired　3/10', '排隊中 2 項']);
  });

  it('describes a check that is listing, work waiting for a retry, untitled work, and work that only waits', () => {
    const line = (running: JobOverviewEntry[], queued: JobOverviewEntry[] = []) => status(trayMenu({ overview: overview({ running, queued }), schedule: schedule() }, now));
    expect(line([entry({ status: { state: 'checking' } })])).toEqual(['正在檢查：Acquired']);
    expect(line([entry({ status: { state: 'retrying', at: '2026-10-24T10:30:00+08:00', cause: { reason: 'rate_limited' } } })])).toEqual(['等待重試：Acquired']);
    expect(line([entry({ role: 'item', title: null, url: 'https://www.youtube.com/watch?v=dQ8vR2kLm4E', status: { state: 'downloading' } })])).toEqual(['正在收集：youtube.com/watch?v=dQ8vR2kLm4E']);
    const queuedOnly = trayMenu({ overview: overview({ queued: [entry({})] }), schedule: schedule() }, now);
    expect(queuedOnly).toMatchObject({ icon: 'collecting', tooltip: 'XR Collector・收集中' });
    expect(status(queuedOnly)).toEqual(['排隊中 1 項']);
  });

  it('says the device has no network above the work and the next check (#128)', () => {
    const offline = { state: 'offline' as const, checkedAt: '2026-10-24T02:20:00.000Z' };
    expect(status(trayMenu({ overview: overview(), schedule: schedule({ connectivity: offline }) }, now)))
      .toEqual(['目前沒有網路', '沒有進行中的工作', '下次檢查 18:52']);
    const running = entry({ progress: { done: 3, total: 10 }, status: { state: 'downloading' } });
    const menu = trayMenu({ overview: overview({ running: [running] }), schedule: schedule({ connectivity: offline }) }, now);
    expect(status(menu)).toEqual(['目前沒有網路', '正在收集：Acquired　3/10']);
    expect(actions(menu)).toContain('立即檢查所有訂閱');
  });

  it('counts failed work on the jobs item', () => {
    const failed = entry({ status: null, error: { code: 'not_found', message: '影片不存在' }, failedAt: '2026-10-24T09:00:00+08:00' });
    const menu = trayMenu({ overview: overview({ failed: [failed, failed] }), schedule: schedule() }, now);
    expect(menu.items).toContainEqual({ kind: 'action', action: 'jobs', label: '工作（2 項失敗）' });
    expect(menu.icon).toBe('idle');
  });

  it('keeps each work-state icon while adding a persistent update shape and menu entry', () => {
    const available = update({ phase: 'available', offer: { version: '0.1.1' } as DeviceUpdateStatus['offer'] });
    const cases = [
      { overview: overview(), schedule: schedule(), icon: 'idle' },
      { overview: overview({ running: [entry({ status: { state: 'downloading' } })] }), schedule: schedule(), icon: 'collecting' },
      { overview: overview(), schedule: schedule({ enabled: false }), icon: 'auto_check_off' },
    ] as const;
    for (const state of cases) {
      const menu = trayMenu({ ...state, update: available }, now);
      expect(menu.icon).toBe(state.icon);
      expect(menu.updateBadge).toBe(true);
      expect(menu.tooltip).toContain('有新版本 0.1.1');
      expect(actions(menu)).toContain('App 更新：可下載 0.1.1');
      expect(actions(menu)).toContain('結束 XR Collector');
    }
    expect(trayMenu({ update: available }, now).updateBadge).toBe(true);
    expect(trayMenu({ update: update() }, now).updateBadge).toBeUndefined();
    expect(trayMenu({ update: update({ phase: 'ready', ready: { version: '0.1.0' } as DeviceUpdateStatus['ready'] }) }, now).updateBadge).toBeUndefined();
  });

  it('puts App version and its distinct update action immediately before Quit', () => {
    const menu = trayMenu({ overview: overview(), schedule: schedule(), update: update() }, now);
    expect(status(menu).at(-1)).toBe('版本 0.1.0');
    expect(actions(menu).slice(-2)).toEqual(['檢查 App 更新', '結束 XR Collector']);
    const withoutVault = trayMenu({ update: update() }, now);
    expect(actions(withoutVault)).toEqual(['開啟 XR Collector', '檢查 App 更新', '結束 XR Collector']);
  });

  it('describes each active App update phase without starting another check', () => {
    const labels = (value: Partial<DeviceUpdateStatus>) => actions(trayMenu({ update: update(value) }, now))[1];
    expect(labels({ phase: 'downloading', progress: { transferred: 62, total: 100 } })).toBe('App 更新：下載中 62%');
    expect(labels({ phase: 'ready', ready: { version: '0.1.1' } as DeviceUpdateStatus['ready'] })).toBe('App 更新：已下載待安裝 0.1.1');
    expect(labels({ phase: 'waiting' })).toBe('App 更新：等待工作完成');
    expect(labels({ phase: 'installing' })).toBe('App 更新：安裝中');
    expect(labels({ phase: 'error', errorCode: 'update_failed' })).toBe('App 更新：錯誤');
  });

  it('shows 0→1→2→1→0 actionable subscriptions and attention overrides operational and future update icons (#136)', () => {
    const make = (actionable: AutoPauseNotification[], overrides: Parameters<typeof overview>[0] = {}, enabled = true, updateAvailable = false) =>
      trayMenu({ overview: overview(overrides), schedule: schedule({ enabled }), actionable, updateAvailable }, now);
    expect(make([]).items.some((item) => item.kind === 'submenu')).toBe(false);
    const one = make([alert('a', 'A')], {}, false, true);
    expect(one.icon).toBe('attention');
    expect(one.tooltip).toContain('自動檢查已關閉');
    expect(one.items).toContainEqual({ kind: 'submenu', label: '需要處理的訂閱（1）', items: [{ action: 'subscription:a', label: 'A' }] });
    const busy = entry({ progress: { done: 3, total: 10 }, status: { state: 'downloading' } });
    const two = make([alert('a', 'A'), alert('bb', 'B')], { running: [busy] }, true, true);
    expect(two.icon).toBe('attention');
    expect(two.tooltip).toContain('收集中 3/10');
    expect(two.items).toContainEqual(expect.objectContaining({ kind: 'submenu', label: '需要處理的訂閱（2）' }));
    expect(make([alert('bb', 'B')]).items).toContainEqual(expect.objectContaining({ kind: 'submenu', label: '需要處理的訂閱（1）' }));
    expect(make([], {}, true, true).icon).toBe('update_available');
    expect(make([]).icon).toBe('idle');
    const offered = update({ phase: 'available', offer: { version: '0.1.1' } as DeviceUpdateStatus['offer'] });
    const attentionWithUpdate = trayMenu({ overview: overview(), schedule: schedule(), actionable: [alert('a', 'A')], update: offered }, now);
    expect(attentionWithUpdate.icon).toBe('attention');
    expect(attentionWithUpdate.updateBadge).toBeUndefined();
    expect(actions(attentionWithUpdate)).toContain('App 更新：可下載 0.1.1');
  });
});

describe('first close hint record (#32 T2)', () => {
  it('is not shown until marked, stays marked, and counts an unreadable record as not shown', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'xr-tray-')), 'tray.json');
    const record = new CloseHintRecord(file);
    await expect(record.shown()).resolves.toBe(false);
    await record.markShown();
    await expect(record.shown()).resolves.toBe(true);
    await expect(new CloseHintRecord(file).shown()).resolves.toBe(true);
    await writeFile(file, '{ not json');
    await expect(new CloseHintRecord(file).shown()).resolves.toBe(false);
  });
});
