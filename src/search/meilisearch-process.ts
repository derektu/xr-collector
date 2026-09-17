import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';

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
  const port = options.port ?? await availableLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const apiKey = randomBytes(32).toString('hex');
  await mkdir(options.databasePath, { recursive: true });

  const child = spawn(
    options.binaryPath,
    [
      '--db-path',
      options.databasePath,
      '--http-addr',
      `127.0.0.1:${port}`,
      '--env',
      'production',
      '--no-analytics',
    ],
    {
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
    await waitUntilHealthy(child, url, apiKey, () => processError, () => stderr);
  } catch (error) {
    await stopChild(child);
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
    },
  };
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
