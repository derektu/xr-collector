// Which process an engine record lets startup stop: the app reads the recorded process's command
// line (PowerShell on Windows, `ps` elsewhere) and stops it only while that line names the recorded
// binary and this database. A wrong reading ends someone else's process, or leaves an engine
// running while startup clears its search data. A stand-in process carries the command line, so
// these cases need no engine and run on every platform; Windows compares paths without case.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pidFilePath, stopLeftoverMeilisearchProcess } from '../../src/search/meilisearch-process.js';
import { eventually } from '../support/wait.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A database folder with a file in it, and a binary path that only has to appear in a command line. */
async function engineFiles(): Promise<{ binaryPath: string; databasePath: string; sentinel: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-meili-process-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const databasePath = path.join(root, 'search-data');
  const sentinel = path.join(databasePath, 'sentinel.txt');
  await mkdir(databasePath);
  await writeFile(sentinel, 'keep');
  return { binaryPath: path.join(root, process.platform === 'win32' ? 'meilisearch.exe' : 'meilisearch'), databasePath, sentinel };
}

/** Starts a process whose command line names the given arguments, as an engine's names its binary and database. */
async function standIn(...args: string[]): Promise<number> {
  // The stand-in ends itself after a minute, so a run cut short leaves nothing behind.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', '--', ...args], { stdio: 'ignore', windowsHide: true });
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('spawn', () => resolve(child.pid!));
    child.once('error', reject);
  });
  cleanups.push(async () => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  return pid;
}

async function record(pid: number, binaryPath: string, databasePath: string): Promise<string> {
  const serialized = `${JSON.stringify({ pid, binaryPath, databasePath })}\n`;
  await writeFile(pidFilePath(databasePath), serialized);
  return serialized;
}

describe('stopping the engine a killed app left behind', () => {
  it('stops the recorded process when its command line names the binary and this database', async () => {
    const { binaryPath, databasePath, sentinel } = await engineFiles();
    const pid = await standIn(binaryPath, '--db-path', databasePath);
    await record(pid, binaryPath, databasePath);

    await stopLeftoverMeilisearchProcess({ binaryPath, databasePath });

    await eventually(() => expect(alive(pid)).toBe(false));
    await expect(readFile(pidFilePath(databasePath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
  });

  it('leaves a process alone, and refuses to start, when its command line names another database', async () => {
    const { binaryPath, databasePath, sentinel } = await engineFiles();
    const pid = await standIn(binaryPath, '--db-path', path.join(path.dirname(databasePath), 'elsewhere'));
    const serialized = await record(pid, binaryPath, databasePath);

    await expect(stopLeftoverMeilisearchProcess({ binaryPath, databasePath })).rejects.toThrow(/Cannot prove process/u);

    expect(alive(pid)).toBe(true);
    expect(await readFile(pidFilePath(databasePath), 'utf8')).toBe(serialized);
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
  });

  it('leaves a process alone when its command line names another binary', async () => {
    const { binaryPath, databasePath } = await engineFiles();
    const pid = await standIn(path.join(path.dirname(binaryPath), 'other-engine'), '--db-path', databasePath);
    await record(pid, binaryPath, databasePath);

    await expect(stopLeftoverMeilisearchProcess({ binaryPath, databasePath })).rejects.toThrow(/Cannot prove process/u);
    expect(alive(pid)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('recognizes the engine when Windows reports its paths in another case', async () => {
    const { binaryPath, databasePath } = await engineFiles();
    const pid = await standIn(binaryPath.toUpperCase(), '--db-path', databasePath.toUpperCase());
    await record(pid, binaryPath, databasePath);

    await stopLeftoverMeilisearchProcess({ binaryPath, databasePath });

    await eventually(() => expect(alive(pid)).toBe(false));
  });
});
