import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonFile } from '../core/json-file.js';
import type { SourceRegistry } from '../core/source-registry.js';
import type { VaultFiles } from '../core/vault-files.js';
import { DELETIONS_FILE } from './deleted-documents.js';
import { documentKeyFromPath } from './document-paths.js';
import { ensureVaultFormat } from './vault-directory.js';

/**
 * The source types whose Vault format a file needs: a document and a subscriptions file need their
 * own type's, the deletion file needs the types of its records, and the schedule file needs none.
 * `content` reads the file's parsed JSON, and only the deletion file reads it. A path that names no
 * Vault file is refused.
 */
async function formatTypes(sources: SourceRegistry, relative: string, content: () => Promise<unknown>): Promise<string[]> {
  const document = documentKeyFromPath(sources, relative);
  if (document) return [document.sourceType];
  const subscriptions = sources.subscriptionDefinitions.find((definition) => definition.storage!.subscriptionsFile === relative);
  if (subscriptions) return [subscriptions.id];
  if (relative === sources.schedule.file) return [];
  if (relative === DELETIONS_FILE) return recordTypes(await content());
  throw new Error(`Not a Vault file: ${relative}`);
}

/** The `sourceType` of each record of a deletion file, read leniently: a file that does not parse names none. */
function recordTypes(value: unknown): string[] {
  const records = (value as { deleted?: unknown } | null | undefined)?.deleted;
  if (!Array.isArray(records)) return [];
  return records.flatMap((record) => {
    const type = (record as { sourceType?: unknown } | null)?.sourceType;
    return typeof type === 'string' ? [type] : [];
  });
}

/** Parsed JSON, or undefined for text that is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readJson(file: string): Promise<unknown> {
  return parsed(await readFile(file, 'utf8'));
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The files of the Vault at `root` that holds the types of `sources`; see `VaultFiles`. */
export class VaultFileWriter implements VaultFiles {
  constructor(readonly root: string, readonly sources: SourceRegistry) {}

  async writeJson(relative: string, value: unknown): Promise<void> {
    await this.admitFile(relative, async () => value);
    await writeJsonFile(this.absolute(relative), value);
  }

  async create(relative: string, text: string): Promise<boolean> {
    await this.admitFile(relative, async () => parsed(text));
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
    await formatTypes(this.sources, relative, async () => undefined);
    await rm(this.absolute(relative), { force: true });
  }

  /**
   * Moves the finished file `from`, in the same file system, to `relative` with a rename, so the path
   * holds either its old or its new file. Returns false when `from` is gone: an earlier attempt
   * already put it in place, after the marker its content needs.
   */
  async place(relative: string, from: string): Promise<boolean> {
    try {
      await this.admitFile(relative, () => readJson(from));
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
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
   * Raises the marker, in one step, for files that are to sit at Vault paths: each `relative` path
   * with the file `at`, an absolute path inside or outside the Vault folder. An import calls it
   * before it puts the first of its files in place, so a stop between two renames never leaves a
   * file of a newer format in a Vault whose marker an older program still opens. A file no longer
   * `at` its place was put in place by an earlier attempt, after this same step.
   */
  async admit(files: Iterable<{ relative: string; at: string }>): Promise<void> {
    const types = new Set<string>();
    for (const { relative, at } of files) {
      try {
        for (const type of await formatTypes(this.sources, relative, () => readJson(at))) types.add(type);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    await ensureVaultFormat(this.root, types, this.sources);
  }

  private async admitFile(relative: string, content: () => Promise<unknown>): Promise<void> {
    await ensureVaultFormat(this.root, await formatTypes(this.sources, relative, content), this.sources);
  }

  private absolute(relative: string): string {
    return path.join(this.root, ...relative.split('/'));
  }
}
