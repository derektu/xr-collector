import { describe, expect, it } from 'vitest';
import { importsOf, productFiles } from '../support/source-imports.js';

// Guards the developer, not the user: a module that imports a module above it ties the two together, so a change in
// the upper one can break the lower one, and the two can no longer be read, tested or replaced alone.
// Every product file belongs to a module, and every module to a layer. A file imports its own module,
// any module of a lower layer except those `NOT_BELOW` lists, and the modules of its own layer that
// `SAME_LAYER` lists. Type-only imports count: they tie the two modules' shapes together just the same.

/**
 * The layers, from the bottom up: each is a folder directly under `src`, and each folder under a layer is
 * one module of it, such as `domain/jobs`. A source type's plugin is its own module, `domain/plugins/<type>`.
 */
const LAYERS: ReadonlyArray<{ folder: string; name: string }> = [
  // The plugin contract (`shared/sources/source-contract.ts`) is shared: the domain reads the source types'
  // declarations through it, and it holds only types and pure functions. The shared folders group these
  // files by domain and import each other freely, so the whole layer is one module.
  { folder: 'shared', name: 'shared types, pure functions and the plugin contract' },
  { folder: 'domain', name: 'domain services and the source types\' plugins' },
  { folder: 'app', name: 'assembly: the runtime and the product\'s source list' },
  { folder: 'transport', name: 'transport' },
  // The desktop shell starts the HTTP server of its process.
  { folder: 'desktop', name: 'desktop shell' },
];

/** The modules of its own layer that a module may import. */
const SAME_LAYER: Readonly<Record<string, readonly string[]>> = {
  // `domain/vault` only for the type of the `Collector` that saves the captured documents.
  'domain/jobs': ['domain/pacing', 'domain/vault'],
  // Only types: the subscription port and the work facts (tests/tooling/subscription-seam.test.ts).
  'domain/subscriptions': ['domain/jobs'],
  'domain/plugins/<type>': ['domain/pacing'],
};

/** The modules of a lower layer that a module still may not import. */
const NOT_BELOW: Readonly<Record<string, readonly string[]>> = {
  // The desktop shell starts the HTTP server and loads the web page from it; it reaches the page only
  // through IPC and HTTP and never runs the page's code.
  'desktop/electron': ['transport/web'],
};

const LAYER_OF = new Map(LAYERS.map((layer, rank) => [layer.folder, rank] as const));

/** The module of a file under `src`, such as `domain/jobs` or `domain/plugins/youtube`; null outside a module. */
function moduleOf(file: string): string | null {
  const parts = file.split('/');
  if (parts[0] !== 'src' || !LAYER_OF.has(parts[1]!)) return null;
  if (parts[1] === 'shared') return parts.length > 3 ? 'shared' : null;
  if (parts[1] === 'domain' && parts[2] === 'plugins') return parts.length > 4 ? `domain/plugins/${parts[3]}` : null;
  return parts.length > 3 ? `${parts[1]}/${parts[2]}` : null;
}

/** The entry of `SAME_LAYER` and `NOT_BELOW` for a module: every source type's plugin is `domain/plugins/<type>`. */
function tableEntry(module: string): string {
  return module.startsWith('domain/plugins/') ? 'domain/plugins/<type>' : module;
}

const layerOf = (module: string): number => LAYER_OF.get(module.split('/')[0]!)!;

function allowed(from: string, to: string): boolean {
  if (from === to) return true;
  const fromLayer = layerOf(from);
  const toLayer = layerOf(to);
  if (toLayer < fromLayer) return !(NOT_BELOW[tableEntry(from)] ?? []).includes(tableEntry(to));
  return toLayer === fromLayer && (SAME_LAYER[tableEntry(from)] ?? []).includes(tableEntry(to));
}

const files = productFiles();
const edges = [...new Set(files.flatMap(importsOf)
  .filter((edge) => edge.target?.startsWith('src/'))
  .map((edge) => `${edge.from} -> ${edge.target}`))].sort();
const violations = edges.filter((edge) => {
  const [from, to] = edge.split(' -> ') as [string, string];
  return !allowed(moduleOf(from)!, moduleOf(to)!);
});

describe('imports that follow the layers', () => {
  it('reads the imports of every product file', () => {
    expect(files.length).toBeGreaterThan(150);
    expect(edges).toEqual(expect.arrayContaining([
      'src/domain/jobs/job-manager.ts -> src/shared/jobs/job-types.ts',
      'src/transport/web/App.tsx -> src/shared/jobs/job-role.ts',
      'src/desktop/electron/main.ts -> src/transport/server/collector-server.ts',
      'src/transport/server/collector-server.ts -> src/app/runtime/collector-runtime.ts',
    ]));
  });

  it('puts every product file in a module of a layer', () => {
    expect(files.filter((file) => moduleOf(file) === null)).toEqual([]);
  });

  it('imports only its own module, lower layers and the listed modules of its own layer', () => {
    expect(violations).toEqual([]);
  });

  it('lets the desktop shell import the server but not the web page', () => {
    expect(allowed('desktop/electron', 'transport/server')).toBe(true);
    expect(allowed('desktop/electron', 'transport/web')).toBe(false);
  });
});
