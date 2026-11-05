import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonFile } from '../core/json-file.js';
import type { SourceRegistry } from '../core/source-registry.js';
import type { VaultFiles } from '../core/vault-files.js';
import { DELETIONS_FILE } from './deleted-documents.js';
import { documentKeyFromPath } from './document-paths.js';
import { ensureVaultFormat } from './vault-directory.js';

/** Refuses a path that names no Vault file: a document, a subscriptions file, the schedule file or the deletion file. */
function checkVaultFile(sources: SourceRegistry, relative: string): void {
  if (documentKeyFromPath(sources, relative)) return;
  if (sources.subscriptionDefinitions.some((definition) => definition.storage!.subscriptionsFile === relative)) return;
  if (relative === sources.schedule.file || relative === DELETIONS_FILE) return;
  throw new Error(`Not a Vault file: ${relative}`);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The files of the Vault at `root` that holds the types of `sources`; see `VaultFiles`. */
export class VaultFileWriter implements VaultFiles {
  constructor(readonly root: string, readonly sources: SourceRegistry) {}

  async writeJson(relative: string, value: unknown): Promise<void> {
    await this.admitFile(relative);
    await writeJsonFile(this.absolute(relative), value);
  }

  async create(relative: string, text: string): Promise<boolean> {
    await this.admitFile(relative);
    const target = this.absolute(relative);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    try {
      await copyFile(temporary, target, constants.COPYFILE_EXCL);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(relative: string): Promise<void> {
    checkVaultFile(this.sources, relative);
    await rm(this.absolute(relative), { force: true });
  }

  /**
   * Moves the finished file `from`, in the same file system, to `relative` with a rename, so the path
   * holds either its old or its new file. Returns false when `from` is gone: an earlier attempt
   * already put it in place, after the marker was raised.
   */
  async place(relative: string, from: string): Promise<boolean> {
    try {
      await access(from);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    await this.admitFile(relative);
    const target = this.absolute(relative);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await rename(from, target);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  /**
   * Raises the marker for files that are to sit at the Vault paths `relative`. An import calls it
   * before it puts the first of its files in place, so a stop between two renames never leaves a
   * file of a newer format in a Vault whose marker an older program still opens.
   */
  async admit(relative: Iterable<string>): Promise<void> {
    for (const file of relative) checkVaultFile(this.sources, file);
    await ensureVaultFormat(this.root, this.sources);
  }

  private async admitFile(relative: string): Promise<void> {
    checkVaultFile(this.sources, relative);
    await ensureVaultFormat(this.root, this.sources);
  }

  private absolute(relative: string): string {
    return path.join(this.root, ...relative.split('/'));
  }
}
