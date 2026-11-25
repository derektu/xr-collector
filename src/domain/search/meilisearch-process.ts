import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { protectSecret } from '../../shared/lib/redact.js';
import runtimePins from './meilisearch-runtime-pins.json' with { type: 'json' };

const run = promisify(execFile);

export interface StartMeilisearchOptions {
  binaryPath: string;
  databasePath: string;
  port?: number;
}

export interface RunningMeilisearch {
  url: string;
  apiKey: string;
  close(): Promise<void>;
}

export async function startMeilisearchProcess(
  options: StartMeilisearchOptions,
): Promise<RunningMeilisearch> {
  const binaryPath = path.resolve(options.binaryPath);
  const databasePath = path.resolve(options.databasePath);
  const pidFile = pidFilePath(databasePath);
  await checkPinnedVersion(binaryPath);
  await stopLeftoverMeilisearchProcess({ binaryPath, databasePath });
  const port = options.port ?? await availableLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const apiKey = randomBytes(32).toString('hex');
  protectSecret(apiKey);
  await mkdir(databasePath, { recursive: true });

  const child = spawn(
    binaryPath,
    [
      '--db-path',
      databasePath,
      '--http-addr',
      `127.0.0.1:${port}`,
      '--env',
      'production',
      '--no-analytics',
    ],
    {
      cwd: path.dirname(databasePath),
      env: {
        ...process.env,
        MEILI_MASTER_KEY: apiKey,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

  let processError: Error | null = null;
  let stderr = '';
  child.once('error', (error) => {
    processError = error;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_192);
  });

  try {
    if (child.pid) await writeFile(pidFile, `${child.pid}\n`);
    await waitUntilHealthy(child, url, apiKey, () => processError, () => stderr);
  } catch (error) {
    await stopChild(child);
    await removePidFile(pidFile, child.pid);
    throw error;
  }

  let closed = false;
  return {
    url,
    apiKey,
    async close() {
      if (closed) return;
      closed = true;
      await stopChild(child);
      await removePidFile(pidFile, child.pid);
    },
  };
}

export function pidFilePath(databasePath: string): string {
  return `${path.resolve(databasePath)}.pid`;
}

export async function stopLeftoverMeilisearchProcess(options: StartMeilisearchOptions): Promise<void> {
  const pidFile = pidFilePath(options.databasePath);
  // External: libuv places every child it spawns on Windows in a job object that kills them when the parent
  // process ends, however it ends: https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c
  const pid = process.platform === 'win32' ? null : await recordedPid(pidFile);
  if (pid !== null && isAlive(pid) && await executableName(pid) === path.basename(options.binaryPath)) {
    await stopProcess(pid);
  }
  await rm(pidFile, { force: true });
}

async function recordedPid(pidFile: string): Promise<number | null> {
  let recorded: string;
  try {
    recorded = await readFile(pidFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const pid = Number(recorded.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function checkPinnedVersion(binaryPath: string): Promise<void> {
  const expected = `meilisearch ${runtimePins.version}`;
  const { stdout } = await run(binaryPath, ['--version'], { timeout: 10_000, windowsHide: true });
  const version = stdout.trim();
  if (version !== expected) throw new Error(`Meilisearch runtime version is ${version || 'unknown'}, expected ${expected}.`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function executableName(pid: number): Promise<string | null> {
  try {
    // External: On macOS, `ps -o comm=` prints the executable's full path, not only its name.
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'comm=']);
    return path.basename(stdout.trim()) || null;
  } catch {
    return null;
  }
}

async function stopProcess(pid: number): Promise<void> {
  const exited = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !isAlive(pid);
  };
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  if (await exited(5_000)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { return; }
  if (!await exited(5_000)) throw new Error(`Process ${pid} did not exit after SIGKILL.`);
}

async function removePidFile(pidFile: string, pid: number | undefined): Promise<void> {
  const recorded = await readFile(pidFile, 'utf8').catch(() => null);
  if (recorded !== null && Number(recorded.trim()) === pid) await rm(pidFile, { force: true });
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port for Meilisearch'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitUntilHealthy(
  child: ChildProcess,
  url: string,
  apiKey: string,
  getProcessError: () => Error | null,
  getStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const processError = getProcessError();
    if (processError) throw processError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Meilisearch exited before becoming ready.${formatStderr(getStderr())}`,
      );
    }
    try {
      const response = await fetch(`${url}/health`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Meilisearch did not become ready in time.${formatStderr(getStderr())}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
  ]).finally(() => clearTimeout(timer));
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

function formatStderr(stderr: string): string {
  const output = stderr.trim();
  return output ? `\n${output}` : '';
}
