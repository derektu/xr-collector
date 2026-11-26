// Broken, the tray shows stale state, or reads the App's state on every change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeBatch } from '../../../src/shared/api/changes.js';
import { recordingLog } from '../../support/log.js';

vi.mock('electron', () => ({
  Tray: class { on() {} setImage() {} setToolTip() {} setContextMenu() {} destroy() {} },
  Menu: { buildFromTemplate: (template: unknown) => template },
  nativeImage: { createFromPath: () => ({}) },
}));

const { AppTray, READ_GAP_MS } = await import('../../../src/desktop/electron/tray.js');

const jobChange: ChangeBatch = { revision: 'a:1', at: '2026-10-24T10:00:00.000Z', changes: [{ kind: 'job', id: 'j', parentId: null, state: 'running' }] };

function api() {
  let held: Array<() => void> | null = null;
  const bodies: Record<string, unknown> = {
    '/api/device/updates': { update: { phase: 'up_to_date', currentVersion: '0.1.0', progress: null } },
    '/api/device/notifications': { notifications: { active: [] } },
    '/api/jobs/overview': { overview: { running: [], queued: [], failed: [] } },
    '/api/schedule': { schedule: { enabled: true, status: 'scheduled', lastCheck: null, connectivity: { state: 'online', checkedAt: null },
      nextCheck: { type: 'youtube', subscriptionId: 's', title: 'A', at: '2026-10-24T18:52:00+08:00' } } },
  };
  vi.stubGlobal('fetch', async (url: URL) => {
    const body = JSON.stringify(bodies[url.pathname]);
    if (held) await new Promise<void>((resolve) => { held!.push(resolve); });
    return new Response(body, { status: 200 });
  });
  return {
    needsAttention() { bodies['/api/device/notifications'] = { notifications: { active: [{ id: 'a', title: 'A' }] } }; },
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

const create = (feed: ReturnType<typeof changes>['feed']) => new AppTray({ log: recordingLog(), platform: 'darwin', serverUrl: 'http://127.0.0.1:1', iconFolder: '/icons', changes: feed, show() {}, quit() {} });

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

  it('a refresh called during a read resolves only after the menu shows a state read after the call', async () => {
    const server = api();
    const tray = create(changes().feed);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    server.hold();
    void tray.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(tray.reads).toBe(2);
    server.needsAttention();
    let resolved = false;
    void tray.refresh().then(() => { resolved = true; });
    server.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(tray.model().icon).toBe('idle');
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    expect(tray.reads).toBe(3);
    expect(tray.model().icon).toBe('attention');
    expect(resolved).toBe(true);
    tray.destroy();
  });

  it('changes arriving during the read gap are covered by the read that follows, without another read', async () => {
    const server = api();
    const stream = changes();
    const tray = create(stream.feed);
    await vi.advanceTimersByTimeAsync(0);
    stream.emit(jobChange);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS / 2);
    server.needsAttention();
    stream.emit(jobChange);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS / 2);
    expect(tray.reads).toBe(2);
    expect(tray.model().icon).toBe('attention');
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 3);
    expect(tray.reads).toBe(2);
    tray.destroy();
  });

  it('a refresh right after a read finishes starts a new read instead of returning the finished one', async () => {
    const server = api();
    const tray = create(changes().feed);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    const first = tray.refresh();
    const next = first.then(() => { server.needsAttention(); return tray.refresh(); });
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(tray.reads).toBe(2);
    expect(tray.model().icon).toBe('idle');
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    await next;
    expect(tray.reads).toBe(3);
    expect(tray.model().icon).toBe('attention');
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
});
