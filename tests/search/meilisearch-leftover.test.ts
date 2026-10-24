import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pidFilePath, startMeilisearchProcess, type RunningMeilisearch } from '../../src/search/meilisearch-process.js';

const bundledBinary = path.resolve('resources/bin/mac/meilisearch');
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
async function leaveEngineBehind(databasePath: string, binaryPath = bundledBinary): Promise<number> {
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

describe.skipIf(!existsSync(bundledBinary))('engine left behind by a killed app', () => {
  it('stops the engine a killed run left on the same database before starting a new one', async () => {
    const databasePath = await tempDatabase();
    const leftover = await leaveEngineBehind(databasePath);
    expect(alive(leftover)).toBe(true);

    const engine = await startMeilisearchProcess({ binaryPath: bundledBinary, databasePath });
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
    await writeFile(pidFilePath(databasePath), JSON.stringify({ pid: other.pid }));

    await expect(startMeilisearchProcess({ binaryPath: bundledBinary, databasePath })).rejects.toThrow(/Cannot prove process/u);
    expect(alive(other.pid!)).toBe(true);
    expect(existsSync(pidFilePath(databasePath))).toBe(true);
  });

  it('stops a proven leftover even when the installed binary path changed', async () => {
    const databasePath = await tempDatabase();
    const previousBinary = path.join(path.dirname(databasePath), 'previous-meilisearch');
    await copyFile(bundledBinary, previousBinary);
    await chmod(previousBinary, 0o755);
    const leftover = await leaveEngineBehind(databasePath, previousBinary);

    const engine = await startMeilisearchProcess({ binaryPath: bundledBinary, databasePath });
    cleanups.push(() => engine.close());
    expect(alive(leftover)).toBe(false);
    expect(await healthy(engine)).toBe(true);
  });
});
