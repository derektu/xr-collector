import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import type { ApiRoute, ResponseOf, RouteVaultAccess } from '../../shared/api/api-routes.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    vaultAccess?: RouteVaultAccess;
    revealsSecret?: boolean;
  }
}

export type RouteHandler<Route, Generic extends RouteGenericInterface> = [ResponseOf<Route>] extends [never]
  ? (request: FastifyRequest<Generic>, reply: FastifyReply) => Promise<FastifyReply | void>
  : (request: FastifyRequest<Generic>, reply: Pick<FastifyReply, 'raw'>) => Promise<ResponseOf<Route>>;

export function serve<Route extends ApiRoute<unknown, unknown, unknown>, Generic extends RouteGenericInterface = RouteGenericInterface>(
  app: FastifyInstance, route: Route, handler: RouteHandler<Route, Generic>,
): void {
  const { status, revealsSecret } = route;
  app.route({
    method: route.method,
    url: route.path,
    config: { ...(route.access ? { vaultAccess: route.access } : {}), ...(revealsSecret ? { revealsSecret } : {}) },
    handler: async (request, reply) => {
      if (status !== undefined) void reply.code(status);
      const answer = await (handler as (request: FastifyRequest<Generic>, reply: FastifyReply) => Promise<unknown>)(request as FastifyRequest<Generic>, reply);
      return answer;
    },
  });
}
