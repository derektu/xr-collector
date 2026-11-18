import { describe, expect, it } from 'vitest';
import { importsOf, productFiles } from '../support/source-imports.js';

// Guards the developer, not the user: a module that imports a module above it ties the two together, so a change in
// the upper one can break the lower one, and the two can no longer be read, tested or replaced alone.
// Every product file belongs to a module, and every module to a layer. A file imports its own module,
// any module of a lower layer except those `NOT_BELOW` lists, and the modules of its own layer that
// `SAME_LAYER` lists. Type-only imports count: they tie the two modules' shapes together just the same.
// Another module is imported only through its entry (`ENTRIES`), so the rest of its files stay
// internal and can change without touching the modules that use it.

/**
 * The layers, from the bottom up: each is a folder directly under `src`, and each folder under a layer is
 * one module of it, such as `domain/jobs`, with every file below that folder.
 */
const LAYERS: ReadonlyArray<{ folder: string; name: string }> = [
  // The plugin contract (`shared/sources/source-contract.ts`) is shared: the domain reads the source types'
  // declarations through it, and it holds only types and pure functions. The shared folders group these
  // files by domain and import each other freely, so the whole layer is one module.
  { folder: 'shared', name: 'shared types, pure functions and the plugin contract' },
  { folder: 'domain', name: 'domain services, the source types among them' },
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
  // Only the type of the priority a capture asks the request channel for.
  'domain/sources': ['domain/pacing'],
};

/** The modules of a lower layer that a module still may not import. */
const NOT_BELOW: Readonly<Record<string, readonly string[]>> = {
  // The desktop shell starts the HTTP server and loads the web page from it; it reaches the page only
  // through IPC and HTTP and never runs the page's code.
  'desktop/electron': ['transport/web'],
};

/**
 * The files of a module that other modules import. `index.ts` is the entry. A module whose index
 * carries Node code and whose declarations the web page needs gives them their own entry,
 * `declarations.ts`, which tests/tooling/web-bundle-node.test.ts keeps free of Node code. `shared` has
 * no entry: it is a set of contracts, and each of its files is imported by name.
 */
const ENTRIES = ['index.ts', 'declarations.ts'];

const LAYER_OF = new Map(LAYERS.map((layer, rank) => [layer.folder, rank] as const));

/** The module of a file under `src`, such as `domain/jobs`; null outside a module. */
function moduleOf(file: string): string | null {
  const parts = file.split('/');
  if (parts[0] !== 'src' || !LAYER_OF.has(parts[1]!)) return null;
  if (parts[1] === 'shared') return parts.length > 3 ? 'shared' : null;
  return parts.length > 3 ? `${parts[1]}/${parts[2]}` : null;
}

const layerOf = (module: string): number => LAYER_OF.get(module.split('/')[0]!)!;

function allowed(from: string, to: string): boolean {
  if (from === to) return true;
  const fromLayer = layerOf(from);
  const toLayer = layerOf(to);
  if (toLayer < fromLayer) return !(NOT_BELOW[from] ?? []).includes(to);
  return toLayer === fromLayer && (SAME_LAYER[from] ?? []).includes(to);
}

/** Why the import of `target` from `file` passes another module's entry by, or null when it does not. */
function pastEntry(file: string, target: string): string | null {
  const from = moduleOf(file)!;
  const to = moduleOf(target)!;
  if (from === to || to === 'shared') return null;
  if (ENTRIES.some((entry) => target === `src/${to}/${entry}`)) return null;
  return `${file} imports ${target}, inside ${to}; import src/${to}/index.ts and export what it needs from there`;
}

const files = productFiles();
const edges = [...new Set(files.flatMap(importsOf)
  .filter((edge) => edge.target?.startsWith('src/'))
  .map((edge) => `${edge.from} -> ${edge.target}`))].sort();
const violations = edges.filter((edge) => {
  const [from, to] = edge.split(' -> ') as [string, string];
  return !allowed(moduleOf(from)!, moduleOf(to)!);
});
const pastEntries = edges.flatMap((edge) => {
  const [from, to] = edge.split(' -> ') as [string, string];
  return pastEntry(from, to) ?? [];
});

describe('imports that follow the layers', () => {
  it('reads the imports of every product file', () => {
    expect(files.length).toBeGreaterThan(150);
    expect(edges).toEqual(expect.arrayContaining([
      'src/domain/jobs/job-manager.ts -> src/shared/jobs/job-types.ts',
      'src/transport/web/App.tsx -> src/shared/jobs/job-role.ts',
      'src/desktop/electron/main.ts -> src/transport/server/index.ts',
      'src/transport/server/collector-server.ts -> src/app/runtime/index.ts',
      'src/app/plugins/declarations.ts -> src/domain/sources/declarations.ts',
    ]));
  });

  it('puts every product file in a module of a layer', () => {
    expect(files.filter((file) => moduleOf(file) === null)).toEqual([]);
  });

  it('imports only its own module, lower layers and the listed modules of its own layer', () => {
    expect(violations).toEqual([]);
  });

  it('imports another module only through its entry', () => {
    expect(pastEntries).toEqual([]);
  });

  it('names the importing file and the entry to use when an import passes an entry by', () => {
    expect(pastEntry('src/app/runtime/job-records.ts', 'src/domain/jobs/job-store.ts')).toBe(
      'src/app/runtime/job-records.ts imports src/domain/jobs/job-store.ts, inside domain/jobs; import src/domain/jobs/index.ts and export what it needs from there',
    );
    expect(pastEntry('src/app/runtime/job-records.ts', 'src/domain/jobs/index.ts')).toBeNull();
    expect(pastEntry('src/app/plugins/declarations.ts', 'src/domain/sources/declarations.ts')).toBeNull();
    expect(pastEntry('src/domain/jobs/job-manager.ts', 'src/domain/jobs/job-store.ts')).toBeNull();
    expect(pastEntry('src/domain/jobs/job-manager.ts', 'src/shared/jobs/job-types.ts')).toBeNull();
  });

  it('lets the desktop shell import the server but not the web page', () => {
    expect(allowed('desktop/electron', 'transport/server')).toBe(true);
    expect(allowed('desktop/electron', 'transport/web')).toBe(false);
  });
});
