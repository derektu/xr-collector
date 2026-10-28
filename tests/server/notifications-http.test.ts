import { describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../src/server/app.js';
import type { NotificationState } from '../../src/notifications/types.js';

const state = (enabled: boolean): NotificationState => ({
  enabled, availability: 'unavailable', availabilityMessage: 'desktop only', active: [], events: [],
});

describe('device notification API (#136)', () => {
  it('is shared by UI and authorized Agent and validates the one preference', async () => {
    let enabled = true;
    const update = vi.fn(async (value: boolean) => state(enabled = value));
    const access = { notifications: { read: async () => state(enabled), update } };
    const ui = await createHttpApp(access);
    const app = await createHttpApp({ ...access, agentAuthorize: (header) => header === 'Bearer secret' });
    expect((await ui.inject('/api/device/notifications')).json()).toEqual({ notifications: state(true) });
    expect((await app.inject({ url: '/api/device/notifications', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/device/notifications', headers: { authorization: 'Bearer secret' } })).json()).toEqual({ notifications: state(true) });
    expect((await app.inject({ method: 'PUT', url: '/api/device/notifications', headers: { authorization: 'Bearer secret' }, payload: { enabled: false } })).json())
      .toEqual({ notifications: state(false) });
    expect(update).toHaveBeenCalledWith(false);
    for (const payload of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }]) {
      expect((await ui.inject({ method: 'PUT', url: '/api/device/notifications', payload })).statusCode).toBe(400);
    }
    await ui.close();
    await app.close();
  });

  it('remains readable and writable as device data when no Vault is selected', async () => {
    let enabled = true;
    const uiWithoutVault = await createHttpApp({ notifications: {
      read: async () => state(enabled),
      update: async (value: boolean) => state(enabled = value),
    } });
    expect((await uiWithoutVault.inject('/api/device/notifications')).json()).toEqual({ notifications: state(true) });
    expect((await uiWithoutVault.inject({ method: 'PUT', url: '/api/device/notifications', payload: { enabled: false } })).json())
      .toEqual({ notifications: state(false) });
    await uiWithoutVault.close();
  });
});
