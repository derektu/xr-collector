import type { FastifyInstance } from 'fastify';
import type { ChannelCollection } from './app.js';
import type { Collector } from '../core/collector.js';
import type { TranscriptSearch } from '../core/types.js';
import { createHttpApp } from './app.js';

export interface StartServerOptions {
  collector: Collector;
  channels?: ChannelCollection;
  search?: TranscriptSearch;
  port: number;
  host?: string;
  webRoot?: string;
}

export interface RunningServer {
  app: FastifyInstance;
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const app = await createHttpApp({
    collector: options.collector,
    ...(options.channels ? { channels: options.channels } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
  });
  const host = options.host ?? '127.0.0.1';
  await app.listen({ host, port: options.port });
  const address = app.addresses()[0];
  if (!address) throw new Error('HTTP server did not expose a listening address');
  return {
    app,
    url: `http://${host}:${address.port}`,
    port: address.port,
    close: () => app.close(),
  };
}
