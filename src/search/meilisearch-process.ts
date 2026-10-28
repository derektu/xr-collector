import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface StartMeilisearchOptions {
  binaryPath: string;
  databasePath: string;
  lexiconPath?: string;
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
  await stopLeftoverMeilisearchProcess({ binaryPath, databasePath });
  const port = options.port ?? await availableLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const apiKey = randomBytes(32).toString('hex');
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
        ...(options.lexiconPath ? {
          XR_COLLECTOR_MEILISEARCH_DICTIONARY_PATH: path.resolve(options.lexiconPath),
          XR_COLLECTOR_MEILISEARCH_DISABLE_SECONDARY_SPLIT: '1',
        } : {}),
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
    if (child.pid) await writeFile(pidFile, `${JSON.stringify({ pid: child.pid, binaryPath, databasePath } satisfies PidRecord)}\n`);
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

interface PidRecord { pid: number; binaryPath: string; databasePath: string }

/** The engine's process ID, kept beside its database so a later start can find an engine the app left behind. */
export function pidFilePath(databasePath: string): string {
  return `${path.resolve(databasePath)}.pid`;
}

/**
 * Stops the engine a previous run left on this database when the app was killed before it could close
 * it. The recorded process is stopped only while its command line still names this binary and this
 * database, so a process that has since reused the ID is left alone.
 */
export async function stopLeftoverMeilisearchProcess(options: StartMeilisearchOptions): Promise<void> {
  const databasePath = path.resolve(options.databasePath);
  const pidFile = pidFilePath(databasePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pidFile, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Cannot verify the Meilisearch process record ${pidFile}.`, { cause: error });
  }
  if (!isPidRecord(parsed)) throw new Error(`Cannot verify the Meilisearch process record ${pidFile}.`);
  const record = parsed;
  if (!isAlive(record.pid)) {
    await rm(pidFile, { force: true });
    return;
  }
  const recordedDatabase = path.resolve(record.databasePath);
  const recordedBinary = path.resolve(record.binaryPath);
  if (recordedDatabase !== databasePath) throw new Error(`Meilisearch process record ${pidFile} names another database.`);
  const commandLine = await processCommandLine(record.pid);
  if (commandLine === null || !namesEngine(commandLine, recordedBinary, databasePath)) {
    throw new Error(`Cannot prove process ${record.pid} owns Meilisearch database ${databasePath}; refusing to start or clear it.`);
  }
  await stopProcess(record.pid);
  if (isAlive(record.pid)) throw new Error(`Meilisearch process ${record.pid} did not exit; refusing to start or clear ${databasePath}.`);
  await rm(pidFile, { force: true });
}

function isPidRecord(value: unknown): value is PidRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.pid === 'number'
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.binaryPath === 'string'
    && record.binaryPath.length > 0
    && path.isAbsolute(record.binaryPath)
    && typeof record.databasePath === 'string'
    && record.databasePath.length > 0
    && path.isAbsolute(record.databasePath);
}

function namesEngine(commandLine: string, binaryPath: string, databasePath: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const line = normalize(commandLine);
  return line.includes(normalize(binaryPath)) && line.includes(normalize(databasePath));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The full command line of a running process, or null when it cannot be read. */
async function processCommandLine(pid: number): Promise<string | null> {
  try {
    const { stdout } = process.platform === 'win32'
      ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { windowsHide: true })
      : await run('ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
    const line = stdout.trim();
    return line || null;
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
  try {
    const record = JSON.parse(await readFile(pidFile, 'utf8')) as PidRecord;
    if (record.pid === pid) await rm(pidFile, { force: true });
  } catch {
    // Nothing recorded, or another start already replaced the record.
  }
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
      // The process has not opened its loopback listener yet.
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
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

function formatStderr(stderr: string): string {
  const output = stderr.trim();
  return output ? `\n${output}` : '';
}
