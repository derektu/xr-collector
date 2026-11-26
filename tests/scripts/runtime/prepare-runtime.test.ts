// The `prepare:runtime` command: it accepts only the two delivery targets, fills the runtime cache
// for yt-dlp and Deno before Meilisearch, and the npm scripts that set up a checkout call it, so a
// fresh clone gets both runtimes from one command.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error The script is executable JavaScript without type declarations.
import { parsePrepareRuntimeArguments, prepareRuntime } from '../../../scripts/runtime/prepare-runtime.mjs';

it('parses the prepare command and fills the cache before installing both runtimes', async () => {
  expect(parsePrepareRuntimeArguments(['mac'])).toEqual({ target: 'darwin-arm64', cacheOnly: false });
  expect(parsePrepareRuntimeArguments(['win', '--cache-only'])).toEqual({ target: 'win32-x64', cacheOnly: true });
  expect(() => parsePrepareRuntimeArguments(['linux'])).toThrow(/prepare:runtime -- <mac\|win>/u);
  expect(() => parsePrepareRuntimeArguments(['mac', '--verbose'])).toThrow(/Unknown argument --verbose/u);
  const calls: unknown[] = [];
  await prepareRuntime({ target: 'darwin-arm64', cacheOnly: true }, {
    prepareRuntimeDependencies: async (options: unknown) => { calls.push(['dependencies', options]); },
    prepareMeilisearch: async (options: unknown) => { calls.push(['meilisearch', options]); },
  });
  expect(calls).toEqual([
    ['dependencies', { target: 'darwin-arm64', cacheOnly: true }],
    ['meilisearch', { target: 'darwin-arm64', cacheOnly: true }],
  ]);
  const scripts = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')).scripts as Record<string, string>;
  expect(scripts['prepare:runtime']).toBe('node scripts/runtime/prepare-runtime.mjs');
  expect(scripts['download:runtime']).toBe('node scripts/runtime/prepare-runtime.mjs mac');
  expect(scripts['download:runtime:win']).toBe('node scripts/runtime/prepare-runtime.mjs win');
});
