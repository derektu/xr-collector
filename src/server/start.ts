import type { VaultWorkspace } from '../vault/workspace.js';
import type { FastifyInstance } from 'fastify';
import type { ChannelCollection, ChannelScheduleManagement } from './app.js';
import type { Collector } from '../core/collector.js';
import type { TranscriptSearch } from '../core/types.js';
import type { CollectorRuntimeStatus } from '../runtime/collector-runtime.js';
import { createHttpApp, waitForHttpAppIdle } from './app.js';

export interface StartServerOptions {
  collector?: Collector;
  transfer?: VaultWorkspace;
  channels?: ChannelCollection;
  schedule?: ChannelScheduleManagement;
  search?: TranscriptSearch;
  port: number;
  host?: string;
  webRoot?: string;
  agentToken?: string;
  agentInfo?: { connectionFile: string; skillPath: string; url: string };
  runtimeStatus?: () => CollectorRuntimeStatus;
  notReadyMessage?: string;
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
    ...(options.transfer ? { transfer: options.transfer } : {}),
    ...(options.channels ? { channels: options.channels } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    ...(options.agentToken !== undefined ? { agentToken: options.agentToken } : {}),
    ...(options.agentInfo ? { agentInfo: options.agentInfo } : {}),
    ...(options.runtimeStatus ? { runtimeStatus: options.runtimeStatus } : {}),
    ...(options.notReadyMessage ? { notReadyMessage: options.notReadyMessage } : {}),
  });
  const host = options.host ?? '127.0.0.1';
  await app.listen({ host, port: options.port });
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
