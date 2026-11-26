// Broken, starting search ends someone else's process, leaves an old engine on the database, or hangs.
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
