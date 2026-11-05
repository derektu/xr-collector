import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../core/api-routes.js';
import type { AgentPortSetting } from '../../core/device-types.js';
import type { AgentConnectionAccess } from '../agent-access.js';
import { serve } from '../api-route.js';

/** The Agent connection: its status, the connection data, the port setting, a new key and the Skill download. */
export function registerAgentRoutes(app: FastifyInstance, agent: AgentConnectionAccess): void {
  serve(app, API_ROUTES.agent, async () => ({ agent: agent.status() }));
  serve(app, API_ROUTES.agentConnection, async () => ({ connection: agent.connection() }));
  serve(app, API_ROUTES.setAgentPort, async (request: FastifyRequest<{ Body: AgentPortSetting }>) => ({ agent: await agent.configure(request.body) }));
  serve(app, API_ROUTES.resetAgentKey, async () => ({ connection: await agent.resetKey(), agent: agent.status() }));
  serve(app, API_ROUTES.agentSkill, async (_request, reply) => reply.type('application/zip')
    .header('Content-Disposition', 'attachment; filename="xr-collector-agent.zip"').send(await agent.download()));
}
