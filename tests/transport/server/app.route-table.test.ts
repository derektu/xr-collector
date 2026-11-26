// Broken, a screen or tray action answers 404, or a route answers a shape no client type checks.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API_ROUTES } from '../../../src/shared/api/api-routes.js';
import { apiRoutes, appWithEveryRoute } from '../../support/api-routes.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('API table', () => {
  it('is what the server registers', async () => {
    const app = await appWithEveryRoute();
    apps.push(app);
    await app.ready();
    const registered = apiRoutes(app).map((route) => `${route.method} ${route.url}`).sort();
    const table = Object.values(API_ROUTES).map((route) => `${route.method} ${route.path}`);
    expect(registered).toEqual(table.sort());
  });
});
