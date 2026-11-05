// Guards the developer, not the user: a packaging or signing run that reads the directory lock at
// the moment its holder writes, rewrites or releases its owner record still reports busy, takes the
// lock, or names the lock left behind, and one that cannot write its own record leaves no lock. When
// this breaks, a developer packaging while another run finishes sees a spurious metadata error or a
// lock that blocks every later run until deleted by hand.
import { mkdir, mkdtemp, readdir, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error The script is executable JavaScript without type declarations.
import { withOwnedDirectoryLock } from '../../scripts/owned-directory-lock.mjs';

/**
 * Every file-system call the lock makes passes through `schedule.intercept`, so a test can change the
 * lock, as its holder would, at a chosen step of another process's inspection or acquisition.
 */
type Step = { name: string; target: string };
const schedule = vi.hoisted(() => ({
  intercept: undefined as undefined | ((step: Step, run: () => Promise<unknown>) => Promise<unknown>),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const names = ['lstat', 'mkdir', 'readFile', 'readdir', 'rename', 'rm', 'rmdir', 'unlink', 'writeFile'] as const;
  const wrapped = Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => {
    const run = () => (actual[name] as (...values: unknown[]) => Promise<unknown>)(...args);
    const intercept = schedule.intercept;
    return intercept ? intercept({ name, target: String(args[0]) }, run) : run();
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
/** A lock held by a live owner, pid 41, as `withOwnedDirectoryLock` leaves it while work runs. */
async function heldLock(extraEntries: string[] = [], ownerContent = JSON.stringify({ pid: 41, uid, startedAt: 'holder', token: 'a1' })) {
  const lock = await lockRoot();
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), ownerContent, { mode: 0o600 });
  for (const entry of extraEntries) await writeFile(path.join(lock, entry), ownerContent, { mode: 0o600 });
  return lock;
}
const holderAlive = async (pid: number) => (pid === 41 ? { pid, uid, startedAt: 'holder' } : liveOwner(pid));

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

it('reports busy while a live holder replaces its owner file, and reports the lock left behind with an update file by a dead owner', async () => {
  const updating = await heldLock(['owner-a1.json.update-ff']);
  await expect(withOwnedDirectoryLock(updating, async () => 'acquired', lockOptions('b2', holderAlive))).rejects.toThrow(/^busy$/u);
  const interrupted = await heldLock(['owner-a1.json.update-ff']);
  await expect(withOwnedDirectoryLock(interrupted, async () => 'acquired', lockOptions('b2', async () => null)))
    .rejects.toMatchObject({ code: 'OWNED_LOCK_LEFT_BEHIND' });
  expect((await readdir(interrupted)).sort()).toEqual(['owner-a1.json', 'owner-a1.json.update-ff']);
});

it('reports busy for an owner file not yet written, reports one that stays empty past the grace period as left behind, and fails on a corrupt one', async () => {
  const opening = await heldLock([], '');
  await expect(withOwnedDirectoryLock(opening, async () => 'acquired', { ...lockOptions('b2', holderAlive), ownerGraceMs: 60_000 }))
    .rejects.toThrow(/^busy$/u);
  const corrupt = await heldLock([], '{"pid":');
  await expect(withOwnedDirectoryLock(corrupt, async () => 'acquired', { ...lockOptions('b2', holderAlive), ownerGraceMs: 60_000 }))
    .rejects.toThrow(/invalid owner metadata/u);
  const abandoned = await heldLock([], '');
  const longAgo = new Date(Date.now() - 60_000);
  await utimes(abandoned, longAgo, longAgo);
  const failure = await withOwnedDirectoryLock(abandoned, async () => 'acquired', lockOptions('b2', holderAlive)).catch((error: any) => error);
  expect(failure).toMatchObject({ code: 'OWNED_LOCK_LEFT_BEHIND', lockPath: abandoned });
  expect(failure.message).toContain(`Owned lock ${abandoned} has had an empty owner record for `);
  expect(failure.message).toContain('the process that created it ended before recording itself');
  expect(failure.message).toContain('then delete it with: ');
  expect(await readdir(abandoned)).toEqual(['owner-a1.json']);
});
