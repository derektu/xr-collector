// The packaging scripts' child processes: an aborted run ends its whole process tree, so a killed
// packaging run leaves no child or grandchild still writing into the checkout, and a tree it cannot
// confirm ended is reported as unsafe without waiting for it. POSIX-only cases skip Windows.
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runOwnedProcess, terminateOwnedProcessTree } from '../../../scripts/lib/owned-process.mjs';
import { eventually } from '../../support/wait.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('kills a detached POSIX child and its grandchild before reporting abort', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-process-tree-'));
  roots.push(root);
  const state = path.join(root, 'pids.json');
  const script = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(state)}, JSON.stringify({ parent: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  `;
  const controller = new AbortController();
  const tracking: string[] = [];
  const running = runOwnedProcess(process.execPath, ['-e', script], {
    signal: controller.signal,
    processTracker: {
      beforeSpawn: async () => { tracking.push('starting'); },
      started: async () => { tracking.push('active'); },
      finished: async () => { tracking.push('finished'); },
    },
  });
  await eventually(() => stat(state));
  const pids = JSON.parse(await readFile(state, 'utf8')) as { parent: number; child: number };
  controller.abort(new Error('test abort'));
  await expect(running).rejects.toThrow(/test abort/u);
  expect(tracking).toEqual(['starting', 'active', 'finished']);
  for (const pid of [pids.parent, pids.child]) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

it('uses taskkill tree semantics on Windows and reports an unconfirmed tree without waiting for close', async () => {
  const runTaskkill = vi.fn(async () => undefined);
  await terminateOwnedProcessTree(4242, { platform: 'win32', runTaskkill });
  expect(runTaskkill).toHaveBeenCalledWith(4242, expect.objectContaining({ platform: 'win32' }));

  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), { pid: 4343, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const running = runOwnedProcess('fixture.exe', [], {
    platform: 'win32', signal: controller.signal, spawn: () => child,
    runTaskkill: async () => { throw new Error('access denied'); },
  });
  controller.abort(new Error('stop'));
  await expect(running).rejects.toMatchObject({ name: 'UnsafeProcessTreeError', preserveOwnedResources: true,
    processTree: { platform: 'win32', pid: 4343, kind: 'windows-tree' } });
});
