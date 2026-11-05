// The packaging scripts' directory lock: one run at a time owns a checkout or keychain, so two runs
// never mix into one installer. Creating the lock directory is the only step that takes the lock;
// a lock whose holder has ended is reported with its path and never removed, and a lock whose
// holder or recorded child processes may still run reports busy. An aborted run ends its whole
// process tree. POSIX-only cases skip Windows.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error The script is executable JavaScript without type declarations.
import { withOwnedDirectoryLock } from '../../scripts/owned-directory-lock.mjs';
// @ts-expect-error The script is executable JavaScript without type declarations.
import { runOwnedProcess, terminateOwnedProcessTree, UnsafeProcessTreeError } from '../../scripts/owned-process.mjs';
import { eventually } from '../support/wait.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const uid = process.getuid?.() ?? 501;
async function lockRoot(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function lockOptions(token: string, inspectOwner: (pid: number) => Promise<unknown>) {
  return {
    ownerIdentity: async () => ({ pid: process.pid, uid, startedAt: 'current' }),
    inspectOwner,
    inspectUnsafeTree: async () => false,
    waitForBusy: false,
    busyMessage: 'busy',
    randomToken: () => token,
  };
}
/** A lock in `root` whose recorded owner, pid 41, is dead, as a killed run leaves it. */
async function staleLock(root: string, name: string, owner: Record<string, unknown> = {}) {
  const lock = path.join(root, name);
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), JSON.stringify({ pid: 41, uid, startedAt: 'dead', token: 'a1', ...owner }), { mode: 0o600 });
  return lock;
}
async function snapshot(lock: string) {
  const entries = (await readdir(lock)).sort();
  return Promise.all(entries.map(async (entry) => [entry, await readFile(path.join(lock, entry), 'utf8')]));
}

/**
 * Each child process loads the lock, prints `ready` and waits for a line on stdin; then it tries the
 * lock once without waiting. The one that takes it prints `acquired` and holds it until its stdin
 * closes; the other prints its error message.
 */
const contenderScript = `
  import { createInterface } from 'node:readline';
  const [moduleUrl, lock] = process.argv.slice(1);
  const { withOwnedDirectoryLock } = await import(moduleUrl);
  const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const uid = process.getuid?.() ?? 501;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  console.log('ready');
  await input.next();
  try {
    await withOwnedDirectoryLock(lock, async () => {
      console.log('acquired');
      await input.next();
    }, {
      ownerIdentity: async () => ({ pid: process.pid, uid, startedAt: 'contender' }),
      inspectOwner: async (pid) => alive(pid) ? { pid, uid, startedAt: 'contender' } : null,
      inspectUnsafeTree: async () => false,
      waitForBusy: false,
      busyMessage: 'busy',
    });
  } catch (error) { console.log(error.message); }
  process.exit(0);
`;
function runContender(lock: string) {
  const moduleUrl = pathToFileURL(path.resolve('scripts/owned-directory-lock.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', contenderScript, moduleUrl, lock], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => {});
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    lines: () => output.trim().split('\n'),
    go: () => child.stdin.write('go\n'),
    release: () => child.stdin.end(),
    exited,
    kill: () => child.kill(),
  };
}

