// Guards the developer, not the user: a Vault file store that writes past the Vault file entry can write a file no export carries.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { productFiles } from '../support/source-imports.js';

const VAULT_FILE_STORES = [
  'src/domain/subscriptions/subscription-store.ts',
  'src/domain/subscriptions/schedule-store.ts',
  'src/domain/vault/deleted-documents.ts',
  'src/domain/vault/markdown-vault.ts',
];

const WRITE_FUNCTIONS = /\b(?:writeFile|writeJsonFile|replaceFile|rename|copyFile|rm|unlink|appendFile|mkdir|open)\b/u;

const WRITER_MODULES = /^(?:node:)?fs(?:\/promises)?$|json-file\.js$/u;

function writerImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(/import\s+(type\s+)?([^'";]*?)\s+from\s*['"]([^'"]+)['"]/gu)) {
    const [, typeOnly, clause = '', specifier = ''] = match;
    if (typeOnly || !WRITER_MODULES.test(specifier)) continue;
    const outside = clause.replace(/\{[^}]*\}/u, '').replace(/,/gu, '').trim();
    if (outside) found.push(`${outside} from ${specifier}`);
    const named = /\{([^}]*)\}/u.exec(clause)?.[1] ?? '';
    for (const name of named.split(',').map((part) => part.trim())) if (WRITE_FUNCTIONS.test(name)) found.push(name);
  }
  for (const match of text.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    if (WRITER_MODULES.test(match[1]!)) found.push(`import(${match[1]})`);
  }
  return found;
}

describe('the one way into a Vault\'s files', () => {
  it('keeps the stores of Vault files writing only through the entry', () => {
    expect(productFiles()).toEqual(expect.arrayContaining(VAULT_FILE_STORES));
    expect(VAULT_FILE_STORES.flatMap((file) => writerImports(file).map((name) => `${file}: ${name}`))).toEqual([]);
  });
});
