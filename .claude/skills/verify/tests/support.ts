// Fixtures for the verify skill's own tests: throwaway Git checkouts, a throwaway HOME for the slot
// locks, and real processes that are always ended when a test finishes.
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const roots: string[] = [];
const children: ChildProcess[] = [];

/**
 * A new empty directory, by the real path Git reports: macOS tmpdir is a symlink, and a Windows
 * tmpdir can hold an 8.3 short name (`C:\Users\DEREKT~1.INH`), which only the native realpath expands.
 */
export function temp(prefix: string) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), `xr-verify-${prefix}-`)));
  roots.push(dir);
  return dir;
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=verify-test', '-c', 'user.email=verify-test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

/** A checkout with one commit of a tracked source file, and .local/ ignored as in the repository. */
export function repository() {
  const checkout = temp('repo');
  git(checkout, 'init', '-q');
  writeFileSync(path.join(checkout, '.gitignore'), '.local/\n');
  writeFileSync(path.join(checkout, 'source.ts'), 'export const value = 1;\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'start');
  return checkout;
}

/**
 * Points the home directory (HOME, and USERPROFILE, which Windows reads) at a new directory, so
 * `SLOT_LOCKS` (~/.xr-collector/verify-slots) of a library imported afterwards never names the
 * machine's real slot locks. Call before importing the library; the directory lives for the whole
 * test file, so remove it in afterAll.
 */
export function isolateHome() {
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'xr-verify-home-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

/** Spawns a process that is killed, with its process group when detached, after the test. */
export function start(command: string, args: string[], options: SpawnOptions = {}) {
  const child = spawn(command, args, { stdio: 'ignore', ...options });
  children.push(child);
  return child;
}

/** The PID of a process that has already exited. */
export async function deadPid() {
  const child = start(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Ends every process `start` spawned, with the processes it started (its process group, or on
 * Windows its process tree), and removes every directory `temp` made.
 */
export function cleanUp() {
  for (const child of children.splice(0)) {
    if (!child.pid) continue;
    if (process.platform === 'win32') {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a group leader, or gone */ }
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  // Windows keeps a program's file locked for a moment after taskkill returns, so removal retries.
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
