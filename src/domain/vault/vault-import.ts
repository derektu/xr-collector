import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkImportFolder, checkPackageFile } from './transfer-files.js';
import { writeVaultMarker } from './vault-directory.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import { VaultFileWriter } from './vault-files.js';
import { checkPackageContent, openPackage, unpackPackage, type PackageReader } from './vault-package.js';
import type { FileChanges } from './vault-merge.js';

const IMPORT_STAGING_PREFIX = '.xr-collector-import-';

interface StagedImport {
  place(progress: (done: number, total: number) => void): Promise<void>;
}

export async function stageImport(root: string, sources: SourceRegistry, reader: PackageReader, changes: FileChanges): Promise<StagedImport> {
  const staging = path.join(root, `${IMPORT_STAGING_PREFIX}${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  const entries: { path: string; staged: string | null }[] = [];
  try {
    for (const [index, [file, change]] of [...changes].entries()) {
      if (!change) { entries.push({ path: file, staged: null }); continue; }
      const staged = path.join(staging, String(index));
      if ('incoming' in change) await reader.extract(change.incoming, staged);
      else await writeFile(staged, change.bytes, { flag: 'wx', mode: 0o600 });
      entries.push({ path: file, staged });
    }
  } catch (error) {
    await removeStaging(staging);
    throw error;
  }
  return {
    async place(progress) {
      const files = new VaultFileWriter(root, sources);
      try {
        for (const [index, entry] of entries.entries()) {
          if (entry.staged) await files.place(entry.path, entry.staged);
          else await files.remove(entry.path);
          progress(index + 1, entries.length);
        }
      } finally {
        await removeStaging(staging);
      }
    },
  };
}

export async function removeImportStaging(root: string): Promise<void> {
  for (const name of await readdir(root)) {
    if (name.startsWith(IMPORT_STAGING_PREFIX)) await rm(path.join(root, name), { recursive: true, force: true });
  }
}

export async function importNewVault(options: {
  packageFile: unknown; folder: unknown; createdBy: string; sources: SourceRegistry;
}): Promise<string> {
  const target = await checkImportFolder(options.folder);
  const reader = await openPackage(await checkPackageFile(options.packageFile), options.sources);
  const staging = `${target}.importing-${randomUUID()}`;
  try {
    await checkPackageContent(reader, options.sources);
    await mkdir(staging, { mode: 0o700 });
    await unpackPackage(reader, staging, () => undefined);
    await writeVaultMarker(staging, options.createdBy);
    await rename(staging, target);
    return target;
  } catch (error) {
    await removeStaging(staging);
    throw error;
  } finally {
    reader.close();
  }
}

async function removeStaging(staging: string): Promise<void> {
  await rm(staging, { recursive: true, force: true }).catch((error: unknown) => console.error('Removing an import staging folder failed', error));
}
