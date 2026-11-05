import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import type { ApiRoute, ResponseOf } from '../core/api-routes.js';

/**
 * The handler of `Route`. A JSON route's handler answers the route's response type and sees only the
 * connection of its reply, so it cannot send a reply of its own in place of that type. An event
 * stream or a file route's handler sends the reply itself, or takes the connection over.
 */
export type RouteHandler<Route, Generic extends RouteGenericInterface> = [ResponseOf<Route>] extends [never]
  ? (request: FastifyRequest<Generic>, reply: FastifyReply) => Promise<FastifyReply | void>
  : (request: FastifyRequest<Generic>, reply: Pick<FastifyReply, 'raw'>) => Promise<ResponseOf<Route>>;

/**
 * Registers `handler` for a route of the API table, with the route's Vault access and success
 * status. A handler names the request shape it reads by annotating its `request` parameter. The
 * successful answer of a route that reveals a secret is serialized without the app's masking.
 */
export function serve<Route extends ApiRoute<unknown, unknown, unknown>, Generic extends RouteGenericInterface = RouteGenericInterface>(
  app: FastifyInstance, route: Route, handler: RouteHandler<Route, Generic>,
): void {
  const { status, revealsSecret } = route;
  app.route({
    method: route.method,
    url: route.path,
    // Fastify normalizes route options in place, so every route receives a fresh object.
    ...(route.access ? { config: { vaultAccess: route.access } } : {}),
    handler: async (request, reply) => {
      if (status !== undefined) void reply.code(status);
      const answer = await (handler as (request: FastifyRequest<Generic>, reply: FastifyReply) => Promise<unknown>)(request as FastifyRequest<Generic>, reply);
      if (revealsSecret) void reply.type('application/json; charset=utf-8').serializer(JSON.stringify);
      return answer;
    },
  });
}
