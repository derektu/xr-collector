import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, type StartServerOptions } from './start.js';

/** A separate listener shares the UI's services, but authorizes only document reads. */
export async function startAgentAccess(options: {
  collector: StartServerOptions['collector'];
  transfer?: StartServerOptions['transfer'];
  search: NonNullable<StartServerOptions['search']>;
  connectionFile: string;
  skillPath: string;
}) {
  const token = randomBytes(32).toString('hex');
  const server = await startServer({
    collector: options.collector,
    ...(options.transfer ? { transfer: options.transfer } : {}),
    search: options.search,
    agentToken: token,
    port: 0,
  });
  const temporary = `${options.connectionFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await mkdir(path.dirname(options.connectionFile), { recursive: true });
    await writeFile(temporary, JSON.stringify({ url: server.url, token }, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, options.connectionFile);
  } catch (error) {
    await server.close();
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    info: { url: server.url, connectionFile: options.connectionFile, skillPath: options.skillPath },
    // Keep the last connection file so clients can distinguish a stopped app from missing setup.
    close: () => server.close(),
  };
}
