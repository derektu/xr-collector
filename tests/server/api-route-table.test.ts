// The server registers every route of the API table (src/core/api-routes.ts) with the table's method
// and path, so the web client and the system tray reach the route the table promises them. A route
// missing from the server leaves a screen or a tray action answering 404.
//
// `OUTSIDE_TABLE` lists the routes the server still registers without the table. The list only gets
// shorter: a route that moves into the table deletes its line.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API_ROUTES } from '../../src/core/api-routes.js';
import { apiRoutes, appWithEveryRoute } from '../support/api-routes.js';

const OUTSIDE_TABLE = [
  'GET /api/activity', 'GET /api/activity/groups/:groupId',
  'GET /api/documents', 'GET /api/documents/:id', 'DELETE /api/documents/:id', 'GET /api/documents/sources',
  'POST /api/items', 'GET /api/jobs', 'GET /api/jobs/:id', 'POST /api/jobs/:id/dismiss', 'POST /api/jobs/:id/retry',
  'GET /api/jobs/summary', 'GET /api/search', 'POST /api/search/rebuild', 'GET /api/search/status',
  'GET /api/source-types', 'POST /api/submissions', 'POST /api/subscription-previews',
  'GET /api/subscriptions', 'POST /api/subscriptions', 'GET /api/subscriptions/:type/:id', 'PATCH /api/subscriptions/:type/:id',
  'DELETE /api/subscriptions/:type/:id', 'POST /api/subscriptions/:type/:id/apply-settings', 'POST /api/url-recognitions',
];

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('API table', () => {
  it('is what the server registers, apart from the routes not yet in it', async () => {
    const app = await appWithEveryRoute();
    apps.push(app);
    await app.ready();
    const registered = apiRoutes(app).map((route) => `${route.method} ${route.url}`).sort();
    const table = Object.values(API_ROUTES).map((route) => `${route.method} ${route.path}`);
    expect(registered).toEqual([...table, ...OUTSIDE_TABLE].sort());
  });
});
