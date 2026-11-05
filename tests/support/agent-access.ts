// An Agent listener on its own, without a runtime: opens the Agent connection of a settings file
// (or takes one) and starts its listener with the given server options, as the product's server does.
import { openAgentConnection, type AgentConnectionService, type AgentSettingsOptions } from '../../src/runtime/agent-connection.js';
import { startAgentListener, type AgentServerOptions } from '../../src/server/agent-access.js';

/** Starts the Agent listener of `access`, or of a connection opened here when none is given. */
export async function startAgentAccess(options: AgentSettingsOptions & AgentServerOptions & {
  access?: AgentConnectionService;
}): Promise<AgentConnectionService> {
  const service = options.access ?? await openAgentConnection(options);
  const { settingsFile: _a, skillPath: _b, preferredPort: _c, event: _e, access: _f, ...server } = options;
  await startAgentListener(service, server);
  return service;
}
