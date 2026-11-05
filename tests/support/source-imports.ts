import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** One import or re-export in a product file, with its relative target resolved to a repo path. */
export interface SourceImport {
  /** The importing file, as a repo path such as `src/core/collector.ts`. */
  from: string;
  /** The specifier as written, such as `../jobs/job-store.js` or `node:fs`. */
  specifier: string;
  /** The repo path the relative specifier names, or null for a package or built-in module. */
  target: string | null;
  /** Whether the import names only types, so nothing of the target reaches the compiled output. */
  typeOnly: boolean;
}

export const PRODUCT_SOURCE = /\.(?:ts|tsx|cts)$/u;

export function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

/** The product files that compile to code: TypeScript under `src`, without declaration files. */
export function productFiles(): string[] {
  return filesUnder('src').filter((file) => PRODUCT_SOURCE.test(file) && !file.endsWith('.d.ts'));
}

/**
 * Comments removed, so an import written in a comment is not read. A `//` right after `:` stays,
 * because that is a URL in a string.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:\\])\/\/[^\n]*/gu, '$1');
}

/** `import … from`, `export … from` and `import '…'`, across lines. */
const STATIC = /(?:^|[;\s])(?:import|export)\s+(type\s+)?(?:([\w*${}\s,]*?)\s*from\s*)?['"]([^'"\n]+)['"]/gu;
/** `import('…')`, and `typeof import('…')` in a type position. */
const DYNAMIC = /(typeof\s+)?\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/gu;

/** A clause such as `{ type A, type B }` that brings in only types. */
function namesOnlyTypes(clause: string): boolean {
  const named = /^\{([\s\S]*)\}$/u.exec(clause.trim());
  if (!named) return false;
  const specifiers = named[1]!.split(',').map((specifier) => specifier.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((specifier) => /^type\s/u.test(specifier));
}

/** The file a relative specifier names: `.js` stands for the `.ts` source, and a directory for its index. */
function resolve(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const stem = base.replace(/\.(?:js|jsx|cjs|mjs)$/u, '');
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.cts`, `${stem}/index.ts`, `${stem}/index.tsx`];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile()) ?? base;
}

export function importsOf(file: string): SourceImport[] {
  const text = withoutComments(readFileSync(file, 'utf8'));
  const found: SourceImport[] = [];
  for (const match of text.matchAll(STATIC)) {
    const specifier = match[3]!;
    const typeOnly = match[1] !== undefined || (match[2] !== undefined && namesOnlyTypes(match[2]));
    found.push({ from: file, specifier, target: resolve(file, specifier), typeOnly });
  }
  for (const match of text.matchAll(DYNAMIC)) {
    const specifier = match[2]!;
    found.push({ from: file, specifier, target: resolve(file, specifier), typeOnly: match[1] !== undefined });
  }
  return found;
}
