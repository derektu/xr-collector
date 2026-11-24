// Starting the search engine after a crash: an engine a killed app left on the same database is
// stopped before a new one starts. Stopping the engine leaves no timer behind, so the server and the
// Desktop app exit as soon as the engine has. Both cases run the real engine.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pidFilePath,
  startMeilisearchProcess,
  type RunningMeilisearch,
} from '../../../src/domain/search/meilisearch-process.js';
import { bundledMeilisearch, REAL_ENGINE_TAG } from '../../support/real-engine.js';

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

/** Runs the fixture that starts an engine, kills the fixture with SIGKILL, and returns the engine it left behind. */
async function leaveEngineBehind(databasePath: string): Promise<number> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/domain/search/fixtures/killed-engine.ts'), bundledMeilisearch, databasePath], {
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
    expect(Number(await readFile(pidFilePath(databasePath), 'utf8'))).not.toBe(leftover);

    await engine.close();
    expect(existsSync(pidFilePath(databasePath))).toBe(false);
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
