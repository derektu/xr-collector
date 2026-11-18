import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pidFilePath, stopLeftoverMeilisearchProcess } from './meilisearch-process.js';
import type { SearchIndexProfile } from './meilisearch-runtime.js';

export interface PreparedSearchProjection {
  databasePath: string;
  forceRebuild: boolean;
  recordRebuild(): Promise<void>;
}

export function searchDatabasePath(searchData: string, vaultRoot: string): string {
  return `${path.resolve(searchData)}-${createHash('sha256').update(vaultRoot).digest('hex').slice(0, 16)}`;
}

export function searchProfilePath(databasePath: string): string {
  return `${path.resolve(databasePath)}-fingerprint.json`;
}

export async function prepareOwnedSearchProjection(options: {
  searchData: string;
  vaultRoot: string;
  binaryPath: string;
  profile: SearchIndexProfile;
}): Promise<PreparedSearchProjection> {
  const databasePath = searchDatabasePath(options.searchData, options.vaultRoot);
  await stopLeftoverMeilisearchProcess({ binaryPath: options.binaryPath, databasePath });
  const profilePath = searchProfilePath(databasePath);
  const matches = await profileMatches(profilePath, options.profile);
  if (!matches) {
    const targets = [databasePath, `${databasePath}-state.json`, pidFilePath(databasePath), profilePath];
    for (const target of targets) await refuseSymlink(target);
    for (const target of targets) await rm(target, { recursive: target === databasePath, force: true });
  }
  return {
    databasePath,
    forceRebuild: !matches,
    async recordRebuild() {
      await mkdir(path.dirname(profilePath), { recursive: true });
      const temporary = `${profilePath}.${process.pid}-${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, profile: options.profile }, null, 2)}\n`, { flag: 'wx' });
        await rename(temporary, profilePath);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

async function profileMatches(profilePath: string, profile: SearchIndexProfile): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(profilePath, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && (value as { schemaVersion?: unknown }).schemaVersion === 1
      && JSON.stringify((value as { profile?: unknown }).profile) === JSON.stringify(profile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function refuseSymlink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error(`Refusing to clear symlinked search projection path: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
