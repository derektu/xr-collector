// The Agent Skill (skills/xr-collector-agent/SKILL.md) and the server name the same API: every route
// in the Skill's HTTP contract table is registered, and every registered route is in the table or in
// the UI-only list below with its reason. A stale Skill sends an Agent to routes that do not exist; a
// route missing from it is an API the Agent never learns about.
// The fields the subscription routes return are checked against the Skill in
// subscription-routes.test.ts, where those routes run.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiRoutes, appWithEveryRoute, type ApiRoute } from '../support/api-routes.js';

const skillPath = path.resolve('skills/xr-collector-agent/SKILL.md');

/**
 * Routes the server registers for the UI alone, each with the reason the Agent does not use it.
 * The UI and Agent listeners serve the same routes, so an entry here is still reachable by an Agent.
 */
const UI_ONLY: ReadonlyArray<ApiRoute & { reason: string }> = [];

const key = (route: ApiRoute): string => `${route.method} ${route.url}`;

/** Every `METHOD /api/...` pair the Skill's HTTP contract table lists, e.g. "`GET`／`PUT /api/x`". */
function contractRoutes(skill: string): ApiRoute[] {
  const table = skill.slice(skill.indexOf('## HTTP 契約'));
  const routes: ApiRoute[] = [];
  for (const row of table.split('\n').filter((line) => line.startsWith('| `'))) {
    const firstCell = row.split('|')[1] ?? '';
    let methods: string[] = [];
    for (const [, segment] of firstCell.matchAll(/`([^`]+)`/gu)) {
      const match = /^(GET|POST|PUT|PATCH|DELETE)(?: (\/api\/\S+))?$/u.exec(segment!);
      if (!match) continue;
      methods.push(match[1]!);
      if (match[2]) {
        for (const method of methods) routes.push({ method, url: match[2] });
        methods = [];
      }
    }
  }
  return routes;
}

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('Agent Skill', () => {
  it('lists every route the server registers, apart from the UI-only ones, and no other', async () => {
    const app = await appWithEveryRoute();
    apps.push(app);
    await app.ready();
    const registered = apiRoutes(app).map(key);
    const listed = contractRoutes(await readFile(skillPath, 'utf8')).map(key);
    const uiOnly = UI_ONLY.map(key);

    // The table parser still finds the contract.
    expect(listed.length).toBeGreaterThan(25);
    expect(registered.filter((route) => !listed.includes(route) && !uiOnly.includes(route)), 'registered but not in the Skill').toEqual([]);
    expect(listed.filter((route) => !registered.includes(route)), 'in the Skill but not registered').toEqual([]);
    expect(uiOnly.filter((route) => !registered.includes(route) || listed.includes(route)), 'UI-only entries that are stale').toEqual([]);
    expect(UI_ONLY.filter((route) => route.reason.trim() === ''), 'UI-only entries without a reason').toEqual([]);
  });
});
