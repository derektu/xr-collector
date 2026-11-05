import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { productFiles } from '../support/source-imports.js';

// Guards the developer, not the user: the Vault marker is raised by the one way into a Vault's files
// (`src/vault/vault-files.ts`), so no store can write a file of a newer format into a Vault an older
// program still opens. A store that raised the marker itself, or wrote its file without the entry,
// would make that safety depend on each store remembering it. What the entry writes and which
// marker each kind of file gets is in tests/plugins/format-versions.test.ts.

/** The file that defines the marker hook, and the entry, the only file that calls it. */
const DEFINES = 'src/vault/vault-directory.ts';
const ENTRY = 'src/vault/vault-files.ts';

/** The stores of Vault files: each writes only through the entry it is given. */
const STORES = [
  'src/subscriptions/subscription-store.ts',
  'src/subscriptions/schedule-store.ts',
  'src/vault/deleted-documents.ts',
  'src/vault/markdown-vault.ts',
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
  it('raises the Vault marker only from the entry', () => {
    const callers = productFiles().filter((file) => /\bensureVaultFormat\b/u.test(readFileSync(file, 'utf8')));
    expect(callers).toContain(ENTRY);
    expect(callers.filter((file) => file !== ENTRY && file !== DEFINES)).toEqual([]);
  });

  it('keeps the stores of Vault files from writing without the entry', () => {
    expect(productFiles()).toEqual(expect.arrayContaining(STORES));
    expect(STORES.flatMap((file) => writerImports(file).map((name) => `${file}: ${name}`))).toEqual([]);
  });
});
