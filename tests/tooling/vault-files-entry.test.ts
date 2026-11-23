import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { productFiles } from '../support/source-imports.js';

/** The stores of Vault files: each writes only through the entry it is given. */
const STORES = [
  'src/domain/subscriptions/subscription-store.ts',
  'src/domain/subscriptions/schedule-store.ts',
  'src/domain/vault/deleted-documents.ts',
  'src/domain/vault/markdown-vault.ts',
];

/** File system writes and the JSON file writers that wrap them. */
const WRITES = /\b(?:writeFile|writeJsonFile|replaceFile|rename|copyFile|rm|unlink|appendFile|mkdir|open)\b/u;

/** The modules a store could write files with: `fs`, `fs/promises` and the JSON file helpers. */
const WRITER_MODULES = /^(?:node:)?fs(?:\/promises)?$|json-file\.js$/u;

/**
 * What a file brings in from the writer modules that could write: a named write function, or a
 * namespace or default import, which reaches every function of the module. A dynamic import or
 * `require` of such a module counts as well.
 */
function writerImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(/import\s+(type\s+)?([^'";]*?)\s+from\s*['"]([^'"]+)['"]/gu)) {
    const [, typeOnly, clause = '', specifier = ''] = match;
    if (typeOnly || !WRITER_MODULES.test(specifier)) continue;
    const outside = clause.replace(/\{[^}]*\}/u, '').replace(/,/gu, '').trim();
    if (outside) found.push(`${outside} from ${specifier}`);
    const named = /\{([^}]*)\}/u.exec(clause)?.[1] ?? '';
    for (const name of named.split(',').map((part) => part.trim())) if (WRITES.test(name)) found.push(name);
  }
  for (const match of text.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    if (WRITER_MODULES.test(match[1]!)) found.push(`import(${match[1]})`);
  }
  return found;
}

describe('the one way into a Vault\'s files', () => {
  it('keeps the stores of Vault files writing only through the entry', () => {
    expect(productFiles()).toEqual(expect.arrayContaining(STORES));
    expect(STORES.flatMap((file) => writerImports(file).map((name) => `${file}: ${name}`))).toEqual([]);
  });
});
