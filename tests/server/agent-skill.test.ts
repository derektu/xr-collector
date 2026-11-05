// The Agent Skill (skills/xr-collector-agent/SKILL.md) matches the server: every route in its
// HTTP contract table is registered. A stale Skill sends an Agent to routes that do not exist.
// The fields the subscription routes return are checked against the Skill in
// subscription-routes.test.ts, where those routes run.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ChangeFeed } from '../../src/core/change-feed.js';
import { describe, expect, it } from 'vitest';
import { createHttpApp, type HttpAppOptions } from '../../src/server/app.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';

const skillPath = path.resolve('skills/xr-collector-agent/SKILL.md');

/** Every `METHOD /api/...` pair the Skill's HTTP contract table lists, e.g. "`GET`／`PUT /api/x`". */
function contractRoutes(skill: string): Array<{ method: string; url: string }> {
  const table = skill.slice(skill.indexOf('## HTTP 契約'));
  const routes: Array<{ method: string; url: string }> = [];
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

describe('Agent Skill', () => {
  it('lists only routes the server registers', async () => {
    const stub = {} as never;
    const options: HttpAppOptions = {
      sources: PRODUCT_SOURCES,
      collector: stub, jobs: stub, activity: stub, transfer: stub, subscriptions: [{ type: 'youtube' } as never], schedule: stub, search: stub, vaultSetup: stub,
      pacing: [{ group: 'youtube' } as never], agentToken: 'skill-test', changes: new ChangeFeed(),
      agentConnection: {
        status: () => ({ state: 'available', activeUrl: 'http://127.0.0.1:1', activePort: 1, configured: { mode: 'auto' }, restartRequired: false, message: 'test' }),
        connection: () => ({ url: 'http://127.0.0.1:1', token: 'test' }), authorize: () => true,
        configure: async () => ({ state: 'available', activeUrl: 'http://127.0.0.1:1', activePort: 1, configured: { mode: 'auto' }, restartRequired: false, message: 'test' }),
        resetKey: async () => ({ url: 'http://127.0.0.1:1', token: 'test' }), download: async () => Buffer.from('zip'),
      },
    };
    const app = await createHttpApp(options);
    await app.ready();
    const routes = contractRoutes(await readFile(skillPath, 'utf8'));

    // The table parser still finds the contract.
    expect(routes.length).toBeGreaterThan(25);
    for (const route of routes) {
      expect(app.hasRoute(route), `${route.method} ${route.url}`).toBe(true);
    }
    await app.close();
  });
});
