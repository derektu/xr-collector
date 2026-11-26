// A core file that names a source type has to change whenever a source type is added, changed or removed.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE_DIRECTORIES = [
  'src/shared', 'src/domain/jobs', 'src/domain/subscriptions', 'src/domain/pacing', 'src/domain/vault', 'src/domain/search',
  'src/domain/activity', 'src/transport/server', 'src/domain/sources', 'src/app/runtime', 'src/transport/web',
];
const CONTRACT = 'src/shared/sources/source-contract.ts';
const PLUGIN_FILE = /^src\/domain\/sources\/[^/]+\//u;
const ASSEMBLY = new Set([
  'src/transport/web/plugins.tsx', 'src/transport/web/plugins.css', 'src/domain/sources/declarations.ts', 'src/domain/sources/server-entries.ts',
]);
const TYPE_NAME = /youtube|yt-?dlp|rss/iu;
const CHANNEL_ID = /channelId/iu;
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu;

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

const coreFiles = CORE_DIRECTORIES.flatMap(filesUnder)
  .filter((file) => /\.(?:ts|tsx|css)$/u.test(file) && !ASSEMBLY.has(file) && !PLUGIN_FILE.test(file));

describe('a core that names no source type (P-T3)', () => {
  it('reads the core files it checks', () => {
    expect(coreFiles.length).toBeGreaterThan(50);
    expect(coreFiles).toEqual(expect.arrayContaining([
      'src/domain/jobs/job-manager.ts', 'src/transport/server/app.ts', 'src/transport/web/App.tsx', 'src/domain/sources/source-types.ts',
      'src/domain/sources/index.ts', CONTRACT,
    ]));
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
      .filter((target) => target.startsWith(`src/domain/sources/${type}/`))
      .map((target) => `${file} -> ${target}`));
    expect(imports).toEqual([]);
  });

  it('imports no source type\'s plugin from the core', () => {
    const imports = coreFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(IMPORT)]
      .map((match) => match[1]!)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)))
      .filter((target) => PLUGIN_FILE.test(target))
      .map((target) => `${file} -> ${target}`));
    expect(imports).toEqual([]);
  });
});
