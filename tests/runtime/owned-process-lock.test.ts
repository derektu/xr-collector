import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withOwnedDirectoryLock } from '../../scripts/owned-directory-lock.mjs';
import { runOwnedProcess, terminateOwnedProcessTree, UnsafeProcessTreeError } from '../../scripts/owned-process.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('allows only one of two synchronized stale-owner reapers to acquire the replacement lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-lock-race-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  const uid = process.getuid?.() ?? 501;
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), JSON.stringify({ pid: 41, uid, startedAt: 'dead', token: 'a1' }), { mode: 0o600 });
  let inspected = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  const inspectOwner = async (pid: number) => {
    if (pid === 41) {
      inspected += 1;
      if (inspected === 2) releaseBarrier();
      await barrier;
      return null;
    }
    return { pid, uid, startedAt: 'current' };
  };
  let releaseWork!: () => void;
  const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
  const entered: string[] = [];
  const contender = (label: string, token: string) => withOwnedDirectoryLock(lock, async () => {
    entered.push(label);
    await workGate;
    return label;
  }, {
    ownerIdentity: async () => ({ pid: process.pid, uid, startedAt: 'current' }),
    inspectOwner,
    inspectUnsafeTree: async () => false,
    waitForBusy: false,
    busyMessage: 'busy',
    randomToken: () => token,
  });
  const first = contender('first', 'b2');
  const second = contender('second', 'c3');
  const loser = await Promise.race([
    first.then(() => null, (error) => error),
    second.then(() => null, (error) => error),
  ]);
  expect(loser).toBeInstanceOf(Error);
  expect(String(loser)).toMatch(/busy/u);
  const enteredDeadline = Date.now() + 1_000;
  while (entered.length === 0 && Date.now() < enteredDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(entered).toHaveLength(1);
  releaseWork();
  const results = await Promise.allSettled([first, second]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('records an unverified process tree and refuses stale-owner recovery while it may still write', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-lock-unsafe-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  const tree = { platform: 'darwin', pid: 4242, kind: 'posix-process-group' };
  await expect(withOwnedDirectoryLock(lock, async () => {
    throw new UnsafeProcessTreeError('tree still active', tree);
  }, {
    ownerIdentity: async () => ({ pid: 41, uid: 501, startedAt: 'owner' }),
    inspectOwner: async () => null,
    inspectUnsafeTree: async () => true,
    waitForBusy: false,
    busyMessage: 'busy',
    randomToken: () => 'a1',
  })).rejects.toBeInstanceOf(UnsafeProcessTreeError);
  const [ownerName] = await readdir(lock);
  expect(JSON.parse(await readFile(path.join(lock, ownerName!), 'utf8'))).toMatchObject({ unsafeProcessTree: tree });
  await expect(withOwnedDirectoryLock(lock, async () => undefined, {
    ownerIdentity: async () => ({ pid: 42, uid: 501, startedAt: 'next' }),
    inspectOwner: async () => null,
    inspectUnsafeTree: async () => true,
    waitForBusy: false,
    busyMessage: 'unsafe tree is still active',
    randomToken: () => 'b2',
  })).rejects.toThrow(/unsafe tree is still active/u);
});

it('does not reclaim a dead parent lock whose normally recorded child group is still active', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-lock-active-child-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  const uid = process.getuid?.() ?? 501;
  const processTree = { platform: 'darwin', pid: 4343, kind: 'posix-process-group' };
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), JSON.stringify({
    pid: 41, uid, startedAt: 'dead', token: 'a1', processState: { status: 'active', processTree },
  }), { mode: 0o600 });
  await expect(withOwnedDirectoryLock(lock, async () => undefined, {
    ownerIdentity: async () => ({ pid: 42, uid, startedAt: 'next' }),
    inspectOwner: async () => null,
    inspectUnsafeTree: async (recorded) => { expect(recorded).toEqual(processTree); return true; },
    waitForBusy: false,
    busyMessage: 'recorded writer remains active',
    randomToken: () => 'b2',
  })).rejects.toThrow(/recorded writer remains active/u);
  await expect(stat(path.join(lock, 'owner-a1.json'))).resolves.toBeDefined();
});

it.skipIf(process.platform === 'win32')('fails closed on legacy files and symlink locks without touching their targets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-lock-path-'));
  roots.push(root);
  const legacy = path.join(root, 'legacy.lock');
  await writeFile(legacy, 'old file protocol');
  const options = {
    ownerIdentity: async () => ({ pid: process.pid, uid: process.getuid(), startedAt: 'current' }),
    inspectOwner: async () => null,
    inspectUnsafeTree: async () => false,
    waitForBusy: false,
    busyMessage: 'busy',
    randomToken: () => 'a1',
  };
  await expect(withOwnedDirectoryLock(legacy, async () => undefined, options)).rejects.toThrow(/non-symlink directory/u);
  expect(await readFile(legacy, 'utf8')).toBe('old file protocol');

  const external = path.join(root, 'external');
  const linked = path.join(root, 'linked.lock');
  await mkdir(external);
  await writeFile(path.join(external, 'owner-b2.json'), 'outside');
  await symlink(external, linked);
  await expect(withOwnedDirectoryLock(linked, async () => undefined, options)).rejects.toThrow(/non-symlink directory/u);
  expect(await readFile(path.join(external, 'owner-b2.json'), 'utf8')).toBe('outside');
});

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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await stat(state); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
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

it.skipIf(process.platform === 'win32')('rejects and preserves its lock when normal child close cannot inspect the process group', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-process-probe-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  const uid = process.getuid?.() ?? 501;
  await expect(withOwnedDirectoryLock(lock, (processTracker) => runOwnedProcess(process.execPath, ['-e', 'process.exit(0)'], {
    processTracker,
    groupExists: () => { throw new Error('process-group probe denied'); },
  }), {
    ownerIdentity: async () => ({ pid: process.pid, uid, startedAt: 'current' }),
    inspectOwner: async () => ({ pid: process.pid, uid, startedAt: 'current' }),
    inspectUnsafeTree: async () => null,
    waitForBusy: false,
    busyMessage: 'busy',
    randomToken: () => 'a1',
  })).rejects.toMatchObject({ name: 'UnsafeProcessTreeError', preserveOwnedResources: true });
  const [ownerName] = await readdir(lock);
  expect(JSON.parse(await readFile(path.join(lock, ownerName!), 'utf8'))).toMatchObject({
    processState: { status: 'active' },
    unsafeProcessTree: { kind: 'posix-process-group' },
  });
});