it('lets one of two processes started together take the lock, reports the other busy, and takes it again after release', async () => {
  const root = await lockRoot('xr-owned-lock-contenders-');
  const lock = path.join(root, 'lock');
  const contenders = [runContender(lock), runContender(lock)];
  try {
    await eventually(() => expect(contenders.map((contender) => contender.lines())).toEqual([['ready'], ['ready']]));
    for (const contender of contenders) contender.go();
    await eventually(() => expect(contenders.map((contender) => contender.lines()[1]).sort()).toEqual(['acquired', 'busy']));
    for (const contender of contenders) contender.release();
    await Promise.all(contenders.map((contender) => contender.exited));
  } finally {
    for (const contender of contenders) contender.kill();
  }
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(withOwnedDirectoryLock(lock, async () => 'acquired', lockOptions('b2', async () => null))).resolves.toBe('acquired');
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports a lock whose holder and recorded child processes have ended, naming the holder and how to delete it, and leaves it in place', async () => {
  const root = await lockRoot('xr-owned-lock-left-');
  const endedChild = { platform: 'darwin', pid: 4343, kind: 'posix-process-group' };
  const owners = { plain: {}, active: { processState: { status: 'active', processTree: endedChild } }, unsafe: { unsafeProcessTree: endedChild } };
  for (const [name, owner] of Object.entries(owners)) {
    const lock = await staleLock(root, name, owner);
    const before = await snapshot(lock);
    const failure = await withOwnedDirectoryLock(lock, async () => 'acquired', lockOptions('b2', async () => null)).catch((error: any) => error);
    expect(failure).toMatchObject({ code: 'OWNED_LOCK_LEFT_BEHIND', lockPath: lock });
    expect(failure.message).toContain(`Owned lock ${lock} was left by process 41 (started dead)`);
    expect(failure.message).toContain('not removed automatically');
    expect(failure.message).toContain(`then delete it with: ${process.platform === 'win32' ? `Remove-Item -LiteralPath '${lock}' -Recurse` : `rm -r '${lock}'`}`);
    expect(await snapshot(lock)).toEqual(before);
  }
});

it('reports a lock directory that never received an owner record once its creation grace has passed, and leaves it in place', async () => {
  const root = await lockRoot('xr-owned-lock-ownerless-');
  const lock = path.join(root, 'lock');
  await mkdir(lock, { mode: 0o700 });
  const ownerGraceMs = 60_000;
  await expect(withOwnedDirectoryLock(lock, async () => 'acquired', { ...lockOptions('b2', async () => null), ownerGraceMs }))
    .rejects.toThrow(/^busy$/u);
  // The directory's time moves back past the grace rather than the grace shrinking to 0 ms: a
  // directory's time can read up to a clock tick ahead of Date.now(), most visibly on Windows,
  // and a just-created lock then still counts as within a 0 ms grace.
  const created = new Date(Date.now() - 2 * ownerGraceMs);
  await utimes(lock, created, created);
  await expect(withOwnedDirectoryLock(lock, async () => 'acquired', { ...lockOptions('b2', async () => null), ownerGraceMs }))
    .rejects.toMatchObject({ code: 'OWNED_LOCK_LEFT_BEHIND', message: expect.stringContaining('has had no owner record') });
  expect(await readdir(lock)).toEqual([]);
});

it('leaves the lock in place when its own was deleted and another run took the path while it was held', async () => {
  const root = await lockRoot('xr-owned-lock-replaced-');
  const lock = path.join(root, 'lock');
  const failure = await withOwnedDirectoryLock(lock, async () => {
    await rm(lock, { recursive: true });
    await staleLock(root, 'lock');
  }, lockOptions('b2', async () => null)).catch((error: any) => error);
  expect(failure.message).toBe(`Owned lock ${lock} no longer holds this run's owner record; it was removed while held and is left as found.`);
  expect(await readdir(lock)).toEqual(['owner-a1.json']);
});

const quotes = "it's-\u2018\u2019\u201A\u201B";

it('quotes the PowerShell delete command, including the typographic quotes PowerShell also reads as single quotes', async () => {
  const lock = await staleLock(await lockRoot(`xr-owned-lock-${quotes}-`), 'lock');
  await expect(withOwnedDirectoryLock(lock, async () => 'acquired', { ...lockOptions('b2', async () => null), platform: 'win32' }))
    .rejects.toThrow(`Remove-Item -LiteralPath '${lock.replace(quotes, "it''s-\u2018\u2018\u2019\u2019\u201A\u201A\u201B\u201B")}' -Recurse`);
});

// The POSIX lock checks owner-only permission bits, which a Windows directory does not carry.
it.skipIf(process.platform === 'win32')('quotes the POSIX delete command', async () => {
  const lock = await staleLock(await lockRoot(`xr-owned-lock-${quotes}-`), 'lock');
  await expect(withOwnedDirectoryLock(lock, async () => 'acquired', { ...lockOptions('b2', async () => null), platform: 'darwin' }))
    .rejects.toThrow(`rm -r '${lock.replace(quotes, "it'\\''s-\u2018\u2019\u201A\u201B")}'`);
});

