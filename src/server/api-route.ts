import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import type { ApiRoute, ResponseOf } from '../core/api-routes.js';

/**
 * What a handler of `Route` returns: the route's response type for a JSON route; for an event
 * stream or a file, the reply it sent, or nothing once it took the connection over.
 */
type Answer<Route> = [ResponseOf<Route>] extends [never] ? FastifyReply | void : ResponseOf<Route>;

export type RouteHandler<Route, Generic extends RouteGenericInterface> =
  (request: FastifyRequest<Generic>, reply: FastifyReply) => Promise<Answer<Route>>;

/**
 * Registers `handler` for a route of the API table, with the route's Vault access and success
 * status. A handler names the request shape it reads by annotating its `request` parameter.
 */
export function serve<Route extends ApiRoute<unknown, unknown, unknown>, Generic extends RouteGenericInterface = RouteGenericInterface>(
  app: FastifyInstance, route: Route, handler: RouteHandler<Route, Generic>,
): void {
  const status = route.status;
  app.route({
    method: route.method,
    url: route.path,
    // Fastify normalizes route options in place, so every route receives a fresh object.
    ...(route.access ? { config: { vaultAccess: route.access } } : {}),
    handler: async (request, reply) => {
      if (status !== undefined) void reply.code(status);
      return handler(request as FastifyRequest<Generic>, reply);
    },
  });
}
