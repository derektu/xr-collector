import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_PORT_RANGE } from '../runtime/agent-discovery.js';
import { startServer, type StartServerOptions } from './start.js';

export const AGENT_CONNECTION_SCHEMA_VERSION = 1;

/** A separate authenticated listener exposes the same business services as the UI listener. */
export async function startAgentAccess(options: {
  collector?: StartServerOptions['collector'];
  jobs?: StartServerOptions['jobs'];
  activity?: StartServerOptions['activity'];
  /** Receives the Agent token so the activity log can mask it wherever it appears. */
  protectSecret?: (secret: string) => void;
  transfer?: StartServerOptions['transfer'];
  subscriptions?: StartServerOptions['subscriptions'];
  schedule?: StartServerOptions['schedule'];
  search?: StartServerOptions['search'];
  pacing?: StartServerOptions['pacing'];
  connectivity?: StartServerOptions['connectivity'];
  instanceId: string;
  /** Tried first, then the following ports up to AGENT_PORT_RANGE, then any free port; any free port when omitted. */
  preferredPort?: number;
  connectionFile: string;
  skillPath: string;
  runtimeStatus?: StartServerOptions['runtimeStatus'];
  notReady?: StartServerOptions['notReady'];
  vaultSetup?: StartServerOptions['vaultSetup'];
}) {
  if (!options.instanceId) throw new Error('Agent discovery instance ID must not be empty');
  const token = randomBytes(32).toString('hex');
  options.protectSecret?.(token);
  const candidates = options.preferredPort
    ? [...Array.from({ length: AGENT_PORT_RANGE }, (_, offset) => options.preferredPort! + offset), 0]
    : [0];
  const server = await firstFreePort(candidates, (port) => startServer({
    ...(options.collector ? { collector: options.collector } : {}),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.activity ? { activity: options.activity } : {}),
    ...(options.transfer ? { transfer: options.transfer } : {}),
    ...(options.subscriptions ? { subscriptions: options.subscriptions } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.pacing ? { pacing: options.pacing } : {}),
    ...(options.connectivity ? { connectivity: options.connectivity } : {}),
    ...(options.runtimeStatus ? { runtimeStatus: options.runtimeStatus } : {}),
    ...(options.notReady ? { notReady: options.notReady } : {}),
    ...(options.vaultSetup ? { vaultSetup: options.vaultSetup } : {}),
    agentToken: token,
    port,
  }));
  const temporary = `${options.connectionFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await mkdir(path.dirname(options.connectionFile), { recursive: true });
    await writeFile(temporary, JSON.stringify({
      schemaVersion: AGENT_CONNECTION_SCHEMA_VERSION,
      instanceId: options.instanceId,
      url: server.url,
      token,
    }, null, 2), { mode: 0o600, flag: 'wx' });
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

async function firstFreePort<T>(ports: number[], listen: (port: number) => Promise<T>): Promise<T> {
  for (const [index, port] of ports.entries()) {
    try {
      return await listen(port);
    } catch (error) {
      // Windows reports a port inside a range reserved by Hyper-V, WSL or Docker as EACCES.
      const taken = ['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '');
      if (!taken || index === ports.length - 1) throw error;
    }
  }
  throw new Error('No port to listen on');
}

export type AgentAccess = Awaited<ReturnType<typeof startAgentAccess>>;
