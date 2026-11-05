import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importsOf, PRODUCT_SOURCE } from '../support/source-imports.js';

// Guards the user: the window runs the web bundle in a browser, which has no Node. The bundle shares
// modules with the server (the core error, the source registry, collection settings, each plugin's shared
// declarations), and a Node module imported into one of them still builds, but the window breaks when
// it loads. This walks every file the bundle's entry reaches through imports that keep code, and fails
// on an import of a Node built-in module. Type-only imports are erased from the bundle and not walked.

const ENTRY_PAGE = 'src/web/index.html';
const NODE_BUILTINS = new Set(builtinModules);

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(specifier.split('/')[0]!);
}

/** The entry script of the page, as a repo path. */
function entryScript(): string {
  const source = /<script\b[^>]*\bsrc="\/?([^"]+)"/u.exec(readFileSync(ENTRY_PAGE, 'utf8'));
  if (!source) throw new Error(`${ENTRY_PAGE} has no entry script`);
  return path.posix.join(path.posix.dirname(ENTRY_PAGE), source[1]!);
}

/** Every file the bundle reaches, with the import chain that first reaches it. */
function bundleFiles(): Map<string, string[]> {
  const entry = entryScript();
  const reached = new Map<string, string[]>([[entry, [entry]]]);
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.shift()!;
    for (const edge of importsOf(file)) {
      if (edge.typeOnly || edge.target === null || !PRODUCT_SOURCE.test(edge.target) || reached.has(edge.target)) continue;
      reached.set(edge.target, [...reached.get(file)!, edge.target]);
      pending.push(edge.target);
    }
  }
  return reached;
}

const bundle = bundleFiles();

describe('a web bundle without Node code', () => {
  it('walks the bundle from its entry into the modules it shares with the server', () => {
    expect([...bundle.keys()]).toEqual(expect.arrayContaining([
      'src/web/main.tsx',
      'src/web/App.tsx',
      'src/core/collector-error.ts',
      'src/core/source-registry.ts',
      'src/core/collection-settings.ts',
      'src/plugins/youtube/shared.ts',
      'src/plugins/youtube/settings.ts',
      'src/plugins/rss/settings.ts',
    ]));
  });

  it('imports no Node built-in module into the bundle', () => {
    const nodeImports = [...bundle].flatMap(([file, chain]) => importsOf(file)
      .filter((edge) => !edge.typeOnly && isNodeBuiltin(edge.specifier))
      .map((edge) => `${chain.join(' -> ')} imports ${edge.specifier}`));
    expect(nodeImports).toEqual([]);
  });
});
