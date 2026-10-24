import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionSchedule, JobOverview, JobOverviewEntry } from '../../src/core/types.js';
import { CloseHintRecord } from '../../src/electron/close-hint.js';
import { trayMenu } from '../../src/electron/tray-menu.js';
import type { TrayMenu } from '../../src/electron/tray-menu.js';

const now = new Date('2026-10-24T10:24:00+08:00');
const entry = (overrides: Partial<JobOverviewEntry>): JobOverviewEntry => ({
  jobId: 'j', type: 'youtube', role: 'check', title: 'Acquired', url: 'https://www.youtube.com/@acquired', publisher: null,
  progress: null, status: { state: 'queued' }, error: null, failedAt: null, ...overrides,
});
const overview = (overrides: Partial<JobOverview> = {}): JobOverview => ({ running: [], queued: [], failed: [], ...overrides });
const schedule = (overrides: Partial<CollectionSchedule> = {}): CollectionSchedule => ({
  enabled: true, status: 'scheduled', lastCheck: null,
  nextCheck: { type: 'youtube', subscriptionId: 's', title: 'Acquired', at: '2026-10-24T18:52:00+08:00' }, ...overrides,
});

const status = (menu: TrayMenu) => menu.items.flatMap((item) => item.kind === 'status' ? [item.label] : []);
const actions = (menu: TrayMenu) => menu.items.flatMap((item) => item.kind === 'action' ? [item.label] : []);

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

  it('counts failed work on the jobs item', () => {
    const failed = entry({ status: null, error: { code: 'not_found', message: '影片不存在' }, failedAt: '2026-10-24T09:00:00+08:00' });
    const menu = trayMenu({ overview: overview({ failed: [failed, failed] }), schedule: schedule() }, now);
    expect(menu.items).toContainEqual({ kind: 'action', action: 'jobs', label: '工作（2 項失敗）' });
    expect(menu.icon).toBe('idle');
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
