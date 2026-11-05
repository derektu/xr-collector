// A system notification is handed to the OS at once: collection never waits for the OS to report it
// shown, and a later OS failure is reported as a readable failure message. Secrets never reach the
// OS notification or the failure message.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { protectSecret } from '../../src/core/redact.js';
import type { AutoPauseNotification } from '../../src/core/device-types.js';

const created = vi.hoisted(() => [] as Array<{ title: string; body: string }>);
vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    static isSupported() { return true; }
    constructor(options: { title: string; body: string }) { super(); created.push({ title: options.title, body: options.body }); }
    show() { /* The OS reports nothing. */ }
  },
}));

const { attemptDelivery, ElectronSystemNotifications } = await import('../../src/electron/system-notifications.js');

describe('system notification delivery (#136)', () => {
  it('does not wait when the OS emits neither show nor failed', () => {
    const notification = Object.assign(new EventEmitter(), { show: vi.fn() });
    const shown = vi.fn();
    const failed = vi.fn();
    expect(() => attemptDelivery(notification, 'id', shown, failed)).not.toThrow();
    expect(notification.show).toHaveBeenCalledOnce();
    expect(shown).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('reports a later failure without changing the synchronous attempt', () => {
    const notification = Object.assign(new EventEmitter(), { show: vi.fn() });
    const failed = vi.fn();
    attemptDelivery(notification, 'id', vi.fn(), failed);
    notification.emit('failed', {}, 'blocked');
    expect(failed).toHaveBeenCalledWith('系統通知發送失敗：blocked');
  });
});

describe('secrets in system notifications (#254)', () => {
  const agentToken = 'd'.repeat(64);
  protectSecret(agentToken);

  it('masks secrets in the failure the OS reports', () => {
    const notification = Object.assign(new EventEmitter(), { show: vi.fn() });
    const failed = vi.fn();
    attemptDelivery(notification, 'id', vi.fn(), failed);
    notification.emit('failed', {}, `denied ${agentToken} Authorization: Bearer os-bearer`);
    expect(failed).toHaveBeenCalledWith('系統通知發送失敗：denied [已遮蔽] Authorization: [已遮蔽]');
  });

  it('masks secrets in the title and body handed to the OS', async () => {
    const observed: Array<{ title: string; content: string }> = [];
    const adapter = new ElectronSystemNotifications(() => undefined, (notification) => observed.push(notification));
    const event: AutoPauseNotification = {
      id: 'n1', vaultId: 'vault-a', sourceType: 'rss', subscriptionId: 'feed', title: `Feed ${agentToken}`, failureCount: 5,
      error: { code: 'network_error', message: `GET https://feed.test/rss?token=feed-secret agent ${agentToken}` },
      autoPausedAt: '2026-10-28T01:00:00.000Z', delivery: 'pending', deliveryMessage: null,
    };
    await adapter.show(event);
    const shown = JSON.stringify([created.at(-1), observed.at(-1)]);
    for (const secret of [agentToken, 'feed-secret']) expect(shown).not.toContain(secret);
    expect(created.at(-1)!.body).toContain('token=[已遮蔽] agent [已遮蔽]');
  });
});
