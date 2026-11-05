// Guards the developer, not the user: the API table (`src/core/api-routes.ts`) is what keeps the
// server, the web client and the system tray agreeing on each route's response. A handler that
// answers another key than its route declares fails the typecheck, and no product file names a
// table route's path itself, where the table could not check it.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_ROUTES } from '../../src/core/api-routes.js';

const TABLE = 'src/core/api-routes.ts';

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : /\.(?:ts|tsx|cts)$/u.test(entry.name) ? [file] : [];
  });
}

describe('API table', () => {
  it('refuses a handler or a client that reads another response key than its route declares', () => {
    // tests/tooling/fixtures/api-route-types marks each mismatch with `@ts-expect-error`.
    const result = spawnSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'tests/tooling/fixtures/api-route-types'], { encoding: 'utf8' });
    expect(`${result.stdout}${result.stderr}`).toBe('');
    expect(result.status).toBe(0);
  });

  it('is the only product file that names the path of a table route', () => {
    const paths = [...new Set(Object.values(API_ROUTES).map((route) => route.path))];
    const named = filesUnder('src').filter((file) => file !== TABLE).flatMap((file) => {
      // Comments may name a route; code may not.
      const text = readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\/?\*)/u.test(line)).join('\n');
      return paths.filter((route) => new RegExp(`['"\`]${route.replace(/[/.]/gu, '\\$&')}['"\`?]`, 'u').test(text)).map((route) => `${file}: ${route}`);
    });
    expect(named).toEqual([]);
  });
});
