import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { attemptDelivery } from '../../src/electron/system-notifications.js';

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
