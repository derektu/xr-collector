import {
  CollectorRuntime, type CollectorRuntimeOptions, type RuntimeListeners, type RuntimeServices,
} from '../runtime/collector-runtime.js';
import { startAgentListener } from './agent-access.js';
import { startServer, type RunningServer } from './start.js';

/** The two HTTP listeners of a process: the UI's, and the Agents', which is null when it could not start. */
export interface HttpListeners extends RuntimeListeners {
  ui: RunningServer;
  agent: RunningServer | null;
}

export interface CollectorServerOptions extends CollectorRuntimeOptions {
  uiPort: number;
  uiHost?: string;
  webRoot?: string;
}

/** A runtime serving its services over the UI and Agent HTTP listeners. */
export type CollectorServer = CollectorRuntime<HttpListeners>;

/** Starts the runtime of a process with its UI and Agent HTTP listeners. */
export function startCollectorServer(options: CollectorServerOptions): Promise<CollectorServer> {
  const { uiPort, uiHost, webRoot, ...runtime } = options;
  return CollectorRuntime.start(runtime, (services) => startHttpListeners(services, {
    port: uiPort, ...(uiHost ? { host: uiHost } : {}), ...(webRoot ? { webRoot } : {}),
  }));
}

/**
 * Starts the Agent listener on its connection's port, then the UI listener, which also serves the
 * Agent connection settings. Both serve the same routes; only the Agent's asks for the key.
 */
async function startHttpListeners(services: RuntimeServices, ui: { port: number; host?: string; webRoot?: string }): Promise<HttpListeners> {
  const { agentConnection, ...shared } = services;
  const agent = await startAgentListener(agentConnection, shared);
  let server: RunningServer;
  try {
    server = await startServer({ ...shared, ...ui, agentConnection });
  } catch (error) {
    await agentConnection.close().catch(() => undefined);
    throw error;
  }
  return {
    ui: server,
    agent,
    close: async () => {
      const closed = await Promise.allSettled([server.close(), agentConnection.close()]);
      const failed = closed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}
