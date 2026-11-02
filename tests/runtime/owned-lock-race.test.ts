import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, readdir, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withOwnedDirectoryLock } from '../../scripts/owned-directory-lock.mjs';

/**
 * Every file-system call the lock makes passes through `schedule.intercept`, tagged with the contender
 * whose async context issued it, so a test can hold one contender at a chosen step while another runs.
 */
type Step = { contender: string | undefined; name: string; target: string };
const schedule = vi.hoisted(() => ({
  contender: undefined as unknown as AsyncLocalStorage<string>,
  intercept: undefined as undefined | ((step: Step, run: () => Promise<unknown>) => Promise<unknown>),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const { AsyncLocalStorage: Storage } = await import('node:async_hooks');
  schedule.contender = new Storage<string>();
  const names = ['lstat', 'mkdir', 'readFile', 'readdir', 'rename', 'rm', 'rmdir', 'unlink', 'writeFile'] as const;
  const wrapped = Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => {
    const run = () => (actual[name] as (...values: unknown[]) => Promise<unknown>)(...args);
    const intercept = schedule.intercept;
    return intercept ? intercept({ contender: schedule.contender.getStore(), name, target: String(args[0]) }, run) : run();
  }]));
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});

const roots: string[] = [];
afterEach(async () => {
  schedule.intercept = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const uid = process.getuid?.() ?? 501;
async function lockRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-owned-lock-schedule-'));
  roots.push(root);
  return path.join(root, 'lock');
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
const liveOwner = async (pid: number) => ({ pid, uid, startedAt: 'current' });
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

/**
 * Both reapers read the dead owner, then: first unlinks it, removes the directory and creates its own;
 * second's unlink of the same path reports success; second finishes reaping and reaches its next mkdir;
 * only then does first inspect the directory it created, and second's mkdir runs after that inspection.
 */
it('lets one of two stale-owner reapers acquire and reports the other busy when both unlinks succeed', async () => {
  const lock = await lockRoot();
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), JSON.stringify({ pid: 41, uid, startedAt: 'dead', token: 'a1' }), { mode: 0o600 });
  const staleOwner = path.join(lock, 'owner-a1.json');
  let inspected = 0;
  const bothInspected = gate();
  const inspectOwner = async (pid: number) => {
    if (pid !== 41) return liveOwner(pid);
    if (++inspected === 2) bothInspected.open();
    await bothInspected.opened;
    return null;
  };
  const firstCreated = gate();
  const secondReaped = gate();
  const firstClaimChecked = gate();
  let firstMkdirs = 0;
  let firstClaimHeld = false;
  let secondUnlinked = false;
  schedule.intercept = async ({ contender, name, target }, run) => {
    if (contender === 'first' && name === 'mkdir' && target === lock) {
      const result = run();
      await result.catch(() => {});
      if (++firstMkdirs === 2) firstCreated.open();
      return result;
    }
    if (contender === 'first' && name === 'lstat' && target === lock && firstMkdirs === 2 && !firstClaimHeld) {
      firstClaimHeld = true;
      await secondReaped.opened;
      const result = run();
      result.catch(() => {}).finally(firstClaimChecked.open);
      return result;
    }
    if (contender === 'second' && name === 'unlink' && target === staleOwner) {
      // The first reaper has already removed this file and created its replacement directory. macOS
      // still reports success to a concurrent unlink of the same path, which this step reproduces.
      await firstCreated.opened;
      secondUnlinked = true;
      return undefined;
    }
    if (contender === 'second' && name === 'mkdir' && target === lock && secondUnlinked) {
      secondReaped.open();
      await firstClaimChecked.opened;
    }
    return run();
  };
  const workGate = gate();
  const entered: string[] = [];
  const contender = (label: string, token: string) => schedule.contender.run(label, () => withOwnedDirectoryLock(lock, async () => {
    entered.push(label);
    await workGate.opened;
    return label;
  }, lockOptions(token, inspectOwner)));
  const first = contender('first', 'b2');
  const second = contender('second', 'c3');
  second.catch(() => {}).finally(secondReaped.open);
  const loser = await Promise.race([first.then(() => null, (error) => error), second.then(() => null, (error) => error)]);
  expect(String(loser)).toBe('Error: busy');
  workGate.open();
  await expect(first).resolves.toBe('first');
  await expect(second).rejects.toThrow(/^busy$/u);
  expect(entered).toEqual(['first']);
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('starts over when its new directory is removed before the owner nonce is written', async () => {
  const lock = await lockRoot();
  let removed = false;
  schedule.intercept = async ({ name, target }, run) => {
    if (!removed && name === 'lstat' && target === lock) {
      removed = true;
      await rmdir(lock);
    }
    return run();
  };
  await expect(withOwnedDirectoryLock(lock, async () => 'acquired', lockOptions('b2', liveOwner))).resolves.toBe('acquired');
  expect(removed).toBe(true);
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports busy and leaves a replacement directory created by a competitor before the owner nonce is written', async () => {
  const lock = await lockRoot();
  let replaced = false;
  schedule.intercept = async ({ name, target }, run) => {
    if (!replaced && name === 'writeFile' && target === path.join(lock, 'owner-b2.json')) {
      replaced = true;
      await rmdir(lock);
      await mkdir(lock, { mode: 0o700 });
    }
    return run();
  };
  await expect(withOwnedDirectoryLock(lock, async () => 'acquired', lockOptions('b2', liveOwner))).rejects.toThrow(/^busy$/u);
  expect(await readdir(lock)).toEqual([]);
});

it('fails with the write error while its new directory is still in place', async () => {
  const lock = await lockRoot();
  let writes = 0;
  schedule.intercept = async ({ name, target }, run) => {
    if (name === 'writeFile' && target === path.join(lock, 'owner-b2.json')) {
      writes += 1;
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return run();
  };
  await expect(withOwnedDirectoryLock(lock, async () => 'acquired', lockOptions('b2', liveOwner))).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(writes).toBe(1);
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

/** A lock held by a live owner, pid 41, as `withOwnedDirectoryLock` leaves it while work runs. */
async function heldLock(extraEntries: string[] = [], ownerContent = JSON.stringify({ pid: 41, uid, startedAt: 'holder', token: 'a1' })) {
  const lock = await lockRoot();
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), ownerContent, { mode: 0o600 });
  for (const entry of extraEntries) await writeFile(path.join(lock, entry), ownerContent, { mode: 0o600 });
  return lock;
}
const holderAlive = async (pid: number) => (pid === 41 ? { pid, uid, startedAt: 'holder' } : liveOwner(pid));

it('acquires when the holder releases between listing the lock and reading its owner file', async () => {
  const lock = await heldLock();
  let released = false;
  schedule.intercept = async ({ name, target }, run) => {
    if (!released && name === 'lstat' && target === path.join(lock, 'owner-a1.json')) {
      released = true;
      await rm(path.join(lock, 'owner-a1.json'));
      await rmdir(lock);
    }
    return run();
  };
  await expect(withOwnedDirectoryLock(lock, async () => 'acquired', lockOptions('b2', holderAlive))).resolves.toBe('acquired');
  expect(released).toBe(true);
});

it('reports busy while a live holder replaces its owner file, and fails on an update file left by a dead owner', async () => {
  const updating = await heldLock(['owner-a1.json.update-ff']);
  await expect(withOwnedDirectoryLock(updating, async () => 'acquired', lockOptions('b2', holderAlive))).rejects.toThrow(/^busy$/u);
  const interrupted = await heldLock(['owner-a1.json.update-ff']);
  await expect(withOwnedDirectoryLock(interrupted, async () => 'acquired', lockOptions('b2', async () => null)))
    .rejects.toThrow(/ambiguous owner metadata/u);
  expect((await readdir(interrupted)).sort()).toEqual(['owner-a1.json', 'owner-a1.json.update-ff']);
});

it('reports busy for an owner file not yet written, and fails on one that stays empty past the grace period', async () => {
  const opening = await heldLock([], '');
  await expect(withOwnedDirectoryLock(opening, async () => 'acquired', lockOptions('b2', holderAlive))).rejects.toThrow(/^busy$/u);
  const abandoned = await heldLock([], '');
  const longAgo = new Date(Date.now() - 60_000);
  await utimes(abandoned, longAgo, longAgo);
  await expect(withOwnedDirectoryLock(abandoned, async () => 'acquired', lockOptions('b2', holderAlive)))
    .rejects.toThrow(/invalid owner metadata/u);
});
