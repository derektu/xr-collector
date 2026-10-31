import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeBatch } from '../../src/core/changes.js';
import type { TrayMenu } from '../../src/electron/tray-menu.js';

vi.mock('electron', () => ({
  Tray: class { on() {} setImage() {} setToolTip() {} setContextMenu() {} destroy() {} },
  Menu: { buildFromTemplate: (template: unknown) => template },
  nativeImage: { createFromPath: () => ({}) },
}));

const { AppTray, READ_GAP_MS } = await import('../../src/electron/tray.js');

const jobChange: ChangeBatch = { revision: 'a:1', at: '2026-10-24T10:00:00.000Z', changes: [{ kind: 'job', id: 'j', parentId: null, state: 'running' }] };
/** The status lines above the actions. */
const status = (menu: TrayMenu) => menu.items.flatMap((item) => item.kind === 'status' ? [item.label] : []).slice(0, 2);

/** The app's API as the tray reads it; `hold` keeps reads waiting until `release`. */
function api(nextCheckAt = '2026-10-24T18:52:00+08:00') {
  let held: Array<() => void> | null = null;
  const bodies: Record<string, unknown> = {
    '/api/device/updates': { update: { phase: 'up_to_date', currentVersion: '0.1.0', progress: null } },
    '/api/device/notifications': { notifications: { active: [] } },
    '/api/jobs/overview': { overview: { running: [], queued: [], failed: [] } },
    '/api/schedule': { schedule: { enabled: true, status: 'scheduled', lastCheck: null, connectivity: { state: 'online', checkedAt: null },
      nextCheck: { type: 'youtube', subscriptionId: 's', title: 'A', at: nextCheckAt } } },
  };
  vi.stubGlobal('fetch', async (url: URL) => {
    if (held) await new Promise<void>((resolve) => { held!.push(resolve); });
    return new Response(JSON.stringify(bodies[url.pathname]), { status: 200 });
  });
  return {
    hold() { held = []; },
    release() { const waiting = held ?? []; held = null; for (const resolve of waiting) resolve(); },
  };
}

function changes() {
  let listener: ((batch: ChangeBatch) => void) | null = null;
  return {
    feed: { subscribe(next: (batch: ChangeBatch) => void) { listener = next; return () => { listener = null; }; } },
    emit(batch: ChangeBatch) { listener?.(batch); },
  };
}

const create = (feed: ReturnType<typeof changes>['feed']) => new AppTray({ serverUrl: 'http://127.0.0.1:1', iconFolder: '/icons', changes: feed, show() {}, quit() {} });

describe('tray reads', () => {
  const timeZone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'Asia/Taipei';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-24T10:00:00+08:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env.TZ = timeZone;
  });

  it('reads once more for changes that arrive together, no sooner than the read gap after the last read', async () => {
    api();
    const stream = changes();
    const tray = create(stream.feed);
    await vi.advanceTimersByTimeAsync(0);
    expect(tray.reads).toBe(1);
    for (let index = 0; index < 5; index += 1) stream.emit(jobChange);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS - 1);
    expect(tray.reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tray.reads).toBe(2);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 3);
    expect(tray.reads).toBe(2);
    tray.destroy();
  });

  it('reads again after a read that a change arrived during', async () => {
    const server = api();
    const stream = changes();
    const tray = create(stream.feed);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    server.hold();
    stream.emit(jobChange);
    await vi.advanceTimersByTimeAsync(0);
    expect(tray.reads).toBe(2);
    stream.emit(jobChange);
    stream.emit(jobChange);
    server.release();
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    expect(tray.reads).toBe(3);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 3);
    expect(tray.reads).toBe(3);
    tray.destroy();
  });

  it('ignores changes the menu does not show', async () => {
    api();
    const stream = changes();
    const tray = create(stream.feed);
    await vi.advanceTimersByTimeAsync(0);
    stream.emit({ ...jobChange, changes: [{ kind: 'document', id: 'd' }, { kind: 'search' }, { kind: 'activity' }] });
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 3);
    expect(tray.reads).toBe(1);
    tray.destroy();
  });

  it('stops reading once destroyed, even in the middle of a read', async () => {
    const server = api();
    const stream = changes();
    const tray = create(stream.feed);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    server.hold();
    stream.emit(jobChange);
    await vi.advanceTimersByTimeAsync(0);
    stream.emit(jobChange);
    const before = tray.current();
    tray.destroy();
    server.release();
    stream.emit(jobChange);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 3);
    expect(tray.reads).toBe(2);
    expect(tray.current()).toBe(before);
  });

  it('draws the last state again at midnight, without reading', async () => {
    vi.setSystemTime(new Date('2026-10-24T23:59:00+08:00'));
    api('2026-10-25T08:00:00+08:00');
    const tray = create(changes().feed);
    await vi.advanceTimersByTimeAsync(0);
    expect(status(tray.current())).toEqual(['沒有進行中的工作', '下次檢查 明天 08:00']);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(status(tray.current())).toEqual(['沒有進行中的工作', '下次檢查 08:00']);
    expect(tray.reads).toBe(1);
    tray.destroy();
  });
});
