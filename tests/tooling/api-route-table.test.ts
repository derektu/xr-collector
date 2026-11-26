// Guards the developer, not the user: the server, the web client and the tray can disagree on a route's
// response or path without the typecheck noticing.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_ROUTES } from '../../src/shared/api/api-routes.js';

const TABLE = 'src/shared/api/api-routes.ts';

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : /\.(?:ts|tsx|cts)$/u.test(entry.name) ? [file] : [];
  });
}

describe('API table', () => {
  it('refuses a handler or a client that reads another response key than its route declares', () => {
    const result = spawnSync(process.execPath, [path.resolve('node_modules/typescript-7/bin/tsc'), '-p', 'tests/tooling/fixtures/api-route-types'], { encoding: 'utf8' });
    expect(`${result.stdout}${result.stderr}`).toBe('');
    expect(result.status).toBe(0);
  });

  it('is the only product file that names the path of a table route', () => {
    const paths = [...new Set(Object.values(API_ROUTES).map((route) => route.path))];
    const named = filesUnder('src').filter((file) => file !== TABLE).flatMap((file) => {
      const code = readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\/?\*)/u.test(line)).join('\n');
      return paths.filter((route) => new RegExp(`['"\`]${route.replace(/[/.]/gu, '\\$&')}['"\`?]`, 'u').test(code)).map((route) => `${file}: ${route}`);
    });
    expect(named).toEqual([]);
  });
});
