// Which routes a Vault operation such as an import blocks, and which answer before a Vault is ready:
// each route declares its Vault access. The UI and Agent listeners share the route code, so one
// listener stands for both. During an import, documents, search and rebuild answer 409 vault_busy
// while jobs, activity, Vault status and device settings stay available. The device routes listed
// below answer both before a Vault is ready and during an import; every other route answers
// vault_not_ready until a Vault is ready. A device route that loses its declaration leaves the UI
// and Agents unable to finish setup, or blocks device settings and job progress during an import.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpApp } from '../../src/server/app.js';
import { VaultOperationLock, type VaultAccess } from '../../src/vault/operation-lock.js';
import type { VaultWorkspace } from '../../src/runtime/vault-workspace.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';
import { anyService, apiRoutes, appWithEveryRoute, type ApiRoute } from '../support/api-routes.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('Vault access declared by routes', () => {
  it('blocks document reads and writes during an import while device routes stay available', async () => {
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
      sources: PRODUCT_SOURCES,
      transfer,
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
        summary: async () => ({ entries: [], nextCursor: null }),
        group: async () => ({ group: { groupId: 'locked-group', count: 1 }, checks: [], nextCursor: null }),
        health: () => ({ state: 'ready' }),
      } as never,
      agentConnection: {
        status: () => ({ state: 'available', activeUrl: 'http://127.0.0.1:7222', activePort: 7222, configured: { mode: 'auto' }, restartRequired: false, message: 'ok' }),
        connection: () => ({ url: 'http://127.0.0.1:7222', token: 'device-key' }),
        configure: async () => ({ state: 'available', activeUrl: 'http://127.0.0.1:7222', activePort: 7222, configured: { mode: 'auto' }, restartRequired: false, message: 'ok' }),
        resetKey: async () => ({ url: 'http://127.0.0.1:7222', token: 'next-key' }),
        download: async () => Buffer.from('zip'), authorize: () => true,
      },
    });
    apps.push(app);
    const headers = {};
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
    for (const url of ['/api/jobs', '/api/activity', '/api/activity?view=summary', '/api/activity/groups/locked-group', '/api/vault/status', '/api/health', '/api/device/login-startup',
      '/api/device/agent', '/api/device/agent/connection', '/api/device/agent/skill']) {
      expect((await app.inject({ method: 'GET', url, headers })).statusCode, url).toBe(200);
    }
    const loginStartup = await app.inject({ method: 'PUT', url: '/api/device/login-startup', headers, payload: { enabled: true } });
    expect(loginStartup.statusCode).toBe(200);
    expect(loginStartup.json()).toMatchObject({ loginStartup: { enabled: true } });
    expect((await app.inject({ method: 'PUT', url: '/api/device/agent/port', headers, payload: { mode: 'auto' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/device/agent/key/reset', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/search/rebuild', headers })).statusCode).toBe(409);

    release();
    await work;
    expect((await app.inject({ method: 'POST', url: '/api/search/rebuild', headers })).statusCode).toBe(200);
  });

  it('answers device routes before a Vault is ready and during an import, and refuses every other route until a Vault is ready', async () => {
    const lock = new VaultOperationLock({
      hold: async () => () => undefined,
      idle: async () => undefined,
      suspend: () => undefined,
    });
    let notReady: string | null = '尚未設定知識庫。';
    const app = await appWithEveryRoute({
      notReady: () => notReady,
      transfer: anyService({
        enterRequest: (access: VaultAccess) => lock.enter(access),
        status: () => ({ ...lock.status(), vaultPath: '/vault', relocationUnavailable: false }),
      }),
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    /** The status and error code `route` answers; an event stream is read only up to its headers. */
    const send = async (route: ApiRoute): Promise<{ status: number; code: string | null }> => {
      const controller = new AbortController();
      const response = await fetch(`${base}${route.url.replace(/:(\w+)/gu, 'x')}`, {
        method: route.method,
        signal: controller.signal,
        ...(['POST', 'PUT', 'PATCH'].includes(route.method) ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      });
      if (response.headers.get('content-type')?.startsWith('application/json')) {
        const body = await response.json() as { error?: { code?: string } };
        return { status: response.status, code: body.error?.code ?? null };
      }
      controller.abort();
      return { status: response.status, code: null };
    };
    const routes = apiRoutes(app);
    const device = routes.filter((route) => DEVICE_ROUTES.includes(`${route.method} ${route.url}`));
    // Every listed route is registered, so the list cannot hide a route that lost its path.
    expect(device.map((route) => `${route.method} ${route.url}`).sort()).toEqual([...DEVICE_ROUTES].sort());

    for (const route of routes) {
      const answer = await send(route);
      const name = `${route.method} ${route.url}`;
      if (device.includes(route)) expect(answer.code, name).not.toBe('vault_not_ready');
      else expect(answer, name).toEqual({ status: 503, code: 'vault_not_ready' });
    }

    notReady = null;
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
    expect(await send({ method: 'GET', url: '/api/documents' })).toEqual({ status: 409, code: 'vault_busy' });
    for (const route of device) expect((await send(route)).code, `${route.method} ${route.url}`).not.toBe('vault_busy');
    release();
    await work;
  });
});

/** The routes that read or change state outside the Vault. */
const DEVICE_ROUTES: readonly string[] = [
  'GET /api/events', 'GET /api/changes', 'GET /api/health', 'GET /api/pacing',
  'GET /api/vault/setup', 'POST /api/vault/setup', 'POST /api/vault/inspect', 'POST /api/vault/new/check',
  'POST /api/vault/package/describe', 'GET /api/vault/status',
  'GET /api/device/build-info', 'GET /api/device/notifications', 'PUT /api/device/notifications',
  'GET /api/device/updates', 'POST /api/device/updates/check', 'POST /api/device/updates/download',
  'POST /api/device/updates/apply', 'POST /api/device/updates/cancel',
  'GET /api/device/login-startup', 'PUT /api/device/login-startup',
  'GET /api/device/agent', 'GET /api/device/agent/connection', 'PUT /api/device/agent/port',
  'POST /api/device/agent/key/reset', 'GET /api/device/agent/skill',
  'GET /api/jobs', 'GET /api/jobs/summary', 'GET /api/jobs/overview', 'GET /api/jobs/:id',
  'GET /api/activity', 'GET /api/activity/groups/:groupId',
];
