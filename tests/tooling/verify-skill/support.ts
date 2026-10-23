// Fixtures for the verify skill's own tests: throwaway Git checkouts, a throwaway HOME for the slot
// locks, and real processes that are always ended when a test finishes.
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const LIB = path.resolve(import.meta.dirname, '../../../.claude/skills/verify/scripts/lib');

const roots: string[] = [];
const children: ChildProcess[] = [];

/** A new empty directory, real path (macOS tmpdir is a symlink, Git reports real paths). */
export function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `xr-verify-${prefix}-`)));
  roots.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=verify-test', '-c', 'user.email=verify-test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

/** A main checkout with one commit and a linked worktree of it: { main, worktree }. */
export function repository() {
  const root = temp('repo');
  const main = path.join(root, 'main');
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'start');
  const worktree = path.join(root, 'worktree');
  git(main, 'worktree', 'add', '-q', worktree);
  return { main, worktree };
}

/**
 * Points HOME at a new directory, so `SLOT_LOCKS` (~/.xr-collector/verify-slots) of a library
 * imported afterwards never names the machine's real slot locks. Call before importing the library;
 * the directory lives for the whole test file, so remove it in afterAll.
 */
export function isolateHome() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'xr-verify-home-')));
  process.env.HOME = home;
  return home;
}

/** Spawns a process that is killed, with its process group when detached, after the test. */
export function start(command: string, args: string[], options: SpawnOptions = {}) {
  const child = spawn(command, args, { stdio: 'ignore', ...options });
  children.push(child);
  return child;
}

/** Polls `check` every 20 ms until it holds; fails after `timeout` ms. */
export async function until(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Command lines of every process that mentions `text`, as `ps` reports them. */
export const mentioning = (text: string) => execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  .split('\n').filter((line) => line.includes(text));

/** The PID of a process that has already exited. */
export async function deadPid() {
  const child = start(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Ends every process `start` spawned and removes every directory `temp` made. */
export function cleanUp() {
  for (const child of children.splice(0)) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a group leader, or gone */ }
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}
