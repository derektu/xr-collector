// GET/PUT /api/device/login-startup, the open-at-login setting: readable before a Vault is set up,
// refused outside the packaged app on the UI and the Agent listener alike, strict about the request body, and reporting a needed approval
// or a failed read-back with stable error codes.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LoginStartupAccess } from '../../src/core/login-startup.js';
import { CollectorError } from '../../src/core/types.js';
import { startAgentAccess } from '../../src/server/agent-access.js';
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

  it('refuses changes from an authorized Agent in Web/development mode too', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-login-startup-agent-'));
    const access = await startAgentAccess({
      notReady: () => '尚未設定 Vault。', settingsFile: path.join(root, 'agent-settings.json'),
      preferredPort: await freePort(), skillPath: path.resolve('skills/xr-collector-agent'),
    });
    try {
      const { url, token } = access.connection();
      const response = await fetch(`${url}/api/device/login-startup`, {
        method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'login_startup_unavailable' } });
    } finally {
      await access.close();
      await rm(root, { recursive: true, force: true });
    }
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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}
