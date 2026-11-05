// The API routes an HTTP app registers, and an app that registers all of them.
import type { FastifyInstance } from 'fastify';
import { ChangeFeed } from '../../src/core/change-feed.js';
import { createHttpApp, type HttpAppOptions } from '../../src/server/app.js';
import { PRODUCT_SOURCES } from './product-sources.js';

export interface ApiRoute { method: string; url: string }

/** Each `/api` route of a Fastify route tree, as its full path and methods, e.g. "/api/jobs/:id (GET, HEAD)". */
export function apiRouteLines(tree: string): string[] {
  const prefixes: string[] = [];
  const routes: string[] = [];
  for (const line of tree.split('\n')) {
    const match = /^((?:[│ ] {3})*)[├└]── (\S+)(?: \(([^)]+)\))?$/u.exec(line);
    if (!match) continue;
    const depth = match[1]!.length / 4;
    prefixes.length = depth;
    const full = `${prefixes.join('')}${match[2]}`;
    prefixes.push(match[2]!);
    if (match[3] && full.startsWith('/api/')) routes.push(`${full} (${match[3]})`);
  }
  return routes.sort();
}

/** Every `/api` method and path `app` registers, without the HEAD routes Fastify adds to each GET. */
export function apiRoutes(app: FastifyInstance): ApiRoute[] {
  return apiRouteLines(app.printRoutes({ commonPrefix: false })).flatMap((line) => {
    const [, url, methods] = /^(\S+) \((.+)\)$/u.exec(line)!;
    return methods!.split(', ').filter((method) => method !== 'HEAD').map((method) => ({ method, url: url! }));
  }).sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`));
}

/**
 * A service whose every method answers an empty object, so a route's handler runs without its real
 * service. Not a thenable, so a handler that awaits it gets the service itself.
 */
export function anyService(fields: Record<string, unknown> = {}): never {
  return new Proxy(fields, {
    get: (target, key) => key in target ? target[key as string] : key === 'then' ? undefined : () => Promise.resolve({}),
  }) as never;
}

/** An app given every optional service, so it registers every route the product can serve. */
export function appWithEveryRoute(overrides: Partial<HttpAppOptions> = {}): Promise<FastifyInstance> {
  return createHttpApp({
    sources: PRODUCT_SOURCES,
    changes: new ChangeFeed(),
    collector: anyService(), jobs: anyService(), activity: anyService(), transfer: anyService(), schedule: anyService(),
    search: anyService(), vaultSetup: anyService(), loginStartup: anyService(), updates: anyService(),
    notifications: anyService(), agentConnection: anyService({ download: async () => Buffer.from('zip') }),
    subscriptions: [anyService({ type: 'youtube' })],
    pacing: [anyService({ group: 'youtube' })],
    ...overrides,
  });
}
