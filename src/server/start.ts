import type { VaultWorkspace } from '../vault/workspace.js';
import type { Pacing } from '../pacing/pacing-gate.js';
import type { FastifyInstance } from 'fastify';
import type { ActivityAccess, ScheduleManagement, SubscriptionCollection, CollectionJobs, VaultSetup } from './app.js';
import type { Collector } from '../core/collector.js';
import type { TranscriptSearch } from '../core/types.js';
import type { CollectorRuntimeStatus } from '../runtime/collector-runtime.js';
import { createHttpApp, waitForHttpAppIdle } from './app.js';

export interface StartServerOptions {
  collector?: Collector;
  jobs?: CollectionJobs;
  activity?: ActivityAccess;
  transfer?: VaultWorkspace;
  subscriptions?: readonly SubscriptionCollection[];
  schedule?: ScheduleManagement;
  search?: TranscriptSearch;
  pacing?: readonly Pacing[];
  port: number;
  host?: string;
  webRoot?: string;
  agentToken?: string;
  agentInfo?: { connectionFile: string; skillPath: string; url: string };
  runtimeStatus?: () => CollectorRuntimeStatus;
  notReady?: () => string | null;
  vaultSetup?: VaultSetup;
}

export interface RunningServer {
  app: FastifyInstance;
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const app = await createHttpApp({
    ...(options.collector ? { collector: options.collector } : {}),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.activity ? { activity: options.activity } : {}),
    ...(options.transfer ? { transfer: options.transfer } : {}),
    ...(options.subscriptions ? { subscriptions: options.subscriptions } : {}),
    ...(options.pacing ? { pacing: options.pacing } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    ...(options.agentToken !== undefined ? { agentToken: options.agentToken } : {}),
    ...(options.agentInfo ? { agentInfo: options.agentInfo } : {}),
    ...(options.runtimeStatus ? { runtimeStatus: options.runtimeStatus } : {}),
    ...(options.notReady ? { notReady: options.notReady } : {}),
    ...(options.vaultSetup ? { vaultSetup: options.vaultSetup } : {}),
    allowedHosts: [...new Set(['127.0.0.1', 'localhost', options.host ?? '127.0.0.1'])],
  });
  const host = options.host ?? '127.0.0.1';
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
      await app.close();
      await waitForHttpAppIdle(app);
    },
  };
}
