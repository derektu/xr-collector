/** The runtime module as other modules use it: the collector runtime with the services it exposes, and the process defaults. */
export { DESKTOP_AGENT_PORT, DEVELOPMENT_AGENT_PORT } from './agent-connection-defaults.js';
export type { AgentConnectionAccess, AgentConnectionService } from './agent-connection.js';
export { bundledResources, checkoutRoot } from './bundled-resources.js';
export type { ChangeFeed } from './change-feed.js';
export {
  CollectorRuntime,
  type CollectorRuntimeOptions,
  type RuntimeListeners,
  type RuntimeServices,
} from './collector-runtime.js';
