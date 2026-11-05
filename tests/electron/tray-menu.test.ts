// What the tray menu shows: the status lines, icon and tooltip for idle, collecting, offline,
// automatic checks off and subscriptions that need attention, which state wins, the App version and
// update entry, which changes make it read again, and the close hint the user sees only once.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionScheduleView, DeviceUpdateStatus, JobOverview, JobOverviewEntry } from '../../src/core/types.js';
import { CloseHintRecord } from '../../src/electron/close-hint.js';
import { menuStaleAfter, trayModel } from '../../src/electron/tray-menu.js';
import type { TrayModel } from '../../src/electron/tray-menu.js';
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
  target: 'darwin-arm64', installerAvailable: true, offer: null, ready: null, lastAttempt: null, progress: null,
  lastCheckAttemptAt: '2026-10-24T00:00:00.000Z', checkedAt: '2026-10-24T00:00:00.000Z', message: '', errorCode: null, ...overrides });

const status = (menu: TrayModel) => menu.items.flatMap((item) => item.kind === 'status' ? [item.label] : []);
const actions = (menu: TrayModel) => menu.items.flatMap((item) => item.kind === 'action' ? [item.action] : []);
const action = (menu: TrayModel, id: string) => menu.items.find((item) => item.kind === 'action' && item.action === id);
const alert = (id: string, title: string): AutoPauseNotification => ({
  id, title, vaultId: 'vault', sourceType: 'youtube', subscriptionId: id, failureCount: 5,
  error: { code: 'network_error', message: 'unreachable' }, autoPausedAt: `2026-10-24T0${id.length}:00:00.000Z`,
  delivery: 'attempted', deliveryMessage: null,
});
const offline = { state: 'offline' as const, checkedAt: '2026-10-24T02:20:00.000Z' };
const quiet = { attention: 0, work: null, newVersion: null };

