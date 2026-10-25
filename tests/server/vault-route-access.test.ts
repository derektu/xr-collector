import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpApp } from '../../src/server/app.js';
import { VaultOperationLock, type VaultAccess } from '../../src/vault/operation-lock.js';
import type { VaultWorkspace } from '../../src/vault/workspace.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('Vault access declared by routes', () => {
  it('uses route declarations for device data and operations, and method defaults otherwise', async () => {
    const accesses: VaultAccess[] = [];
    const transfer = {
      enterRequest(access: VaultAccess) { accesses.push(access); return () => undefined; },
      status: () => ({ state: 'idle' }),
      checkMove: async () => ({ targetPath: '/tmp/next', requiredBytes: 1, availableBytes: 2 }),
    } as unknown as VaultWorkspace;
    const app = await createHttpApp({
      transfer,
      collector: {
        listDocuments: async () => ({ documents: [], total: 0, nextOffset: null }),
      } as never,
      search: {
        status: () => ({ state: 'ready', indexedDocuments: 0 }),
        rebuild: async () => undefined,
      } as never,
      jobs: {
        list: () => ({ jobs: [], nextCursor: null }),
        overview: async () => ({ running: [], queued: [], failed: [] }),
      } as never,
      activity: {
        query: async () => ({ events: [], nextCursor: null }),
        health: () => ({ state: 'ready' }),
      } as never,
    });
    apps.push(app);

    await app.inject({ method: 'GET', url: '/api/documents' });
    await app.inject({ method: 'POST', url: '/api/search/rebuild' });
    await app.inject({ method: 'GET', url: '/api/jobs' });
    await app.inject({ method: 'GET', url: '/api/activity' });
    await app.inject({ method: 'GET', url: '/api/vault/status' });
    await app.inject({ method: 'POST', url: '/api/vault/move/check', payload: { targetPath: '/tmp/next' } });

    expect(accesses).toEqual([
      'vault-read', 'vault-write', 'vault-operation',
    ]);
  });

  it.each([undefined, 'agent-secret'])('enforces the same lock for UI and Agent routes (token %s)', async (agentToken) => {
    const lock = new VaultOperationLock({
      hold: async () => () => undefined,
      idle: async () => undefined,
      suspend: () => undefined,
    });
    const transfer = {
      enterRequest: (access: VaultAccess) => lock.enter(access),
      status: () => ({ ...lock.status(), vaultPath: '/vault', relocationUnavailable: false }),
    } as unknown as VaultWorkspace;
    const app = await createHttpApp({
      ...(agentToken ? { agentToken } : {}), transfer,
      loginStartup: {
        status: async () => ({ supported: true, enabled: false, state: 'disabled', message: 'off' }),
        update: async (enabled) => ({ supported: true, enabled, state: enabled ? 'enabled' : 'disabled', message: 'ok' }),
      },
      collector: {
        listDocuments: async () => ({ documents: [], total: 0, nextOffset: null }),
        list: async () => [],
      } as never,
      search: {
        search: async () => ({ documents: [], total: 0, nextOffset: null }),
        status: () => ({ state: 'ready', indexedDocuments: 0 }),
        rebuild: async () => undefined,
      } as never,
      jobs: { list: () => ({ jobs: [], nextCursor: null }) } as never,
      activity: {
        query: async () => ({ events: [], nextCursor: null }),
        health: () => ({ state: 'ready' }),
      } as never,
    });
    apps.push(app);
    const headers = agentToken ? { authorization: `Bearer ${agentToken}` } : {};
    let release!: () => void;
    let entered!: () => void;
    const bodyEntered = new Promise<void>((resolve) => { entered = resolve; });
    const work = lock.start({
      operation: 'import',
      body: async (reporter) => {
        reporter.blockReads();
        entered();
        await new Promise<void>((resolve) => { release = resolve; });
        return { value: undefined, message: 'done' };
      },
      failed: () => ({ message: 'failed' }),
    });
    await bodyEntered;

    for (const url of ['/api/documents', '/api/search']) {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode, url).toBe(409);
      expect(response.json().error.code, url).toBe('vault_busy');
    }
    for (const url of ['/api/jobs', '/api/activity', '/api/vault/status', '/api/health', '/api/device/login-startup']) {
      expect((await app.inject({ method: 'GET', url, headers })).statusCode, url).toBe(200);
    }
    const loginStartup = await app.inject({ method: 'PUT', url: '/api/device/login-startup', headers, payload: { enabled: true } });
    expect(loginStartup.statusCode).toBe(200);
    expect(loginStartup.json()).toMatchObject({ loginStartup: { enabled: true } });
    expect((await app.inject({ method: 'POST', url: '/api/search/rebuild', headers })).statusCode).toBe(409);

    release();
    await work;
    expect((await app.inject({ method: 'POST', url: '/api/search/rebuild', headers })).statusCode).toBe(200);
  });
});
