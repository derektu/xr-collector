import type { AgentConnectionService } from '../runtime/agent-connection.js';
import { startServer, type RunningServer, type StartServerOptions } from './start.js';

/** What the Agent listener serves: every option of a server except the port and the authorization, which the connection decides. */
export type AgentServerOptions = Omit<StartServerOptions, 'port' | 'agentAuthorize' | 'agentConnection'>;

/**
 * Starts the Agent listener of `connection` on the first of its candidate ports that is free and
 * attaches it. A connection whose settings could not be read starts none; a listener that cannot
 * start leaves the connection unavailable and the rest of the app running. Either returns null.
 */
export async function startAgentListener(connection: AgentConnectionService, options: AgentServerOptions): Promise<RunningServer | null> {
  if (!connection.opened) return null;
  try {
    const server = await firstFreePort(connection.candidatePorts(), (port) => startServer({ ...options, port,
      agentAuthorize: (header) => connection.authorize(header), agentConnection: connection }));
    connection.attach(server);
    return server;
  } catch (error) {
    connection.listenFailed((error as NodeJS.ErrnoException).code ?? 'agent_connection_failed');
    return null;
  }
}

async function firstFreePort<T>(ports: number[], listen: (port: number) => Promise<T>): Promise<T> { for (const [index, port] of ports.entries()) { try { return await listen(port); } catch (error) { const taken = ['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''); if (!taken || index === ports.length - 1) throw error; } } throw new Error('No port to listen on'); }
