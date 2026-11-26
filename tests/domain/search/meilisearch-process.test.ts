// Which process an engine record lets startup stop on macOS: the recorded process, only while it
// runs the engine's executable. A wrong reading ends someone else's process whose number was reused,
// or leaves an engine running on the database the new engine needs. The record is always cleared, so
// a stale or broken record never blocks search, and an engine that ignores SIGTERM is killed once the
// stop wait runs out, so startup never hangs on it. A stand-in Node process plays the engine by naming
// Node's executable as the engine binary, so these cases need no engine.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { pidFilePath, stopLeftoverMeilisearchProcess } from '../../../src/domain/search/meilisearch-process.js';
import { eventually } from '../../support/wait.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function standIn(): Promise<number> {
  // The stand-in ends itself after a minute, so a run cut short leaves nothing behind.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore', windowsHide: true });
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('spawn', () => resolve(child.pid!));
    child.once('error', reject);
  });
  cleanups.push(async () => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  return pid;
}

it.skipIf(process.platform === 'win32').each([
  ['stops the recorded process while it runs the engine executable', process.execPath, 'pid', false],
  ['leaves the recorded process alone when it runs another executable', path.resolve('meilisearch'), 'pid', true],
  ['clears a record that holds no process number', process.execPath, 'broken', true],
] as const)('%s, clears the record and keeps the search data', async (_rule, binaryPath, record, standInAlive) => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-meili-process-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const databasePath = path.join(root, 'search-data');
  await mkdir(databasePath);
  await writeFile(path.join(databasePath, 'sentinel.txt'), 'keep');
  const pid = await standIn();
  await writeFile(pidFilePath(databasePath), record === 'pid' ? `${pid}\n` : '{broken');

  await stopLeftoverMeilisearchProcess({ binaryPath, databasePath });

  await eventually(() => expect(alive(pid)).toBe(standInAlive));
  await expect(readFile(pidFilePath(databasePath))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(databasePath, 'sentinel.txt'), 'utf8')).toBe('keep');
});

it.skipIf(process.platform === 'win32')('kills a recorded engine that ignores SIGTERM once the stop wait runs out', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-meili-process-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const databasePath = path.join(root, 'search-data');
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => console.log('term')); console.log('ready'); setTimeout(() => {}, 60_000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const output = { text: '' };
  child.stdout.on('data', (chunk: Buffer) => { output.text += chunk.toString(); });
  await eventually(() => expect(output.text).toContain('ready'));
  await writeFile(pidFilePath(databasePath), `${child.pid}\n`);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cleanups.push(async () => { vi.useRealTimers(); });

  let stopped = false;
  const stopping = stopLeftoverMeilisearchProcess({ binaryPath: process.execPath, databasePath });
  await eventually(() => expect(output.text).toContain('term'));
  expect(child.signalCode).toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);

  await eventually(() => expect(child.signalCode).toBe('SIGKILL'));
  void stopping.then(() => { stopped = true; });
  await eventually(() => expect(stopped).toBe(true));
});
