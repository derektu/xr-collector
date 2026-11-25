import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

// The module structure of `src` that the layer test (tests/tooling/import-layers.test.ts) and the
// comment rule (tooling/eslint/comment-policy.ts) both read: the layers, the entries of a module and
// the imports of a file. docs/architecture.md describes the structure.

/**
 * The layers, from the bottom up: each is a folder directly under `src`, and each folder under a layer is
 * one module of it, such as `domain/jobs`, with every file below that folder.
 */
export const LAYERS: ReadonlyArray<{ folder: string; name: string }> = [
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

/** A file of a module that other modules import. */
export interface Entry {
  file: string;
  /** The only modules that may import it; any module may when absent. */
  importers?: readonly string[];
  /** The web page builds it, so no Node built-in module is reached from it through imports that keep code. */
  browserSafe?: true;
}

/**
 * The entries of a module. `index.ts` is the entry. A module whose index carries Node code and whose
 * declarations the web page needs gives them their own entry, `declarations.ts`. A module with code that
 * only one module assembles gives it an entry that only that module imports: the source types' server
 * entries go to the product's source list alone, so the server, which recognizes addresses across every
 * type through the index, does not depend on any one type. `shared` has no entry: it is a set of
 * contracts, and each of its files is imported by name.
 */
export const ENTRIES: readonly Entry[] = [
  { file: 'index.ts' },
  { file: 'declarations.ts', browserSafe: true },
  { file: 'server-entries.ts', importers: ['app/plugins'] },
];

const LAYER_FOLDERS = new Set(LAYERS.map((layer) => layer.folder));

/** The module of a repo path under `src`, such as `domain/jobs`; null outside a module. */
export function moduleOf(file: string): string | null {
  const parts = file.split('/');
  if (parts[0] !== 'src' || !LAYER_FOLDERS.has(parts[1]!)) return null;
  if (parts[1] === 'shared') return parts.length > 3 ? 'shared' : null;
  return parts.length > 3 ? `${parts[1]}/${parts[2]}` : null;
}

/** Whether a repo path is one of its module's entries, such as `src/domain/jobs/index.ts`. */
export function isEntry(file: string): boolean {
  const module = moduleOf(file);
  return module !== null && module !== 'shared' && ENTRIES.some((entry) => file === `src/${module}/${entry.file}`);
}

/** One import or re-export in a product file, with its relative target resolved to a repo path. */
export interface SourceImport {
  /** The importing file, as a repo path such as `src/domain/vault/collector.ts`. */
  from: string;
  /** The specifier as written, such as `../jobs/job-store.js` or `node:fs`. */
  specifier: string;
  /** The repo path the relative specifier names, or null for a package or built-in module. */
  target: string | null;
  /** Whether the import names only types, so nothing of the target reaches the compiled output. */
  typeOnly: boolean;
  /** Whether it is an `export … from`, which makes the target's exports part of the importing file's. */
  reExport: boolean;
}

/**
 * Comments removed, so an import written in a comment is not read. A `//` right after `:` stays,
 * because that is a URL in a string.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:\\])\/\/[^\n]*/gu, '$1');
}

/** `import … from`, `export … from` and `import '…'`, across lines. */
const STATIC = /(?:^|[;\s])(import|export)\s+(type\s+)?(?:([\w*${}\s,]*?)\s*from\s*)?['"]([^'"\n]+)['"]/gu;
/** `import('…')`, and `typeof import('…')` in a type position. */
const DYNAMIC = /(typeof\s+)?\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/gu;

/** A clause such as `{ type A, type B }` that brings in only types. */
function namesOnlyTypes(clause: string): boolean {
  const named = /^\{([\s\S]*)\}$/u.exec(clause.trim());
  if (!named) return false;
  const specifiers = named[1]!.split(',').map((specifier) => specifier.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((specifier) => /^type\s/u.test(specifier));
}

/** The repo path a relative specifier names: `.js` stands for the `.ts` source, and a directory for its index. */
function resolve(root: string, from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const stem = base.replace(/\.(?:js|jsx|cjs|mjs)$/u, '');
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.cts`, `${stem}/index.ts`, `${stem}/index.tsx`];
  return candidates.find((file) => {
    const absolute = path.join(root, file);
    return existsSync(absolute) && statSync(absolute).isFile();
  }) ?? base;
}

/** The imports and re-exports of a repo path `file`, read from under `root`. */
export function importsOf(file: string, root = '.'): SourceImport[] {
  const text = withoutComments(readFileSync(path.join(root, file), 'utf8'));
  const found: SourceImport[] = [];
  for (const match of text.matchAll(STATIC)) {
    const specifier = match[4]!;
    const typeOnly = match[2] !== undefined || (match[3] !== undefined && namesOnlyTypes(match[3]));
    found.push({ from: file, specifier, target: resolve(root, file, specifier), typeOnly, reExport: match[1] === 'export' });
  }
  for (const match of text.matchAll(DYNAMIC)) {
    const specifier = match[2]!;
    found.push({ from: file, specifier, target: resolve(root, file, specifier), typeOnly: match[1] !== undefined, reExport: false });
  }
  return found;
}

const NODE_BUILTINS = new Set(builtinModules);

/** Whether the specifier names a Node built-in module, such as `node:fs` or `fs/promises`. */
export function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(specifier.split('/')[0]!);
}
