import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../core/types.js';
import { SYNC_FILE, syncFileBytes, type SyncPoint } from './sync-points.js';
import { checkImportFolder, checkPackageFile, clearImportJournal, markerDigest, stagingFolder, writeImportJournal, type ImportJournal } from './transfer-files.js';
import { writeVaultMarker } from './vault-directory.js';
import { formatBytes, moveMargin, nearestExisting, type StatFs } from './vault-move.js';
import { checkPackageContent, IMPORT_STAGING_PREFIX, openPackage, packagePath, unpackedBytes, unpackPackage, type PackageReader } from './vault-package.js';
import { itemStates, syncItems, type FileChanges, type ItemStates } from './vault-sync.js';

/**
 * Points of an in-place import a test can stop at: `staged` once every new file sits in the
 * working folder and before the journal is written, `renaming` after each file is put in place
 * (with its count), and `before-sync` just before the sync file, the last entry, is put in place.
 */
export type ImportFault = 'staged' | 'renaming' | 'before-sync';

/** Refuses work whose files would not fit on the disk of `folder`, with the same margin as a move. */
export async function checkFreeSpace(folder: string, bytes: number, statfsOf: StatFs = statfs): Promise<void> {
  const required = bytes + moveMargin(bytes);
  const space = await statfsOf(await nearestExisting(folder));
  const available = Number(space.bavail) * Number(space.bsize);
  if (available < required) {
    throw new CollectorError('insufficient_space', `磁碟空間不足：需要 ${formatBytes(required)}，只有 ${formatBytes(available)} 可用。`);
  }
}

/**
 * The sync point a finished import records: the export file's own point, holding the file's items.
 * An export without a point of its own (one taken before an import) is named by its manifest digest.
 */
export function importedPoint(reader: PackageReader, items: ItemStates, at: Date): SyncPoint {
  const sync = reader.manifest.sync;
  return { id: sync?.id ?? reader.identity, at: at.toISOString(), kind: 'import', machine: sync?.machine ?? null, items: syncItems(items) };
}

/**
 * The journal of an in-place import, `journal.json` in its working folder
 * `<Vault>/.xr-collector-import-<UUID>/`: `{ "version": 1, "entries": [{ "path": "<Vault path>",
 * "staged": "files/<n>" | null }] }`. Each entry puts a staged file at its path, or removes the
 * path when `staged` is null. The sync file is the last entry.
 *
 * The journal is written once every staged file is complete, and that write is the commit point:
 * a working folder without a journal is dropped and the Vault stays as it was; with one, the
 * entries are carried out again on the next open until every one is done. Putting a file in place
 * is a rename within the Vault folder, so each path holds either its old or its new file, and a
 * repeated entry finds its staged file gone and moves on.
 */
interface InPlaceJournal { version: 1; entries: { path: string; staged: string | null }[] }

const STAGED = /^files\/\d+$/u;

/**
 * Applies `changes` and then `syncBytes` to the Vault at `root` through a working folder inside it;
 * see `InPlaceJournal`. Files taken from the export file stream out of `reader`.
 */