/**
 * Lock options whose first `failures` owner inspections fail with EPERM, as while a holder's release
 * is deleting the lock on Windows; `delays` records every wait between attempts.
 */
function pendingDeleteOptions(platform: string, failures: number, delays: number[]) {
  let inspected = 0;
  return {
    ...lockOptions('b2', async () => {
      inspected += 1;
      if (inspected <= failures) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return null;
    }),
    platform,
    delay: async (milliseconds: number) => { delays.push(milliseconds); },
  };
}

it('waits out a bounded number of Windows pending-delete EPERM failures', async () => {
  const root = await lockRoot('xr-owned-lock-pending-delete-');
  const recovered: number[] = [];
  await expect(withOwnedDirectoryLock(await staleLock(root, 'recovers'), async () => 'acquired',
    pendingDeleteOptions('win32', 3, recovered))).rejects.toMatchObject({ code: 'OWNED_LOCK_LEFT_BEHIND' });
  expect(recovered).toEqual([10, 10, 10]);

  const persistent: number[] = [];
  await expect(withOwnedDirectoryLock(await staleLock(root, 'persistent'), async () => 'acquired',
    pendingDeleteOptions('win32', Infinity, persistent))).rejects.toMatchObject({ code: 'EPERM' });
  expect(persistent).toHaveLength(50);
});

// A POSIX lock checks owner-only permission bits, which a Windows directory does not carry.
it.skipIf(process.platform === 'win32')('fails on EPERM at once outside Windows', async () => {
  const root = await lockRoot('xr-owned-lock-pending-delete-');
  const delays: number[] = [];
  await expect(withOwnedDirectoryLock(await staleLock(root, 'posix'), async () => 'acquired',
    pendingDeleteOptions('darwin', 1, delays))).rejects.toMatchObject({ code: 'EPERM' });
  expect(delays).toEqual([]);
});

it('records an unverified process tree and reports busy while it may still write', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-lock-unsafe-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  const tree = { platform: 'darwin', pid: 4242, kind: 'posix-process-group' };
  await expect(withOwnedDirectoryLock(lock, async () => {
    throw new UnsafeProcessTreeError('tree still active', tree);
  }, {
    ownerIdentity: async () => ({ pid: 41, uid, startedAt: 'owner' }),
    inspectOwner: async () => null,
    inspectUnsafeTree: async () => true,
    waitForBusy: false,
    busyMessage: 'busy',
    randomToken: () => 'a1',
  })).rejects.toBeInstanceOf(UnsafeProcessTreeError);
  const [ownerName] = await readdir(lock);
  expect(JSON.parse(await readFile(path.join(lock, ownerName!), 'utf8'))).toMatchObject({ unsafeProcessTree: tree });
  await expect(withOwnedDirectoryLock(lock, async () => undefined, {
    ownerIdentity: async () => ({ pid: 42, uid, startedAt: 'next' }),
    inspectOwner: async () => null,
    inspectUnsafeTree: async () => true,
    waitForBusy: false,
    busyMessage: 'unsafe tree is still active',
    randomToken: () => 'b2',
  })).rejects.toThrow(/unsafe tree is still active/u);
});

it('reports busy for a dead holder whose normally recorded child group is still active', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-lock-active-child-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  const processTree = { platform: 'darwin', pid: 4343, kind: 'posix-process-group' };
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), JSON.stringify({
    pid: 41, uid, startedAt: 'dead', token: 'a1', processState: { status: 'active', processTree },
  }), { mode: 0o600 });
  await expect(withOwnedDirectoryLock(lock, async () => undefined, {
    ownerIdentity: async () => ({ pid: 42, uid, startedAt: 'next' }),
    inspectOwner: async () => null,
    inspectUnsafeTree: async (recorded: unknown) => { expect(recorded).toEqual(processTree); return true; },
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
    ownerIdentity: async () => ({ pid: process.pid, uid: process.getuid!(), startedAt: 'current' }),
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

it.skipIf(process.platform === 'win32')('rejects and preserves its lock when normal child close cannot inspect the process group', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-process-probe-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  const uid = process.getuid?.() ?? 501;
  await expect(withOwnedDirectoryLock(lock, (processTracker: unknown) => runOwnedProcess(process.execPath, ['-e', 'process.exit(0)'], {
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
