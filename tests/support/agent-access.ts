// An Agent listener on its own, without a runtime: opens the Agent connection of a settings file and
// starts its listener with the given server options, as the product's server does.
import { openAgentConnection, type AgentConnectionHandle, type AgentSettingsOptions } from '../../src/app/runtime/agent-connection.js';
import { startAgentListener, type AgentServerOptions } from '../../src/transport/server/agent-access.js';

/** Opens the Agent connection of `settingsFile` and starts its listener when the connection offers one. */
export async function startAgentAccess(options: AgentSettingsOptions & AgentServerOptions): Promise<AgentConnectionHandle> {
  const connection = await openAgentConnection(options);
  const { settingsFile: _a, skillPath: _b, preferredPort: _c, event: _e, ...server } = options;
  await startAgentListener(connection, server);
  return connection.access;
}

/** Accepts exactly `Bearer <token>`, as an opened Agent connection does with its token. */
export const acceptsBearer = (token: string) => (header: string | undefined): boolean => header === `Bearer ${token}`;