export async function applyInPlace(
  root: string, reader: PackageReader, changes: FileChanges, syncBytes: Buffer,
  progress: (done: number, total: number) => void,
  faults?: (phase: ImportFault, count?: number) => void | Promise<void>,
): Promise<void> {
  const work = path.join(root, `${IMPORT_STAGING_PREFIX}${randomUUID()}`);
  await mkdir(path.join(work, 'files'), { recursive: true, mode: 0o700 });
  const entries: InPlaceJournal['entries'] = [];
  try {
    const all = [...changes, [SYNC_FILE, { bytes: syncBytes }] as const];
    for (const [index, [file, change]] of all.entries()) {
      if (!change) { entries.push({ path: file, staged: null }); continue; }
      const staged = `files/${index}`;
      const target = path.join(work, staged);
      if ('incoming' in change) await reader.extract(change.incoming, target);
      else await writeFile(target, change.bytes, { flag: 'wx', mode: 0o600 });
      entries.push({ path: file, staged });
    }
    await faults?.('staged');
    const journal = path.join(work, 'journal.json');
    await writeFile(`${journal}.tmp`, JSON.stringify({ version: 1, entries } satisfies InPlaceJournal), { mode: 0o600 });
    await rename(`${journal}.tmp`, journal);
  } catch (error) {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  for (const [index, entry] of entries.entries()) {
    if (index === entries.length - 1) await faults?.('before-sync');
    await placeEntry(root, work, entry);
    progress(index + 1, entries.length);
    await faults?.('renaming', index + 1);
  }
  await rm(work, { recursive: true, force: true });
}

async function placeEntry(root: string, work: string, entry: InPlaceJournal['entries'][number]): Promise<void> {
  const target = path.join(root, entry.path);
  if (!entry.staged) { await rm(target, { force: true }); return; }
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await rename(path.join(work, entry.staged), target);
  } catch (error) {
    // A staged file already put in place by an earlier attempt.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Settles in-place imports a stop interrupted, before the Vault opens: a working folder with a
 * journal has its entries carried out, one without is dropped. Returns whether any import was
 * carried out, in which case the search index needs a rebuild.
 */
export async function finishInPlaceImports(root: string): Promise<boolean> {
  let names: string[];
  try { names = await readdir(root); } catch { return false; }
  let finished = false;
  for (const name of names.filter((entry) => entry.startsWith(IMPORT_STAGING_PREFIX))) {
    const work = path.join(root, name);
    let journal: InPlaceJournal | null = null;
    try { journal = JSON.parse(await readFile(path.join(work, 'journal.json'), 'utf8')) as InPlaceJournal; } catch { journal = null; }
    const valid = journal?.version === 1 && Array.isArray(journal.entries) && journal.entries.every((entry) =>
      typeof entry?.path === 'string' && (packagePath(entry.path) || entry.path === SYNC_FILE)
      && (entry.staged === null || (typeof entry.staged === 'string' && STAGED.test(entry.staged))));
    if (journal && valid) {
      for (const entry of journal.entries) await placeEntry(root, work, entry);
      finished = true;
    }
    await rm(work, { recursive: true, force: true });
  }
  return finished;
}

/**
 * Creates a Vault in `folder` (missing or empty) from an export file, for a machine that has no
 * Vault yet. The files unpack into a staging folder beside the target, which becomes the Vault
 * once complete; the profile journal lets the next start take back an import a stop interrupted.
 * The new Vault gets its own ID, starts with automatic collection paused, and holds the export's
 * sync point, so its first exchange with the exporting Vault compares against it.
 */
export async function importNewVault(options: {
  packageFile: unknown; folder: unknown; profilePath: string; createdBy: string; statfs?: StatFs;
}): Promise<string> {
  const target = await checkImportFolder(options.folder);
  const reader = await openPackage(await checkPackageFile(options.packageFile));
  let journal: ImportJournal | null = null;
  let placed = false;
  try {
    await checkPackageContent(reader);
    await checkFreeSpace(path.dirname(target), unpackedBytes(reader), options.statfs);
    journal = { staging: stagingFolder(target), target, placed: false, marker: null, emptyTarget: false };
    await writeImportJournal(options.profilePath, journal);
    await mkdir(journal.staging, { mode: 0o700 });
    await unpackPackage(reader, journal.staging, () => undefined, { pauseSchedule: true });
    const point = importedPoint(reader, await itemStates(reader), new Date());
    await writeFile(path.join(journal.staging, SYNC_FILE), syncFileBytes(point, []), { flag: 'wx', mode: 0o600 });
    reader.close();
    await writeVaultMarker(journal.staging, options.createdBy);
    await checkImportFolder(target);
    journal = { ...journal, placed: true, marker: await markerDigest(journal.staging), emptyTarget: await isFolder(target) };
    await writeImportJournal(options.profilePath, journal);
    if (journal.emptyTarget) await rm(target, { recursive: true });
    await rename(journal.staging, target);
    placed = true;
    return target;
  } catch (error) {
    reader.close();
    if (journal) {
      await rm(journal.staging, { recursive: true, force: true }).catch(() => undefined);
      if (journal.emptyTarget && !placed) await mkdir(target, { recursive: true }).catch(() => undefined);
      await clearImportJournal(options.profilePath).catch(() => undefined);
    }
    throw error;
  }
}

async function isFolder(target: string): Promise<boolean> {
  try { return (await readdir(target)) !== null; } catch { return false; }
}
