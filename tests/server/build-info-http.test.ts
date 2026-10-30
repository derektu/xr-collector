import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CollectorRuntime } from '../../src/runtime/collector-runtime.js';
import { VaultOperationLock, type VaultAccess } from '../../src/vault/operation-lock.js';
import type { VaultWorkspace } from '../../src/vault/workspace.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildInfo } from '../../src/core/types.js';
import { createHttpApp } from '../../src/server/app.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const info: BuildInfo = {
  schemaVersion: 1, kind: 'packaged', version: '0.7.0', builtAt: '2026-10-25T09:00:00.000Z',
  commit: '1234567890123456789012345678901234567890', buildId: 'fixture-build',
  target: 'darwin-arm64', sourceDirty: false,
};

describe('build information HTTP contract', () => {
  it('gives UI and authorized Agent the same immutable artifact while the Vault is not ready', async () => {
    const source = { ...info };
    const ui = await createHttpApp({ buildInfo: source, notReady: () => '尚未設定 Vault。' });
    const agent = await createHttpApp({ buildInfo: source, notReady: () => '尚未設定 Vault。', agentToken: 'test-secret' });
    apps.push(ui, agent);
    source.version = '9.9.9';
    const response = await ui.inject('/api/device/build-info');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buildInfo: info });
    for (const authorization of ['', 'Bearer wrong']) {
      expect((await agent.inject({ url: '/api/device/build-info', headers: { authorization } })).statusCode).toBe(401);
    }
    const authorized = await agent.inject({ url: '/api/device/build-info', headers: { authorization: 'Bearer test-secret' } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual(response.json());
    expect((await ui.inject('/api/documents')).statusCode).toBe(503);
  });
  it('does not acquire the Vault lock for device identity', async () => {
    const lock = new VaultOperationLock({ hold: async () => () => undefined, idle: async () => undefined, suspend: () => undefined });
    let release!: () => void;
    let entered!: () => void;
    const bodyEntered = new Promise<void>((resolve) => { entered = resolve; });
    const work = lock.start({ operation: 'import', body: async (reporter) => {
      reporter.blockReads(); entered(); await new Promise<void>((resolve) => { release = resolve; });
      return { value: undefined, message: 'done' };
    }, failed: () => ({ message: 'failed' }) });
    await bodyEntered;
    try {
      const app = await createHttpApp({ buildInfo: info,
        transfer: { enterRequest: (access: VaultAccess) => lock.enter(access) } as VaultWorkspace,
        collector: { listDocuments: async () => ({ documents: [], total: 0, nextOffset: null }) } as never,
      });
      apps.push(app);
      expect((await app.inject('/api/documents')).statusCode).toBe(409);
      expect((await app.inject('/api/device/build-info')).json()).toEqual({ buildInfo: info });
    } finally { release(); await work; }
  });

  it('forwards one identity through the real UI and Agent listeners with existing Host and token guards', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-build-http-'));
    const runtime = await CollectorRuntime.start({ buildInfo: info, profilePath: root, workspace: null,
      agentSettingsFile: path.join(root, 'agent-settings.json'), skillPath: path.resolve('skills/xr-collector-agent'), uiPort: 0,
    });
    try {
      const connection = runtime.agentAccess.connection();
      const read = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/api/device/build-info`, { headers: { connection: 'close', ...headers } });
      const ui = await read(runtime.server.url);
      const agent = await read(connection.url, { authorization: `Bearer ${connection.token}` });
      expect(ui.status).toBe(200);
      expect(agent.status).toBe(200);
      expect(await ui.json()).toEqual({ buildInfo: info });
      expect(await agent.json()).toEqual({ buildInfo: info });
      expect((await read(connection.url)).status).toBe(401);
      expect((await runtime.server.app.inject({ url: '/api/device/build-info', headers: { host: 'untrusted.invalid' } })).statusCode).toBe(403);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });
});
