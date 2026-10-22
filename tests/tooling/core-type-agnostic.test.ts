import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The core knows source types only through the plugin contract and the registry (P-T3, R11-T8). Only the plugins
// and the two assembly lists name a type: `src/plugins/index.ts` for the server processes and
// `src/web/plugins.tsx` (with its stylesheet) for the UI. The contract itself names none.

const CORE_DIRECTORIES = [
  'src/core', 'src/jobs', 'src/subscriptions', 'src/pacing', 'src/vault', 'src/search', 'src/activity', 'src/server',
  'src/sources', 'src/runtime', 'src/web',
];
const CONTRACT = 'src/plugins/types.ts';
/** The files under `src/plugins` a core file may import: the contract and the server assembly list. */
const PLUGIN_ENTRIES = new Set([CONTRACT, 'src/plugins/index.ts']);
const WEB_ASSEMBLY = new Set(['src/web/plugins.tsx', 'src/web/plugins.css']);
const TYPE_NAME = /youtube|yt-?dlp|rss/iu;
/** A subscription is a `subscriptionId` in the core; `channelId` is YouTube's word. */
const CHANNEL_ID = /channelId/iu;
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu;

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

const coreFiles = [...CORE_DIRECTORIES.flatMap(filesUnder), CONTRACT]
  .filter((file) => /\.(?:ts|tsx|css)$/u.test(file) && !WEB_ASSEMBLY.has(file));

describe('a core that names no source type (P-T3)', () => {
  it('reads the core files it checks', () => {
    expect(coreFiles.length).toBeGreaterThan(50);
    expect(coreFiles).toEqual(expect.arrayContaining(['src/jobs/job-manager.ts', 'src/server/app.ts', 'src/web/App.tsx', CONTRACT]));
  });

  it('leaves YouTube, yt-dlp and RSS out of every core file', () => {
    const naming = coreFiles.flatMap((file) => readFileSync(file, 'utf8').split('\n')
      .map((line, index) => TYPE_NAME.test(line) ? `${file}:${index + 1}: ${line.trim()}` : null)
      .filter((line): line is string => line !== null));
    expect(naming).toEqual([]);
  });

  it('names a subscription subscriptionId, never channelId, in every core file', () => {
    const naming = coreFiles.flatMap((file) => readFileSync(file, 'utf8').split('\n')
      .map((line, index) => CHANNEL_ID.test(line) ? `${file}:${index + 1}: ${line.trim()}` : null)
      .filter((line): line is string => line !== null));
    expect(naming).toEqual([]);
  });

  it.each(['youtube', 'rss'])('imports no file of the %s plugin from the core', (type) => {
    const imports = coreFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(IMPORT)]
      .map((match) => match[1]!)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)))
      .filter((target) => target.startsWith(`src/plugins/${type}/`))
      .map((target) => `${file} -> ${target}`));
    expect(imports).toEqual([]);
  });

  it('imports nothing under src/plugins from the core but the contract and the server assembly list', () => {
    const imports = coreFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(IMPORT)]
      .map((match) => match[1]!)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.js$/u, '.ts'))
      .filter((target) => target.startsWith('src/plugins/') && !PLUGIN_ENTRIES.has(target))
      .map((target) => `${file} -> ${target}`));
    expect(imports).toEqual([]);
  });
});
