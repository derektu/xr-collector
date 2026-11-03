// Starting the search engine after a crash: an engine a killed app left on the same database is
// stopped before a new one starts, and a process record that cannot be verified stops startup
// without killing another process or clearing search data. Stopping the engine leaves no timer
// behind, so the server and the Desktop app exit as soon as the engine has. The killed-app and
// stopping cases run the real engine.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pidFilePath,
  startMeilisearchProcess,
  stopLeftoverMeilisearchProcess,
  type RunningMeilisearch,
} from '../../src/search/meilisearch-process.js';
import { bundledMeilisearch, REAL_ENGINE_TAG } from '../support/real-engine.js';

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function tempDatabase(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-meili-leftover-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'search-data');
}

async function healthy(engine: RunningMeilisearch): Promise<boolean> {
  return (await fetch(`${engine.url}/health`, { headers: { Authorization: `Bearer ${engine.apiKey}` } })).ok;
}

async function exitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (!pid) throw new Error('Could not start the exited-process fixture');
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  return pid;
}

/** Runs the fixture that starts an engine, kills the fixture with SIGKILL, and returns the engine it left behind. */
async function leaveEngineBehind(databasePath: string, binaryPath = bundledMeilisearch): Promise<number> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/search/fixtures/killed-engine.ts'), binaryPath, databasePath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  const pid = await new Promise<number>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /engine (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', (code) => reject(new Error(`fixture exited ${code}: ${output}`)));
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  cleanups.push(async () => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  return pid;
}

describe('persisted Meilisearch process record', () => {
  it('rejects a pid-only record before clearing data or starting an unverified binary', async () => {
    const databasePath = await tempDatabase();
    const sentinel = path.join(databasePath, 'sentinel.txt');
    const missingBinary = path.join(path.dirname(databasePath), 'missing-meilisearch');
    const record = `${JSON.stringify({ pid: await exitedProcessId() })}\n`;
    await mkdir(databasePath, { recursive: true });
    await writeFile(sentinel, 'keep');
    await writeFile(pidFilePath(databasePath), record);

    await expect(startMeilisearchProcess({ binaryPath: missingBinary, databasePath })).rejects.toThrow(
      /Cannot verify the Meilisearch process record/u,
    );
    expect(await readFile(pidFilePath(databasePath), 'utf8')).toBe(record);
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a non-positive pid', { pid: 0, binaryPath: path.resolve('meilisearch'), databasePath: path.resolve('database') }],
    ['a non-integer pid', { pid: 1.5, binaryPath: path.resolve('meilisearch'), databasePath: path.resolve('database') }],
    ['a non-numeric pid', { pid: '1', binaryPath: path.resolve('meilisearch'), databasePath: path.resolve('database') }],
    ['a missing binary path', { databasePath: path.resolve('database') }],
    ['a missing database path', { binaryPath: path.resolve('meilisearch') }],
    ['a non-string binary path', { binaryPath: 1, databasePath: path.resolve('database') }],
    ['a non-string database path', { binaryPath: path.resolve('meilisearch'), databasePath: 1 }],
    ['an empty binary path', { binaryPath: '', databasePath: path.resolve('database') }],
    ['an empty database path', { binaryPath: path.resolve('meilisearch'), databasePath: '' }],
    ['a relative binary path', { binaryPath: 'meilisearch', databasePath: path.resolve('database') }],
    ['a relative database path', { binaryPath: path.resolve('meilisearch'), databasePath: 'database' }],
  ])('rejects %s before removing the process record or database data', async (_label, fields) => {
    const databasePath = await tempDatabase();
    const sentinel = path.join(databasePath, 'sentinel.txt');
    const missingBinary = path.join(path.dirname(databasePath), 'missing-meilisearch');
    const record = fields === null || Array.isArray(fields)
      ? fields
      : { pid: await exitedProcessId(), ...fields };
    const serialized = `${JSON.stringify(record)}\n`;
    await mkdir(databasePath, { recursive: true });
    await writeFile(sentinel, 'keep');
    await writeFile(pidFilePath(databasePath), serialized);

    await expect(stopLeftoverMeilisearchProcess({ binaryPath: missingBinary, databasePath })).rejects.toThrow(
      /Cannot verify the Meilisearch process record/u,
    );
    expect(await readFile(pidFilePath(databasePath), 'utf8')).toBe(serialized);
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
  });
});

// On Windows, libuv places every child it spawns without `detached` in a job object that closes,
// ending the child, when the parent dies; a killed app takes its engine with it, so no leftover exists
// to stop there.
describe('engine left behind by a killed app', { tags: [REAL_ENGINE_TAG] }, () => {
  it.skipIf(process.platform === 'win32')('stops the engine a killed run left on the same database before starting a new one', async () => {
    const databasePath = await tempDatabase();
    const leftover = await leaveEngineBehind(databasePath);
    expect(alive(leftover)).toBe(true);

    const engine = await startMeilisearchProcess({ binaryPath: bundledMeilisearch, databasePath });
    cleanups.push(() => engine.close());
    expect(alive(leftover)).toBe(false);
    expect(await healthy(engine)).toBe(true);
    const recorded = JSON.parse(await readFile(pidFilePath(databasePath), 'utf8')) as { pid: number };
    expect(recorded.pid).not.toBe(leftover);

    await engine.close();
    expect(existsSync(pidFilePath(databasePath))).toBe(false);
  });

  it('fails closed when a live recorded process cannot be proven to own this database', async () => {
    const databasePath = await tempDatabase();
    const other = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
    cleanups.push(async () => { other.kill('SIGKILL'); });
    await writeFile(pidFilePath(databasePath), JSON.stringify({
      pid: other.pid,
      binaryPath: bundledMeilisearch,
      databasePath,
    }));

    await expect(startMeilisearchProcess({ binaryPath: bundledMeilisearch, databasePath })).rejects.toThrow(/Cannot prove process/u);
    expect(alive(other.pid!)).toBe(true);
    expect(existsSync(pidFilePath(databasePath))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('stops a proven leftover even when the installed binary path changed', async () => {
    const databasePath = await tempDatabase();
    // A symlink gives the leftover its own command-line path. A copy is a new executable that macOS
    // scans on its first launch for about two seconds; the symlink launches the already-scanned binary.
    const previousBinary = path.join(path.dirname(databasePath), 'previous-meilisearch');
    await symlink(bundledMeilisearch, previousBinary);
    const leftover = await leaveEngineBehind(databasePath, previousBinary);

    const engine = await startMeilisearchProcess({ binaryPath: bundledMeilisearch, databasePath });
    cleanups.push(() => engine.close());
    expect(alive(leftover)).toBe(false);
    expect(await healthy(engine)).toBe(true);
  });
});

describe('stopping the engine', { tags: [REAL_ENGINE_TAG] }, () => {
  it('leaves no timer behind once the engine has exited, so the app can quit at once', async () => {
    const engine = await startMeilisearchProcess({ binaryPath: bundledMeilisearch, databasePath: await tempDatabase() });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await engine.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
