// Broken, an Agent cannot read why something failed inside the app, or an Agent writes records the UI is supposed to write.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openCollectorLog } from '../../../../src/domain/log/index.js';
import type { LogPage } from '../../../../src/shared/log/log-types.js';
import { startCollectorServer } from '../../../../src/transport/server/collector-server.js';
import { QUIET_OUTPUT } from '../../../support/log.js';
import { PRODUCT_SOURCES } from '../../../support/product-sources.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function started() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-logs-route-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const log = openCollectorLog({ folder: path.join(root, 'logs'), output: QUIET_OUTPUT });
  const runtime = await startCollectorServer({
    log, sources: PRODUCT_SOURCES, profilePath: root, workspace: null,
    agentSettingsFile: path.join(root, 'agent-settings.json'), skillPath: path.resolve('skills/xr-collector-agent'), uiPort: 0,
  });
  cleanups.push(() => runtime.close());
  const ui = runtime.listeners.ui.url;
  const { connection } = await (await fetch(`${ui}/api/device/agent/connection`)).json() as { connection: { url: string; token: string } };
  const agent = (route: string, init: RequestInit = {}) => fetch(`${connection.url}${route}`, {
    ...init, headers: { authorization: `Bearer ${connection.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  return { log, ui, agent };
}

const pageWrite = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

it('lets an authorized Agent read what the server and the page wrote, before a Vault is set up', async () => {
  const { log, ui, agent } = await started();
  log.write({ level: 'error', source: 'jobs', message: 'Collection jobs write failed' });
  expect((await fetch(`${ui}/api/device/log`, pageWrite({ level: 'warn', message: 'Unable to save theme preference', stack: 'at App' }))).status).toBe(202);

  const response = await agent('/api/device/logs?level=warn,error&limit=10');
  expect(response.status).toBe(200);
  const page = await response.json() as LogPage;
  expect(page.records).toEqual([
    expect.objectContaining({ level: 'warn', source: 'page', message: 'Unable to save theme preference', stack: 'at App' }),
    expect.objectContaining({ level: 'error', source: 'jobs', message: 'Collection jobs write failed' }),
  ]);
});

it('writes nothing for a page record sent to the Agent listener, which has no page log route', async () => {
  const { agent } = await started();
  const response = await agent('/api/device/log', { method: 'POST', body: JSON.stringify({ level: 'error', message: 'from an Agent' }) });
  expect(response.ok).toBe(false);
  expect((await (await agent('/api/device/logs')).json() as LogPage).records).toEqual([]);
});

it.each([
  ['level=fatal'], ['since=2026-11-26T01:00:00'], ['until=yesterday'], ['limit=0'], ['limit=101'], ['cursor='], ['source=page'],
])('answers 400 invalid_request to %s', async (query) => {
  const { agent } = await started();
  const response = await agent(`/api/device/logs?${query}`);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
});

it.each([
  [{ level: 'info', message: 'x' }], [{ level: 'warn', message: '' }], [{ level: 'warn', message: 'x', source: 'jobs' }], [{ level: 'warn', message: 'x', stack: 1 }],
])('refuses a page record %j', async (body) => {
  const { ui } = await started();
  const response = await fetch(`${ui}/api/device/log`, pageWrite(body));
  expect(response.status).toBe(400);
});
