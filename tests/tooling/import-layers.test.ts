import { describe, expect, it } from 'vitest';
import { importsOf, productFiles } from '../support/source-imports.js';

// Guards the developer, not the user: a module that imports a module above it ties the two together, so a change in
// the upper one can break the lower one, and the two can no longer be read, tested or replaced alone.
// Every product file belongs to a module, and every module to a layer. A file imports its own module,
// any module of a lower layer, and the modules of its own layer that `SAME_LAYER` lists. Type-only
// imports count: they tie the two modules' shapes together just the same.
//
// `EXCEPTIONS` lists the imports that break the rule today, one `file -> file` edge per line. The list
// only gets shorter: an import that breaks the rule and is not listed fails, and so does a listed
// line whose import no longer breaks it, so the ticket that removes an edge deletes its line.

/** The layers, from the bottom up. */
const LAYERS: ReadonlyArray<{ name: string; modules: readonly string[] }> = [
  { name: 'shared types and pure functions', modules: ['core'] },
  { name: 'plugin contract', modules: ['plugins/types'] },
  {
    name: 'domain services',
    modules: [
      'activity', 'jobs', 'notifications', 'pacing', 'search', 'sources', 'subscriptions', 'updates', 'vault',
      'plugins/<type>',
    ],
  },
  { name: 'assembly', modules: ['plugins/index', 'runtime', 'vault/workspace'] },
  { name: 'transport', modules: ['electron', 'server', 'web'] },
];

/** The modules of its own layer that a module may import. */
const SAME_LAYER: Readonly<Record<string, readonly string[]>> = {
  jobs: ['pacing'],
  // Only types: the subscription port and the work facts (tests/tooling/subscription-seam.test.ts).
  subscriptions: ['jobs'],
  'plugins/<type>': ['pacing'],
  runtime: ['vault/workspace'],
};

/** Files whose module is not their directory. */
const FILE_MODULES: Readonly<Record<string, string>> = {
  'src/plugins/types.ts': 'plugins/types',
  'src/plugins/index.ts': 'plugins/index',
  'src/vault/workspace.ts': 'vault/workspace',
};

const EXCEPTIONS = [
  // core -> plugin contract: the cycle core/types -> core/source-registry -> plugins/types -> core/types.
  'src/core/collection-settings.ts -> src/plugins/types.ts',
  'src/core/collector.ts -> src/plugins/types.ts',
  'src/core/source-registry.ts -> src/plugins/types.ts',
  // core -> jobs, vault: core and vault import each other.
  'src/core/collector.ts -> src/jobs/job-store.ts',
  'src/core/collector.ts -> src/vault/deleted-documents.ts',
  'src/core/collector.ts -> src/vault/document-paths.ts',
  // jobs -> activity: redaction (#254), the activity log owned by the job store (#262).
  'src/jobs/job-manager.ts -> src/activity/redact.ts',
  'src/jobs/job-store.ts -> src/activity/activity-log.ts',
  // jobs -> subscriptions: the candidate rules run in the job manager (#263).
  'src/jobs/job-manager.ts -> src/subscriptions/candidates.ts',
  // notifications -> activity: redaction (#254).
  'src/notifications/notification-center.ts -> src/activity/redact.ts',
  // subscriptions -> vault: the vault format mark (#257).
  'src/subscriptions/subscription-store.ts -> src/vault/vault-directory.ts',
  // vault -> subscriptions: the exchange reads and writes the subscription files (#256).
  'src/vault/vault-directory.ts -> src/subscriptions/subscription-files.ts',
  'src/vault/vault-merge.ts -> src/subscriptions/subscription-files.ts',
  'src/vault/vault-package.ts -> src/subscriptions/subscription-files.ts',
  // updates -> runtime: the build identity.
  'src/updates/release-index.ts -> src/runtime/build-info.ts',
  // runtime -> server: runtime and server import each other (#265).
  'src/runtime/collector-runtime.ts -> src/server/agent-access.ts',
  'src/runtime/collector-runtime.ts -> src/server/app.ts',
  'src/runtime/collector-runtime.ts -> src/server/start.ts',
];

const LAYER_OF = new Map(LAYERS.flatMap((layer, rank) => layer.modules.map((module) => [module, rank] as const)));

/** The module of a file under `src`, such as `jobs` or `plugins/youtube`. */
function moduleOf(file: string): string | null {
  if (FILE_MODULES[file]) return FILE_MODULES[file];
  const parts = file.split('/');
  if (parts[0] !== 'src' || parts.length < 3) return null;
  if (parts[1] === 'plugins' && parts.length > 3) return `plugins/${parts[2]}`;
  return parts[1]!;
}

/** The entry of `LAYERS` and `SAME_LAYER` for a module: every source type's plugin is `plugins/<type>`. */
function tableEntry(module: string): string {
  return module.startsWith('plugins/') && !LAYER_OF.has(module) ? 'plugins/<type>' : module;
}

function allowed(from: string, to: string): boolean {
  if (from === to) return true;
  const fromLayer = LAYER_OF.get(tableEntry(from))!;
  const toLayer = LAYER_OF.get(tableEntry(to))!;
  return toLayer < fromLayer || (toLayer === fromLayer && (SAME_LAYER[tableEntry(from)] ?? []).includes(tableEntry(to)));
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
      'src/jobs/job-manager.ts -> src/core/types.ts',
      'src/web/App.tsx -> src/core/source-registry.ts',
      'src/electron/main.ts -> src/runtime/collector-runtime.ts',
    ]));
  });

  it('puts every product file in a module of a layer', () => {
    const unplaced = [...new Set(files.map((file) => moduleOf(file) ?? file))]
      .filter((module) => !LAYER_OF.has(tableEntry(module)));
    expect(unplaced).toEqual([]);
  });

  it('imports only its own module, lower layers and the listed modules of its own layer', () => {
    expect(violations.filter((edge) => !EXCEPTIONS.includes(edge))).toEqual([]);
  });

  it('lists only imports that still break the layers', () => {
    expect(EXCEPTIONS.filter((edge) => !violations.includes(edge))).toEqual([]);
  });
});
