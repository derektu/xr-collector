import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SubscriptionRecord } from '../../src/core/types.js';
import { NotificationCenter, type SystemNotificationAdapter } from '../../src/notifications/notification-center.js';
import { notificationNavigation } from '../../src/electron/notification-navigation.js';

const record = (at = '2026-10-28T01:00:00.000Z'): SubscriptionRecord => ({
  id: 'channel-a', title: 'Channel A', url: 'https://example.test/a', enabled: false, addedAt: '2026-10-01T00:00:00.000Z',
  settings: { intervalMinutes: 60, latestItems: 10 }, autoPausedAt: at,
  checkFailures: { count: 5, since: '2026-10-27T00:00:00.000Z', error: { code: 'network_error', message: 'secret? no, safe reason' } },
});

describe('auto-pause notification center (#136)', () => {
  it('suppresses delivery without a desktop adapter', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-notifications-'));
    const center = await NotificationCenter.open(root);
    await center.recordAutoPause('vault-a', 'youtube', record());
    expect(center.view([{ vaultId: 'vault-a', sourceType: 'youtube', subscription: record() }], 'vault-a'))
      .toMatchObject({ availability: 'unavailable', events: [{ delivery: 'suppressed' }] });
  });

  it('reports an ordinary device-profile write failure to its caller', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-notifications-'));
    const blocked = path.join(root, 'not-a-directory');
    await writeFile(blocked, 'file');
    const center = await NotificationCenter.open(path.join(blocked, 'profile'));
    await expect(center.update(false)).rejects.toMatchObject({ code: expect.any(String) });
  });

  it('redacts and bounds title, error and profile/API/OS adapter payloads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-notifications-'));
    const shown: unknown[] = [];
    const adapter: SystemNotificationAdapter = { availability: () => ({ state: 'available', message: null }), show: async (event) => { shown.push(event); }, restore: async () => undefined };
    const unsafe = record();
    unsafe.title = `Cookie: session=top-secret ${'T'.repeat(200)}`;
    unsafe.checkFailures!.error = { code: 'network_error', message: `Authorization: Bearer abcdefghijklmnop https://example.test/?access_token=very-secret ${'E'.repeat(500)}` };
    const center = await NotificationCenter.open(root, adapter);
    await center.recordAutoPause('vault-a', 'youtube', unsafe);
    const raw = await readFile(path.join(root, 'notifications.json'), 'utf8');
    const event = center.view([{ vaultId: 'vault-a', sourceType: 'youtube', subscription: unsafe }], 'vault-a').events[0]!;
    expect(raw).not.toContain('top-secret');
    expect(raw).not.toContain('abcdefghijklmnop');
    expect(raw).not.toContain('very-secret');
    expect(event.title.length).toBeLessThanOrEqual(120);
    expect(event.error.message.length).toBeLessThanOrEqual(300);
    expect(shown).toEqual([event]);
  });

  it('persists preference/dedup, suppresses while off without backlog, and reconciles active rows', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-notifications-'));
    const show = vi.fn(async () => undefined);
    const adapter: SystemNotificationAdapter = { availability: () => ({ state: 'available', message: null }), show, restore: async () => undefined };
    const center = await NotificationCenter.open(root, adapter);
    await center.recordAutoPause('vault-a', 'youtube', record());
    await center.recordAutoPause('vault-a', 'youtube', record());
    expect(show).toHaveBeenCalledTimes(1);
    expect(center.view([{ vaultId: 'vault-a', sourceType: 'youtube', subscription: record() }], 'vault-a').active).toHaveLength(1);
    expect(center.view([], 'vault-a').active).toHaveLength(0);
    await center.update(false);
    await center.recordAutoPause('vault-a', 'youtube', record('2026-10-28T02:00:00.000Z'));
    await center.update(true);
    expect(show).toHaveBeenCalledTimes(1);
    await center.recordAutoPause('vault-a', 'youtube', record('2026-10-28T03:00:00.000Z'));
    expect(show).toHaveBeenCalledTimes(2);
    const restarted = await NotificationCenter.open(root, adapter);
    await restarted.recordAutoPause('vault-a', 'youtube', record('2026-10-28T03:00:00.000Z'));
    expect(show).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(path.join(root, 'notifications.json'), 'utf8')).events).toHaveLength(3);
  });

  it('records adapter failures without treating attempted delivery as OS visibility', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-notifications-'));
    const adapter: SystemNotificationAdapter = {
      availability: () => ({ state: 'available', message: null }), restore: async () => undefined,
      show: async () => { throw new Error('blocked by OS'); },
    };
    const center = await NotificationCenter.open(root, adapter);
    await center.recordAutoPause('vault-a', 'rss', record());
    expect(center.view([{ vaultId: 'vault-a', sourceType: 'rss', subscription: record() }], 'vault-a').events[0])
      .toMatchObject({ delivery: 'failed', deliveryMessage: 'blocked by OS' });
  });

  it('builds the active list from current Vault rows without sending backlog and scopes history to that Vault', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-notifications-'));
    const show = vi.fn(async () => undefined);
    const adapter: SystemNotificationAdapter = { availability: () => ({ state: 'available', message: null }), show, restore: async () => undefined };
    const center = await NotificationCenter.open(root, adapter);
    await center.recordAutoPause('other-vault', 'youtube', record());
    const active = center.view([{ vaultId: 'current-vault', sourceType: 'rss', subscription: record() }], 'current-vault');
    expect(active.active).toEqual([expect.objectContaining({ vaultId: 'current-vault', sourceType: 'rss', delivery: 'suppressed' })]);
    expect(active.events).toEqual([]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(notificationNavigation(active.active[0]!, 'current-vault')).toEqual({ kind: 'source', type: 'rss', id: 'channel-a' });
    expect(notificationNavigation(active.active[0]!, 'another-vault')).toEqual({ kind: 'message', message: expect.stringContaining('其他知識庫') });
  });

  it('serializes concurrent auto-pauses and preference writes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-notifications-'));
    const adapter: SystemNotificationAdapter = { availability: () => ({ state: 'available', message: null }), show: async () => undefined, restore: async () => undefined };
    const center = await NotificationCenter.open(root, adapter);
    await Promise.all([
      center.recordAutoPause('vault-a', 'youtube', record('2026-10-28T01:00:00.000Z')),
      center.recordAutoPause('vault-a', 'youtube', record('2026-10-28T02:00:00.000Z')),
      center.update(false),
    ]);
    const saved = JSON.parse(await readFile(path.join(root, 'notifications.json'), 'utf8'));
    expect(saved.enabled).toBe(false);
    expect(saved.events).toHaveLength(2);
  });
});
