import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, type StartServerOptions } from './start.js';

/** A separate authenticated listener exposes the same business services as the UI listener. */
export async function startAgentAccess(options: {
  collector?: StartServerOptions['collector'];
  transfer?: StartServerOptions['transfer'];
  channels?: StartServerOptions['channels'];
  schedule?: StartServerOptions['schedule'];
  search?: StartServerOptions['search'];
  connectionFile: string;
  skillPath: string;
  runtimeStatus?: StartServerOptions['runtimeStatus'];
  notReadyMessage?: string;
}) {
  const token = randomBytes(32).toString('hex');
  const server = await startServer({
    ...(options.collector ? { collector: options.collector } : {}),
    ...(options.transfer ? { transfer: options.transfer } : {}),
    ...(options.channels ? { channels: options.channels } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.runtimeStatus ? { runtimeStatus: options.runtimeStatus } : {}),
    ...(options.notReadyMessage ? { notReadyMessage: options.notReadyMessage } : {}),
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

export type AgentAccess = Awaited<ReturnType<typeof startAgentAccess>>;
