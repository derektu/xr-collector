import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pidFilePath } from './meilisearch-process.js';

export const SEARCH_INDEX_VERSION = 1;

function vaultPrefix(searchData: string, vaultRoot: string): string {
  return `${path.resolve(searchData)}-${createHash('sha256').update(vaultRoot).digest('hex').slice(0, 16)}`;
}

/** The search database of `vaultRoot` for the current `SEARCH_INDEX_VERSION`; another version is another directory. */
export function searchDatabasePath(searchData: string, vaultRoot: string): string {
  return `${vaultPrefix(searchData, vaultRoot)}-v${SEARCH_INDEX_VERSION}`;
}

/**
 * Returns the Vault's search database path after deleting the Vault's databases of other index
 * versions, with their state and process files. A database the current version has not built yet
 * does not exist, so the startup comparison indexes every document into it.
 */
export async function prepareSearchDatabase(options: { searchData: string; vaultRoot: string }): Promise<string> {
  const databasePath = searchDatabasePath(options.searchData, options.vaultRoot);
  const prefix = vaultPrefix(options.searchData, options.vaultRoot);
  const current = new Set([databasePath, `${databasePath}-state.json`, pidFilePath(databasePath)].map((entry) => path.basename(entry)));
  const prefixName = path.basename(prefix);
  const directory = path.dirname(prefix);
  const others = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => !current.has(name) && name.startsWith(`${prefixName}-`))
    .map((name) => path.join(directory, name));
  try {
    for (const target of others) await rm(target, { recursive: true, force: true });
  } catch (error) {
    console.warn('Unable to delete the search data of other index versions', error);
  }
  return databasePath;
}
