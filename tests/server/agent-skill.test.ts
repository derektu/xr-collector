import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHttpApp, type HttpAppOptions } from '../../src/server/app.js';

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
  it('lists only routes the server registers, including the document and search contract', async () => {
    const stub = {} as never;
    const options: HttpAppOptions = {
      collector: stub, jobs: stub, transfer: stub, channels: stub, schedule: stub, search: stub, vaultSetup: stub,
      agentToken: 'skill-test',
    };
    const app = await createHttpApp(options);
    await app.ready();
    const routes = contractRoutes(await readFile(skillPath, 'utf8'));

    expect(routes.length).toBeGreaterThan(25);
    expect(routes).toEqual(expect.arrayContaining([
      { method: 'GET', url: '/api/documents' },
      { method: 'GET', url: '/api/documents/sources' },
      { method: 'GET', url: '/api/documents/:id' },
      { method: 'GET', url: '/api/search' },
      { method: 'GET', url: '/api/search/status' },
    ]));
    for (const route of routes) {
      expect(app.hasRoute(route), `${route.method} ${route.url}`).toBe(true);
    }
    await app.close();
  });

  it('documents the stable source filters that browse and search accept', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const parameter of ['sourceType', 'publisherId', 'offset', 'limit']) {
      expect(skill).toContain(`\`${parameter}\``);
    }
    expect(skill).toContain('`channel` 參數回 400');
    expect(skill).not.toContain('estimatedTotalHits');
    expect(skill).not.toContain('channelTitle');
  });
});
