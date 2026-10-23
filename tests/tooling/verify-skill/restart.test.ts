// instance.restart() keeps the run's slot lock held by a live process the whole time, so a sweep
// from another session that lands between the old server's exit and the new server's start leaves
// the lock and the run folder alone. The servers are stand-ins (fixtures/fake-server.mjs) behind a
// fake checkout's tsx, answering readiness through a local HTTP server.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { alive, cleanUp, isolateHome, LIB, repository, start, temp, until } from './support.js';

const home = isolateHome();
const { processStart, runMarker, runsRoot, SLOT_LOCKS } = await import('../../../.claude/skills/verify/scripts/lib/paths.mjs');
const { attach, holdSlot, lockLive, runProcesses, terminateRun } = await import('../../../.claude/skills/verify/scripts/lib/instance.mjs');

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
let api: Server;
let url: string;

beforeAll(async () => {
  expect(SLOT_LOCKS).toBe(path.join(home, '.xr-collector', 'verify-slots'));
  api = createServer((request, response) => {
    const body = { '/api/health': { ok: true }, '/api/vault/status': { vaultPath: '/vault' }, '/api/search/status': { status: { state: 'ready' } } }[request.url ?? ''];
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('XR_TEST_')) delete process.env[key];
  cleanUp();
});
afterAll(() => {
  api.close();
  rmSync(home, { recursive: true, force: true });
});

/** A checkout whose node_modules/.bin/tsx runs the fake server with the arguments spawnServer passes. */
function fakeCheckout() {
  const checkout = temp('checkout');
  mkdirSync(path.join(checkout, 'node_modules', '.bin'), { recursive: true });
  const tsx = path.join(checkout, 'node_modules', '.bin', 'tsx');
  writeFileSync(tsx, `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIXTURES, 'fake-server.mjs')}" "$@"\n`);
  chmodSync(tsx, 0o755);
  return { checkout, tsx };
}

describe('restart', () => {
  it('keeps the slot and the run folder through a sweep between the old and the new server', async () => {
    const { main } = repository();
    const { checkout, tsx } = fakeCheckout();
    const runDir = path.join(runsRoot(main), '111-restart');
    mkdirSync(path.join(runDir, 'profile'), { recursive: true });
    writeFileSync(path.join(runDir, 'catalog.json'), '{}');
    const scratch = temp('sweep');
    Object.assign(process.env, {
      XR_TEST_LIB: LIB, XR_TEST_FROM: main,
      XR_TEST_SWEEP_ARMED: path.join(scratch, 'armed'), XR_TEST_SWEEP_RESULT: path.join(scratch, 'result.json'), XR_TEST_READY: scratch,
    });
    writeFileSync(process.env.XR_TEST_SWEEP_ARMED!, '');

    const record = {
      kind: 'web', issue: '111', runDir, evidence: temp('evidence'), checkout, data: 'synthetic', vault: 'selected',
      ports: { slot: 0 }, url, server: path.join(checkout, 'server.mts'),
    };
    mkdirSync(SLOT_LOCKS, { recursive: true });
    const first = start(tsx, [record.server, runMarker(runDir)], { detached: true });
    writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ ...record, pid: first.pid }));
    holdSlot(0, runDir, first.pid);
    // SIGTERM before the server's handler is installed would end it without the sweep.
    await until(() => existsSync(path.join(scratch, String(first.pid))));
    expect(runProcesses({ runDir }).map((member: { pid: number }) => member.pid)).toEqual([first.pid]);

    const instance = attach(runDir);
    try {
      await instance.restart();
    } finally {
      await terminateRun(runDir);
    }

    const sweep = JSON.parse(readFileSync(process.env.XR_TEST_SWEEP_RESULT!, 'utf8'));
    expect(alive(first.pid!)).toBe(false);
    expect(sweep.result.removed).toEqual([]);
    expect(lockLive(sweep.lockBefore)).toBe(true);
    expect(existsSync(path.join(runDir, 'profile'))).toBe(true);
    const lock = JSON.parse(readFileSync(path.join(SLOT_LOCKS, '0.json'), 'utf8'));
    expect(lock).toMatchObject({ slot: 0, runDir, pid: instance.pid });
    expect(lock.start).toBeTruthy();
    expect(instance.pid).not.toBe(first.pid);
    expect(readFileSync(path.join(runDir, 'server.log'), 'utf8')).toContain('--- verify restart (graceful)');
    expect(processStart(instance.pid)).toBeNull();
  }, 20_000);

  it('refuses a slot whose lock names another run and leaves that lock alone', async () => {
    const { main } = repository();
    const runDir = path.join(runsRoot(main), '111-taken');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      kind: 'web', issue: '111', runDir, evidence: temp('evidence'), checkout: temp('checkout'), ports: { slot: 0 }, url, pid: null,
    }));
    mkdirSync(SLOT_LOCKS, { recursive: true });
    const other = path.join(runsRoot(main), '111-other');
    holdSlot(0, other, process.pid);

    await expect(attach(runDir).restart()).rejects.toThrow('held by another run');
    expect(JSON.parse(readFileSync(path.join(SLOT_LOCKS, '0.json'), 'utf8'))).toMatchObject({ runDir: other, pid: process.pid });
  });
});
