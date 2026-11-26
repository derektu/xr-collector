// Broken, a user misses that a subscription paused itself, gets a backlog of notifications, or sees
// a secret in one.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SubscriptionRecord } from '../../../src/shared/subscriptions/subscription-types.js';
import { protectSecret } from '../../../src/shared/lib/redact.js';
import { NotificationCenter, type SystemNotificationAdapter } from '../../../src/domain/notifications/notification-center.js';
import { notificationNavigation } from '../../../src/desktop/electron/notification-navigation.js';

const record = (at = '2026-10-28T01:00:00.000Z'): SubscriptionRecord => ({
  id: 'channel-a', title: 'Channel A', url: 'https://example.test/a', enabled: false, addedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  settings: { intervalMinutes: 60, latestItems: 10 }, autoPausedAt: at,
  checkFailures: { count: 5, since: '2026-10-27T00:00:00.000Z', error: { code: 'network_error', message: 'secret? no, safe reason' } },
});

function adapter(state: 'available' | 'unavailable' = 'available') {
  const show = vi.fn<SystemNotificationAdapter['show']>(async () => undefined);
  return { show, adapter: { availability: () => ({ state, message: null }), show } satisfies SystemNotificationAdapter };
}

const profile = () => mkdtemp(path.join(tmpdir(), 'xr-notifications-'));

describe('auto-pause notification center (#136)', () => {
  it('notifies each auto-pause while on, none while off, sends no backlog, and keeps the switch after reopening', async () => {
    const root = await profile();
    const { show, adapter: system } = adapter();
    const center = await NotificationCenter.open(root, system);
    await center.recordAutoPause('vault-a', 'youtube', record());
    expect(show).toHaveBeenCalledTimes(1);

    await center.update(false);
    await center.recordAutoPause('vault-a', 'youtube', record('2026-10-28T02:00:00.000Z'));
    const reopened = await NotificationCenter.open(root, system);
    expect(reopened.view([]).enabled).toBe(false);
    await reopened.update(true);
    expect(show).toHaveBeenCalledTimes(1);
    await reopened.recordAutoPause('vault-a', 'youtube', record('2026-10-28T03:00:00.000Z'));
    expect(show).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['without a desktop adapter', undefined],
    ['where the system cannot show notifications', adapter('unavailable').adapter],
  ])('sends nothing %s', async (_name, system) => {
    const center = await NotificationCenter.open(await profile(), system);
    await expect(center.recordAutoPause('vault-a', 'youtube', record())).resolves.toBeUndefined();
    expect(center.view([]).availability).toBe('unavailable');
  });

  it('masks and bounds the title and error it shows', async () => {
    const { show, adapter: system } = adapter();
    const agentToken = 'f'.repeat(64);
    protectSecret(agentToken);
    const unsafe = record();
    unsafe.title = `Cookie: session=top-secret ${'T'.repeat(200)}`;
    unsafe.checkFailures!.error = { code: 'network_error', message: `agent ${agentToken} Authorization: Bearer abcdefghijklmnop https://example.test/?access_token=very-secret ${'E'.repeat(500)}` };
    const center = await NotificationCenter.open(await profile(), system);
    await center.recordAutoPause('vault-a', 'youtube', unsafe);
    const shown = show.mock.calls[0]![0];
    for (const secret of [agentToken, 'top-secret', 'abcdefghijklmnop', 'very-secret']) expect(JSON.stringify(shown)).not.toContain(secret);
    expect(shown.error.message.startsWith('agent [已遮蔽] Authorization: [已遮蔽]')).toBe(true);
    expect(shown.title.length).toBeLessThanOrEqual(120);
    expect(shown.error.message.length).toBeLessThanOrEqual(300);
    expect(center.view([{ vaultId: 'vault-a', sourceType: 'youtube', subscription: unsafe }]).active).toEqual([shown]);
  });

  it('lists the auto-paused subscriptions of the current Vault as active, and opens one only in its own Vault', async () => {
    const center = await NotificationCenter.open(await profile(), adapter().adapter);
    const resumed = { ...record(), enabled: true };
    const { active } = center.view([
      { vaultId: 'current-vault', sourceType: 'rss', subscription: record() },
      { vaultId: 'current-vault', sourceType: 'rss', subscription: resumed },
    ]);
    expect(active).toEqual([expect.objectContaining({ vaultId: 'current-vault', sourceType: 'rss', subscriptionId: 'channel-a' })]);
    expect(notificationNavigation(active[0]!, 'current-vault')).toEqual({ kind: 'source', type: 'rss', id: 'channel-a' });
    expect(notificationNavigation(active[0]!, 'another-vault')).toEqual({ kind: 'message', message: expect.stringContaining('其他知識庫') });
  });
});