describe('tray menu (#32 T1)', () => {
  const timeZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
  afterEach(() => { process.env.TZ = timeZone; });

  it('offers only opening and quitting while no Vault is open', () => {
    const menu = trayModel(null, now);
    expect(menu).toMatchObject({ icon: 'idle', tooltip: quiet });
    expect(status(menu)).toEqual([]);
    expect(actions(menu)).toEqual(['open', 'quit']);
  });

  it('shows when the next check runs while idle, today, tomorrow or later', () => {
    const menu = trayModel({ overview: overview(), schedule: schedule() }, now);
    expect(menu).toMatchObject({ icon: 'idle', tooltip: quiet });
    expect(status(menu)).toEqual([{ text: 'no_work' }, { text: 'next_check', at: { day: 'today', time: '18:52' } }]);
    expect(actions(menu)).toEqual(['open', 'check_now', 'toggle_auto_check', 'jobs', 'activity', 'quit']);
    expect(action(menu, 'toggle_auto_check')).toMatchObject({ checked: true });
    const at = (value: string) => status(trayModel({ overview: overview(), schedule: schedule({ nextCheck: { type: 'youtube', subscriptionId: 's', title: 'A', at: value } }) }, now))[1];
    expect(at('2026-10-24T09:00:00+08:00')).toEqual({ text: 'next_check', at: { day: 'today', time: '09:00' } });
    expect(at('2026-10-25T08:00:00+08:00')).toEqual({ text: 'next_check', at: { day: 'tomorrow', time: '08:00' } });
    expect(at('2026-10-26T08:00:00+08:00')).toEqual({ text: 'next_check', at: { day: 'later', date: '10-26', time: '08:00' } });
    expect(status(trayModel({ overview: overview(), schedule: schedule({ nextCheck: null }) }, now))).toEqual([{ text: 'no_work' }]);
  });

  it('says automatic checks are off, with its own icon and an unchecked switch', () => {
    const menu = trayModel({ overview: overview(), schedule: schedule({ enabled: false, status: 'paused', nextCheck: null }) }, now);
    expect(menu).toMatchObject({ icon: 'auto_check_off', tooltip: { attention: 0, work: { state: 'auto_check_off' } } });
    expect(status(menu)).toEqual([{ text: 'no_work' }, { text: 'auto_check_off' }]);
    expect(action(menu, 'toggle_auto_check')).toMatchObject({ checked: false });
  });

  it('names the running work with its progress, and counts the queue', () => {
    const running = entry({ progress: { done: 3, total: 10 }, status: { state: 'downloading' } });
    const menu = trayModel({ overview: overview({ running: [running], queued: [entry({}), entry({})] }), schedule: schedule({ enabled: false }) }, now);
    expect(menu).toMatchObject({ icon: 'collecting', tooltip: { work: { state: 'collecting', progress: { done: 3, total: 10 } } } });
    expect(status(menu)).toEqual([
      { text: 'running', activity: 'collecting', name: running.title, progress: { done: 3, total: 10 } },
      { text: 'queued', count: 2 },
    ]);
  });

  it('describes a check that is listing, work waiting for a retry, untitled work, and work that only waits', () => {
    const line = (running: JobOverviewEntry[], queued: JobOverviewEntry[] = []) => status(trayModel({ overview: overview({ running, queued }), schedule: schedule() }, now));
    expect(line([entry({ status: { state: 'checking' } })])).toEqual([{ text: 'running', activity: 'checking', name: 'Acquired', progress: null }]);
    expect(line([entry({ status: { state: 'checking' }, progress: { done: 1, total: 2 } })])).toEqual([{ text: 'running', activity: 'collecting', name: 'Acquired', progress: { done: 1, total: 2 } }]);
    expect(line([entry({ status: { state: 'retrying', at: '2026-10-24T10:30:00+08:00', cause: { reason: 'rate_limited' } }, progress: { done: 1, total: 2 } })]))
      .toEqual([{ text: 'running', activity: 'retrying', name: 'Acquired', progress: null }]);
    expect(line([entry({ role: 'item', title: null, url: 'https://www.youtube.com/watch?v=dQ8vR2kLm4E', status: { state: 'downloading' } })]))
      .toEqual([{ text: 'running', activity: 'collecting', name: 'youtube.com/watch?v=dQ8vR2kLm4E', progress: null }]);
    const queuedOnly = trayModel({ overview: overview({ queued: [entry({})] }), schedule: schedule() }, now);
    expect(queuedOnly).toMatchObject({ icon: 'collecting', tooltip: { work: { state: 'collecting', progress: null } } });
    expect(status(queuedOnly)).toEqual([{ text: 'queued', count: 1 }]);
  });

  it('shows the offline icon and says what resumes once the network is back (#128, #179)', () => {
    const idle = trayModel({ overview: overview(), schedule: schedule({ connectivity: offline }) }, now);
    expect(idle).toMatchObject({ icon: 'offline', tooltip: { work: { state: 'offline' } } });
    expect(status(idle)).toEqual([{ text: 'offline' }, { text: 'check_on_reconnect' }]);
    const off = trayModel({ overview: overview(), schedule: schedule({ enabled: false, connectivity: offline }) }, now);
    expect(off).toMatchObject({ icon: 'offline', tooltip: { work: { state: 'offline' } } });
    expect(status(off)).toEqual([{ text: 'offline' }, { text: 'auto_check_off' }]);
    const running = entry({ progress: { done: 3, total: 10 }, status: { state: 'downloading' } });
    const waiting = trayModel({ overview: overview({ running: [running], queued: [entry({}), entry({})] }), schedule: schedule({ connectivity: offline }) }, now);
    expect(waiting).toMatchObject({ icon: 'offline', tooltip: { work: { state: 'offline' } } });
    expect(status(waiting)).toEqual([{ text: 'offline' }, { text: 'offline_waiting', waiting: 3 }]);
    expect(actions(waiting)).toContain('check_now');
    const back = trayModel({ overview: overview({ running: [running], queued: [entry({}), entry({})] }), schedule: schedule() }, now);
    expect(back).toMatchObject({ icon: 'collecting', tooltip: { work: { state: 'collecting', progress: { done: 3, total: 10 } } } });
    expect(status(back)).toEqual([{ text: 'running', activity: 'collecting', name: 'Acquired', progress: { done: 3, total: 10 } }, { text: 'queued', count: 2 }]);
  });

  it('ranks offline below attention and above an available update, without an update badge (#179)', () => {
    const offered = update({ phase: 'available', offer: { version: '0.1.1' } as DeviceUpdateStatus['offer'] });
    const withAttention = trayModel({ overview: overview({ queued: [entry({})] }), schedule: schedule({ connectivity: offline }), actionable: [alert('a', 'A')], update: offered }, now);
    expect(withAttention).toMatchObject({ icon: 'attention', tooltip: { attention: 1, work: { state: 'offline' }, newVersion: null } });
    expect(withAttention.updateBadge).toBeUndefined();
    expect(status(withAttention).slice(0, 2)).toEqual([{ text: 'offline' }, { text: 'offline_waiting', waiting: 1 }]);
    const withUpdate = trayModel({ overview: overview(), schedule: schedule({ connectivity: offline }), updateAvailable: true, update: offered }, now);
    expect(withUpdate).toMatchObject({ icon: 'offline', tooltip: { work: { state: 'offline' }, newVersion: null } });
    expect(withUpdate.updateBadge).toBeUndefined();
    expect(action(withUpdate, 'check_app_update')).toMatchObject({ label: { text: 'app_update', phase: 'available', version: '0.1.1' } });
  });

  it('counts failed work on the jobs item', () => {
    const failed = entry({ status: null, error: { code: 'not_found', message: 'gone' }, failedAt: '2026-10-24T09:00:00+08:00' });
    const menu = trayModel({ overview: overview({ failed: [failed, failed] }), schedule: schedule() }, now);
    expect(action(menu, 'jobs')).toMatchObject({ label: { text: 'jobs', failed: 2 } });
    expect(action(trayModel({ overview: overview(), schedule: schedule() }, now), 'jobs')).toMatchObject({ label: { text: 'jobs', failed: 0 } });
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
      const menu = trayModel({ ...state, update: available }, now);
      expect(menu.icon).toBe(state.icon);
      expect(menu.updateBadge).toBe(true);
      expect(menu.tooltip.newVersion).toBe('0.1.1');
      expect(action(menu, 'check_app_update')).toMatchObject({ label: { text: 'app_update', phase: 'available', version: '0.1.1' } });
      expect(actions(menu).at(-1)).toBe('quit');
    }
    expect(trayModel({ update: available }, now).updateBadge).toBe(true);
    expect(trayModel({ update: update() }, now).updateBadge).toBeUndefined();
    expect(trayModel({ update: update({ phase: 'ready', ready: { version: '0.1.0' } as DeviceUpdateStatus['ready'] }) }, now).updateBadge).toBeUndefined();
  });

  it('puts App version and its distinct update action immediately before Quit', () => {
    const menu = trayModel({ overview: overview(), schedule: schedule(), update: update() }, now);
    expect(status(menu).at(-1)).toEqual({ text: 'app_version', version: '0.1.0' });
    expect(actions(menu).slice(-2)).toEqual(['check_app_update', 'quit']);
    expect(actions(trayModel({ update: update() }, now))).toEqual(['open', 'check_app_update', 'quit']);
  });

  it('describes each active App update phase without starting another check', () => {
    const label = (value: Partial<DeviceUpdateStatus>) => action(trayModel({ update: update(value) }, now), 'check_app_update');
    const offer = { version: '0.1.1' } as DeviceUpdateStatus['offer'];
    const progress = { transferred: 62, total: 100, percent: 62 };
    expect(label({ phase: 'downloading', offer, progress })).toMatchObject({ label: { phase: 'downloading', version: null, percent: 62 } });
    expect(label({ phase: 'downloading', progress: { transferred: 0, total: 0, percent: 0 } })).toMatchObject({ label: { phase: 'downloading', percent: null } });
    expect(label({ phase: 'ready', ready: offer, progress })).toMatchObject({ label: { phase: 'ready', version: '0.1.1', percent: null } });
    expect(label({ phase: 'available', offer })).toMatchObject({ label: { phase: 'available', version: '0.1.1' } });
    expect(label({ phase: 'available' })).toMatchObject({ label: { phase: 'available', version: null } });
    expect(label({ phase: 'waiting', ready: offer })).toMatchObject({ label: { phase: 'waiting', version: null, percent: null } });
    expect(label({ phase: 'error', errorCode: 'update_failed' })).toMatchObject({ label: { phase: 'error' } });
  });

  it('shows 0→1→2→1→0 actionable subscriptions and attention overrides operational and future update icons (#136)', () => {
    const make = (actionable: AutoPauseNotification[], overrides: Parameters<typeof overview>[0] = {}, enabled = true, updateAvailable = false) =>
      trayModel({ overview: overview(overrides), schedule: schedule({ enabled }), actionable, updateAvailable }, now);
    expect(make([]).items.some((item) => item.kind === 'submenu')).toBe(false);
    const one = make([alert('a', 'A')], {}, false, true);
    expect(one.icon).toBe('attention');
    expect(one.tooltip).toEqual({ attention: 1, work: { state: 'auto_check_off' }, newVersion: null });
    expect(one.items).toContainEqual({ kind: 'submenu', label: { text: 'attention', count: 1 }, items: [{ action: 'subscription:a', label: { text: 'subscription', title: 'A' } }] });
    const busy = entry({ progress: { done: 3, total: 10 }, status: { state: 'downloading' } });
    const two = make([alert('a', 'A'), alert('bb', 'B')], { running: [busy] }, true, true);
    expect(two.icon).toBe('attention');
    expect(two.tooltip).toEqual({ attention: 2, work: { state: 'collecting', progress: { done: 3, total: 10 } }, newVersion: null });
    expect(two.items).toContainEqual(expect.objectContaining({ kind: 'submenu', label: { text: 'attention', count: 2 } }));
    expect(make([alert('bb', 'B')]).tooltip).toEqual({ attention: 1, work: { state: 'idle' }, newVersion: null });
    expect(make([], {}, true, true)).toMatchObject({ icon: 'update_available', tooltip: quiet });
    expect(make([], { running: [busy] }, true, true)).toMatchObject({ icon: 'update_available', tooltip: quiet });
    expect(make([]).icon).toBe('idle');
    const offered = update({ phase: 'available', offer: { version: '0.1.1' } as DeviceUpdateStatus['offer'] });
    const attentionWithUpdate = trayModel({ overview: overview(), schedule: schedule(), actionable: [alert('a', 'A')], update: offered }, now);
    expect(attentionWithUpdate.icon).toBe('attention');
    expect(attentionWithUpdate.updateBadge).toBeUndefined();
    expect(actions(attentionWithUpdate)).toContain('check_app_update');
  });

  it('counts subscriptions that need attention while the Vault\'s work is unknown', () => {
    expect(trayModel({ actionable: [alert('a', 'A'), alert('b', 'B')] }, now)).toMatchObject({ icon: 'attention', tooltip: { attention: 2, work: null } });
    expect(trayModel({ updateAvailable: true }, now)).toMatchObject({ icon: 'update_available', tooltip: quiet });
  });
});

describe('tray menu refresh', () => {
  it('reads again after changes to what the menu shows, not after document, search or activity changes', () => {
    expect(menuStaleAfter([{ kind: 'job', id: 'j', parentId: null, state: 'running' }])).toBe(true);
    expect(menuStaleAfter([{ kind: 'connectivity' }])).toBe(true);
    expect(menuStaleAfter([{ kind: 'pacing', group: 'youtube' }])).toBe(true);
    expect(menuStaleAfter([{ kind: 'subscription', type: 'rss', id: 's' }])).toBe(true);
    expect(menuStaleAfter([{ kind: 'schedule' }])).toBe(true);
    expect(menuStaleAfter([{ kind: 'update' }])).toBe(true);
    expect(menuStaleAfter([{ kind: 'notifications' }])).toBe(true);
    expect(menuStaleAfter([{ kind: 'vault', scope: 'contents' }])).toBe(true);
    expect(menuStaleAfter([{ kind: 'document', id: 'd' }, { kind: 'search' }, { kind: 'activity' }])).toBe(false);
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
