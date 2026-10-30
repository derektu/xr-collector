import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { VaultWorkspace } from '../vault/workspace.js';
import type { Pacing } from '../pacing/pacing-gate.js';
import type { FastifyInstance } from 'fastify';
import type { ActivityAccess, ConnectivityAccess, ScheduleManagement, SubscriptionCollection, CollectionJobs, VaultSetup, NotificationAccess } from './app.js';
import type { Collector } from '../core/collector.js';
import type { BuildInfo, TranscriptSearch } from '../core/types.js';
import type { CollectorRuntimeStatus } from '../runtime/collector-runtime.js';
import { createHttpApp, waitForHttpAppIdle } from './app.js';
import type { AgentConnectionAccess } from './agent-access.js';
import type { UpdateAccess } from '../updates/types.js';

export interface StartServerOptions {
  buildInfo?: BuildInfo;
  collector?: Collector;
  jobs?: CollectionJobs;
  activity?: ActivityAccess;
  transfer?: VaultWorkspace;
  subscriptions?: readonly SubscriptionCollection[];
  schedule?: ScheduleManagement;
  search?: TranscriptSearch;
  pacing?: readonly Pacing[];
  connectivity?: ConnectivityAccess;
  port: number;
  host?: string;
  webRoot?: string;
  agentToken?: string;
  agentAuthorize?: (header: string | undefined) => boolean;
  agentConnection?: AgentConnectionAccess;
  runtimeStatus?: () => CollectorRuntimeStatus;
  notReady?: () => string | null;
  vaultSetup?: VaultSetup;
  loginStartup?: import('../core/login-startup.js').LoginStartupAccess;
  updates?: UpdateAccess;
  notifications?: NotificationAccess;
}

export interface RunningServer {
  app: FastifyInstance;
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const app = await createHttpApp({
    ...(options.buildInfo ? { buildInfo: options.buildInfo } : {}),
    ...(options.collector ? { collector: options.collector } : {}),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.activity ? { activity: options.activity } : {}),
    ...(options.transfer ? { transfer: options.transfer } : {}),
    ...(options.subscriptions ? { subscriptions: options.subscriptions } : {}),
    ...(options.pacing ? { pacing: options.pacing } : {}),
    ...(options.connectivity ? { connectivity: options.connectivity } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    ...(options.agentToken !== undefined ? { agentToken: options.agentToken } : {}),
    ...(options.agentAuthorize ? { agentAuthorize: options.agentAuthorize } : {}),
    ...(options.agentConnection ? { agentConnection: options.agentConnection } : {}),
    ...(options.runtimeStatus ? { runtimeStatus: options.runtimeStatus } : {}),
    ...(options.notReady ? { notReady: options.notReady } : {}),
    ...(options.vaultSetup ? { vaultSetup: options.vaultSetup } : {}),
    ...(options.loginStartup ? { loginStartup: options.loginStartup } : {}),
    ...(options.updates ? { updates: options.updates } : {}),
    ...(options.notifications ? { notifications: options.notifications } : {}),
    allowedHosts: [...new Set(['127.0.0.1', 'localhost', options.host ?? '127.0.0.1'])],
  });
  const host = options.host ?? '127.0.0.1';
  const connections = trackConnections(app.server);
  try {
    await app.listen({ host, port: options.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  const address = app.addresses()[0];
  if (!address) throw new Error('HTTP server did not expose a listening address');
  return {
    app,
    url: `http://${host}:${address.port}`,
    port: address.port,
    close: async () => {
      connections.drain();
      await app.close();
      await waitForHttpAppIdle(app);
    },
  };
}

/**
 * The server's close waits for every open connection, and a browser keeps connections it opened
 * ahead of need, or after a response, without a request on them. Draining ends each connection
 * that carries no request at once, and each other one once its response is sent.
 */
function trackConnections(server: Server): { drain(): void } {
  const responding = new Map<Socket, number>();
  let draining = false;
  server.on('connection', (socket: Socket) => {
    if (draining) { socket.destroy(); return; }
    responding.set(socket, 0);
    socket.once('close', () => responding.delete(socket));
  });
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const socket = request.socket;
    responding.set(socket, (responding.get(socket) ?? 0) + 1);
    response.once('close', () => {
      if (!responding.has(socket)) return;
      const remaining = responding.get(socket)! - 1;
      responding.set(socket, remaining);
      if (draining && remaining === 0) socket.end();
    });
  });
  return {
    drain() {
      draining = true;
      for (const [socket, count] of responding) if (count === 0) socket.destroy();
    },
  };
}
