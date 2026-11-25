import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFile, writeJsonFile } from '../../shared/lib/json-file.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type { VaultFiles } from '../../shared/vault/vault-files.js';
import { DELETIONS_FILE } from './deleted-documents.js';
import { documentKeyFromPath } from './document-paths.js';
import { errorCode } from './errno.js';

function checkVaultFile(sources: SourceRegistry, relative: string): void {
  if (documentKeyFromPath(sources, relative)) return;
  if (sources.subscriptionDefinitions.some((definition) => definition.storage!.subscriptionsFile === relative)) return;
  if (relative === sources.schedule.file || relative === DELETIONS_FILE) return;
  throw new Error(`Not a Vault file: ${relative}`);
}

export class VaultFileWriter implements VaultFiles {
  constructor(readonly root: string, readonly sources: SourceRegistry) {}

  async writeJson(relative: string, value: unknown): Promise<void> {
    checkVaultFile(this.sources, relative);
    await writeJsonFile(this.absolute(relative), value);
  }

  async writeText(relative: string, text: string): Promise<void> {
    checkVaultFile(this.sources, relative);
    const target = this.absolute(relative);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    try {
      await replaceFile(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async create(relative: string, text: string): Promise<boolean> {
    checkVaultFile(this.sources, relative);
    const target = this.absolute(relative);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    try {
      await copyFile(temporary, target, constants.COPYFILE_EXCL);
      return true;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(relative: string): Promise<void> {
    checkVaultFile(this.sources, relative);
    await rm(this.absolute(relative), { force: true });
  }

  // External: A rename within one file system replaces the target atomically:
  // https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html
  async place(relative: string, from: string): Promise<boolean> {
    try {
      await access(from);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
    checkVaultFile(this.sources, relative);
    const target = this.absolute(relative);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await rename(from, target);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private absolute(relative: string): string {
    return path.join(this.root, ...relative.split('/'));
  }
}
