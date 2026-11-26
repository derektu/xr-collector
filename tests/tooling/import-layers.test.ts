// Guards the developer, not the user: a module that imports past its layer or past another module's entries
// is tied to it, so a change in one breaks the other.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENTRIES, importsOf, LAYERS, moduleOf } from '../../tooling/source-structure.js';
import { codeReachedFrom, nodeImportsIn, productFiles } from '../support/source-imports.js';

type Allowance = 'types' | 'values';

const SAME_LAYER: Readonly<Record<string, Readonly<Record<string, Allowance>>>> = {
  'domain/jobs': { 'domain/pacing': 'types' },
  'domain/subscriptions': { 'domain/jobs': 'types' },
  'domain/sources': { 'domain/pacing': 'types' },
};

const NOT_BELOW: Readonly<Record<string, readonly string[]>> = {
  'desktop/electron': ['transport/web'],
};

const LAYER_OF = new Map(LAYERS.map((layer, rank) => [layer.folder, rank] as const));
const layerOf = (module: string): number => LAYER_OF.get(module.split('/')[0]!)!;

function allowed(from: string, to: string, typeOnly: boolean): boolean {
  if (from === to) return true;
  const fromLayer = layerOf(from);
  const toLayer = layerOf(to);
  if (toLayer < fromLayer) return !(NOT_BELOW[from] ?? []).includes(to);
  const allowance = toLayer === fromLayer ? SAME_LAYER[from]?.[to] : undefined;
  return allowance === 'values' || (allowance === 'types' && typeOnly);
}

function pastEntryMessage(file: string, target: string): string | null {
  const from = moduleOf(file)!;
  const to = moduleOf(target)!;
  if (from === to || to === 'shared') return null;
  const entry = ENTRIES.find(({ file: name }) => target === `src/${to}/${name}`);
  if (!entry) return `${file} imports ${target}, inside ${to}; import src/${to}/index.ts and export what it needs from there`;
  if (entry.importers && !entry.importers.includes(from)) {
    return `${file} imports ${target}, the entry of ${to} for ${entry.importers.join(', ')} only; import src/${to}/index.ts`;
  }
  return null;
}

const files = productFiles();
const typeOnlyByImportPair = new Map<string, boolean>();
for (const edge of files.flatMap((file) => importsOf(file))) {
  if (!edge.target?.startsWith('src/')) continue;
  const key = `${edge.from} -> ${edge.target}`;
  typeOnlyByImportPair.set(key, (typeOnlyByImportPair.get(key) ?? true) && edge.typeOnly);
}
const edges = [...typeOnlyByImportPair.keys()].sort();
const violations = edges.flatMap((edge) => {
  const [from, to] = edge.split(' -> ') as [string, string];
  const typeOnly = typeOnlyByImportPair.get(edge)!;
  if (allowed(moduleOf(from)!, moduleOf(to)!, typeOnly)) return [];
  const allowance = SAME_LAYER[moduleOf(from)!]?.[moduleOf(to)!];
  return allowance === 'types' ? `${edge} imports values; ${moduleOf(from)} takes only types from ${moduleOf(to)}` : edge;
});
const pastEntries = edges.flatMap((edge) => {
  const [from, to] = edge.split(' -> ') as [string, string];
  return pastEntryMessage(from, to) ?? [];
});
const browserSafeEntries = [...new Set(files.map(moduleOf))]
  .filter((module): module is string => module !== null && module !== 'shared')
  .flatMap((module) => ENTRIES.filter((entry) => entry.browserSafe).map((entry) => `src/${module}/${entry.file}`))
  .filter((file) => existsSync(file))
  .sort();

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

  it('imports another module only through its entries, each from the modules it serves', () => {
    expect(pastEntries).toEqual([]);
  });

  it('reaches no Node built-in module from a browser-safe entry', () => {
    expect(browserSafeEntries).toEqual(['src/app/plugins/declarations.ts', 'src/domain/sources/declarations.ts']);
    expect(browserSafeEntries.flatMap((entry) => nodeImportsIn(codeReachedFrom(entry)))).toEqual([]);
  });

  it('names the importing file and the entry to use when an import passes an entry by', () => {
    expect(pastEntryMessage('src/app/runtime/job-records.ts', 'src/domain/jobs/job-store.ts')).toBe(
      'src/app/runtime/job-records.ts imports src/domain/jobs/job-store.ts, inside domain/jobs; import src/domain/jobs/index.ts and export what it needs from there',
    );
    expect(pastEntryMessage('src/app/runtime/job-records.ts', 'src/domain/jobs/index.ts')).toBeNull();
    expect(pastEntryMessage('src/app/plugins/declarations.ts', 'src/domain/sources/declarations.ts')).toBeNull();
    expect(pastEntryMessage('src/domain/jobs/job-manager.ts', 'src/domain/jobs/job-store.ts')).toBeNull();
    expect(pastEntryMessage('src/domain/jobs/job-manager.ts', 'src/shared/jobs/job-types.ts')).toBeNull();
  });

  it('lets only the product\'s source list import the source types\' server entries', () => {
    expect(pastEntryMessage('src/app/plugins/index.ts', 'src/domain/sources/server-entries.ts')).toBeNull();
    expect(pastEntryMessage('src/transport/server/app.ts', 'src/domain/sources/server-entries.ts')).toBe(
      'src/transport/server/app.ts imports src/domain/sources/server-entries.ts, the entry of domain/sources for app/plugins only; import src/domain/sources/index.ts',
    );
  });

  it('takes only types from a module of its own layer that allows only types', () => {
    expect(allowed('domain/subscriptions', 'domain/jobs', true)).toBe(true);
    expect(allowed('domain/subscriptions', 'domain/jobs', false)).toBe(false);
    expect(allowed('domain/jobs', 'domain/subscriptions', true)).toBe(false);
  });

  it('lets the desktop shell import the server but not the web page', () => {
    expect(allowed('desktop/electron', 'transport/server', false)).toBe(true);
    expect(allowed('desktop/electron', 'transport/web', true)).toBe(false);
  });
});
