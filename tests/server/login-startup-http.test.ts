import { describe, expect, it, vi } from 'vitest';
import type { LoginStartupAccess } from '../../src/core/login-startup.js';
import { CollectorError } from '../../src/core/types.js';
import { createHttpApp } from '../../src/server/app.js';

describe('login startup HTTP API', () => {
  it('is readable before Vault setup and refuses changes in Web/development mode', async () => {
    const app = await createHttpApp({ notReady: () => '尚未設定 Vault。' });
    const read = await app.inject({ method: 'GET', url: '/api/device/login-startup' });
    const write = await app.inject({ method: 'PUT', url: '/api/device/login-startup', payload: { enabled: true } });
    expect(read.json()).toMatchObject({ loginStartup: { supported: false, enabled: false, state: 'unavailable' } });
    expect(write.statusCode).toBe(409);
    expect(write.json()).toMatchObject({ error: { code: 'login_startup_unavailable' } });
    await app.close();
  });

  it('uses the injected packaged service and validates the exact request shape', async () => {
    let enabled = false;
    const update = vi.fn(async (next: boolean) => ({ supported: true, enabled: next, state: next ? 'enabled' as const : 'disabled' as const, message: 'ok' }));
    const loginStartup: LoginStartupAccess = {
      status: async () => ({ supported: true, enabled, state: enabled ? 'enabled' : 'disabled', message: 'ok' }),
      update: async (next) => { enabled = next; return update(next); },
    };
    const app = await createHttpApp({ loginStartup });
    const changed = await app.inject({ method: 'PUT', url: '/api/device/login-startup', payload: { enabled: true } });
    expect(changed.json()).toEqual({ loginStartup: { supported: true, enabled: true, state: 'enabled', message: 'ok' } });
    expect(update).toHaveBeenCalledWith(true);
    for (const payload of [{}, { enabled: 'true' }, { enabled: true, extra: 1 }]) {
      const response = await app.inject({ method: 'PUT', url: '/api/device/login-startup', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
    await app.close();
  });

  it('returns approval and read-back failures with stable codes', async () => {
    for (const [code, expected] of [['login_startup_requires_approval', 409], ['login_startup_failed', 500]] as const) {
      const app = await createHttpApp({ loginStartup: {
        status: async () => ({ supported: true, enabled: false, state: 'disabled', message: 'off' }),
        update: async () => { throw new CollectorError(code, code); },
      } });
      const response = await app.inject({ method: 'PUT', url: '/api/device/login-startup', payload: { enabled: true } });
      expect(response.statusCode).toBe(expected);
      expect(response.json()).toMatchObject({ error: { code } });
      await app.close();
    }
  });
});
