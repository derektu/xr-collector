import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeReachedFrom, nodeImportsIn } from '../support/source-imports.js';

// Guards the user: the window runs the web bundle in a browser, which has no Node. The bundle shares
// modules with the server (the core error, the source registry, collection settings, each plugin's shared
// declarations), and a Node module imported into one of them still builds, but the window breaks when
// it loads. This walks every file the bundle's entry reaches through imports that keep code, and fails
// on an import of a Node built-in module. Type-only imports are erased from the bundle and not walked.

const ENTRY_PAGE = 'src/transport/web/index.html';

/** The entry script of the page, as a repo path. */
function entryScript(): string {
  const source = /<script\b[^>]*\bsrc="\/?([^"]+)"/u.exec(readFileSync(ENTRY_PAGE, 'utf8'));
  if (!source) throw new Error(`${ENTRY_PAGE} has no entry script`);
  return path.posix.join(path.posix.dirname(ENTRY_PAGE), source[1]!);
}

const bundle = codeReachedFrom(entryScript());

describe('a web bundle without Node code', () => {
  it('walks the bundle from its entry into the modules it shares with the server', () => {
    expect([...bundle.keys()]).toEqual(expect.arrayContaining([
      'src/transport/web/main.tsx',
      'src/transport/web/App.tsx',
      'src/shared/lib/collector-error.ts',
      'src/shared/sources/source-registry.ts',
      'src/shared/sources/collection-settings.ts',
      'src/domain/sources/youtube/shared.ts',
      'src/domain/sources/youtube/settings.ts',
      'src/domain/sources/rss/settings.ts',
    ]));
  });

  it('imports no Node built-in module into the bundle', () => {
    expect(nodeImportsIn(bundle)).toEqual([]);
  });
});
