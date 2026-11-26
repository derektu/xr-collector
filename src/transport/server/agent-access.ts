import type { OpenedAgentConnection } from '../../app/runtime/index.js';
import { startServer, type RunningServer, type StartServerOptions } from './start.js';

export type AgentServerOptions = Omit<StartServerOptions, 'port' | 'agentAuthorize' | 'agentConnection' | 'pageLog'>;

export async function startAgentListener(connection: OpenedAgentConnection, options: AgentServerOptions): Promise<RunningServer | null> {
  const { access, listener } = connection;
  if (!listener) return null;
  try {
    const server = await firstFreePort(listener.candidatePorts(), (port) => startServer({ ...options, port,
      agentAuthorize: (header) => access.authorize(header), agentConnection: access }));
    listener.attach(server);
    return server;
  } catch (error) {
    listener.listenFailed((error as NodeJS.ErrnoException).code ?? 'agent_connection_failed');
    return null;
  }
}

async function firstFreePort<T>(ports: number[], listen: (port: number) => Promise<T>): Promise<T> { for (const [index, port] of ports.entries()) { try { return await listen(port); } catch (error) { const taken = ['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''); if (!taken || index === ports.length - 1) throw error; } } throw new Error('No port to listen on'); }
