import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, statfs, utimes } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../core/types.js';
import type { JobStore } from '../jobs/job-store.js';
import { inspectVaultDirectory, readVaultId, VAULT_MARKER } from './vault-directory.js';
import { isWithin, markerDigest, writePackageFile, type ProtectedFolders } from './transfer-files.js';

/**
 * Files of a Vault move: checking the new location, copying and verifying the Vault, the profile
 * record of a move in progress, and taking an interrupted move forward or back when the app starts.
 *
 * A move copies the whole Vault folder into a staging folder beside the new location, verifies the
 * copy file by file, and renames the staging folder into place, so a move across volumes works like
 * a move on one volume and the original stays untouched until the device selection names the new
 * location. The original is then renamed to a removal name and deleted, so the original location is
 * either a whole Vault or gone; a partly deleted folder only ever exists under the removal name.
 */

const invalid = (message: string): never => { throw new CollectorError('invalid_request', message); };

/** Space a move keeps free on top of the Vault's size: 5% of it, and at least 16 MiB. */
export const MOVE_MARGIN_RATIO = 0.05;
export const MOVE_MARGIN_MIN_BYTES = 16 * 1024 * 1024;

export function moveMargin(bytes: number): number {
  return Math.max(Math.ceil(bytes * MOVE_MARGIN_RATIO), MOVE_MARGIN_MIN_BYTES);
}

/** Free space of the volume holding `folder`, as `fs.statfs` reports it. */
export type StatFs = (folder: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

export interface TreeEntry {
  /** Path inside the Vault, with `/` separators. */
  relative: string;
  kind: 'directory' | 'file';
  size: number;
  mode: number;
  mtime: Date;
}

/**
 * Lists every folder and file of a Vault. A symbolic link or special file makes the Vault unmovable:
 * copying a link either drags along data outside the Vault or leaves its target behind.
 */
export async function scanVault(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const walk = async (relative: string): Promise<void> => {
    const names = (await readdir(path.join(root, relative))).sort();
    for (const name of names) {
      const child = relative ? `${relative}/${name}` : name;
      const info = await lstat(path.join(root, child));
      if (info.isDirectory()) {
        entries.push({ relative: child, kind: 'directory', size: 0, mode: info.mode & 0o7777, mtime: info.mtime });
        await walk(child);
      } else if (info.isFile()) {
        entries.push({ relative: child, kind: 'file', size: info.size, mode: info.mode & 0o7777, mtime: info.mtime });
      } else {
        invalid(`知識庫裡有符號連結或特殊檔案（${child}），無法搬移。請先移除或改成一般檔案。`);
      }
    }
  };
  await walk('');
  return entries;
}

export function treeBytes(entries: readonly TreeEntry[]): number {
  return entries.reduce((total, entry) => total + entry.size, 0);
}

async function lstatOrNull(target: string) {
  try { return await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function nearestExisting(target: string): Promise<string> {
  let current = target;
  for (;;) {
    if (await lstatOrNull(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export interface MoveTarget {
  target: string;
  requiredBytes: number;
  availableBytes: number;
}

/**
 * Checks the new location of a move: an absolute path that does not exist yet (in an existing,
 * writable folder) or is an empty folder; not a symbolic link; not the active Vault, inside it or
 * containing it; not inside the profile or another Vault; on a volume with room for the Vault plus
 * the margin. Locations are compared after resolving symbolic links, which also folds letter case on
 * a case-insensitive volume.
 */
export async function checkMoveTarget(
  value: unknown, folders: ProtectedFolders, vaultBytes: number, free: StatFs = statfs,
): Promise<MoveTarget> {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) invalid('請提供新位置的完整路徑。');
  const target = path.resolve(value as string);
  if ((await lstatOrNull(target))?.isSymbolicLink()) invalid('新位置不能是符號連結，請選擇實際的資料夾。');
  if (await isWithin(target, folders.vaultRoot)) {
    invalid(await isWithin(folders.vaultRoot, target) ? '新位置就是目前的知識庫，請選擇其他位置。' : '新位置不能在目前的知識庫裡。');
  }
  if (await isWithin(folders.vaultRoot, target)) invalid('新位置不能包含目前的知識庫。');
  if (await isWithin(target, folders.profilePath)) invalid('新位置不能放在程式資料目錄裡。');
  for (let ancestor = path.dirname(target); ; ancestor = path.dirname(ancestor)) {
    if (await lstatOrNull(path.join(ancestor, VAULT_MARKER))) invalid('新位置不能放在另一個知識庫裡。');
    if (path.dirname(ancestor) === ancestor) break;
  }
  const inspection = await inspectVaultDirectory(target);
  if (inspection.kind === 'existing') invalid('這個位置已經有另一個知識庫，搬移不會覆蓋它。請選擇不存在或空的資料夾。');
  if (inspection.kind === 'invalid') {
    invalid(inspection.reason.includes('其他檔案') ? '這個資料夾已經有內容，請選擇不存在或空的資料夾。' : inspection.reason);
  }
  try {
    await access(inspection.kind === 'empty' && inspection.exists ? target : path.dirname(target), constants.W_OK);
  } catch {
    invalid('沒有權限寫入新位置。');
  }
  const requiredBytes = vaultBytes + moveMargin(vaultBytes);
  const space = await free(await nearestExisting(target));
  const availableBytes = Number(space.bavail) * Number(space.bsize);
  if (availableBytes < requiredBytes) {
    throw new CollectorError('insufficient_space',
      `新位置的磁碟空間不足：需要 ${formatBytes(requiredBytes)}，只有 ${formatBytes(availableBytes)} 可用。`);
  }
  return { target, requiredBytes, availableBytes };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Copies the scanned tree into `destination`, an existing empty folder, keeping modes and modification times. */
export async function copyTree(
  source: string, destination: string, entries: readonly TreeEntry[],
  progress: (done: number) => Promise<void> | void,
): Promise<void> {
  let done = 0;
  for (const entry of entries) {
    const to = path.join(destination, entry.relative);
    if (entry.kind === 'directory') await mkdir(to, { mode: 0o700 });
    else await copyFile(path.join(source, entry.relative), to, constants.COPYFILE_EXCL);
    done += 1;
    await progress(done);
  }
  // Folders get their own mode and time last: writing into a folder changes its time, and a
  // read-only folder would refuse its contents.
  for (const entry of [...entries].reverse()) {
    const to = path.join(destination, entry.relative);
    await chmod(to, entry.mode);
    await utimes(to, entry.mtime, entry.mtime);
  }
  const root = await lstat(source);
  await chmod(destination, root.mode & 0o7777);
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Confirms that `copy` holds exactly the scanned tree of `source`, with byte-identical files. */
export async function verifyTree(source: string, copy: string, entries: readonly TreeEntry[]): Promise<void> {
  const fail = (detail: string): never => {
    throw new CollectorError('invalid_request', `複製後的檢查不一致（${detail}），沒有搬移。原知識庫保持不變。`);
  };
  const copied = await scanVault(copy);
  if (copied.length !== entries.length) fail('檔案數量不同');
  for (let index = 0; index < entries.length; index += 1) {
    const expected = entries[index]!;
    const actual = copied[index]!;
    if (actual.relative !== expected.relative || actual.kind !== expected.kind || actual.size !== expected.size) fail(expected.relative);
    if (expected.kind === 'file' && await digest(path.join(source, expected.relative)) !== await digest(path.join(copy, expected.relative))) {
      fail(expected.relative);
    }
  }
}

const MOVING = /\.moving-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REMOVING = /\.moved-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The staging folder a move copies into, beside the new location. */
export function movingFolder(target: string): string {
  return `${target}.moving-${randomUUID()}`;
}

/** The removal name the original location takes after a move, beside it. */
export function removalFolder(source: string): string {
  return `${source}.moved-${randomUUID()}`;
}

/**
 * Profile record of a move in progress:
 * `{ "version": 1, "vaultId", "source", "target", "staging", "phase", "marker", "emptyTarget", "removal" }`.
 * `phase` is `copying` until the staging folder is renamed to the target, `placed` until the device
 * selection names the target, `switched` once it does, and `cleaning` once the original has its
 * removal name `removal`. `marker` is the digest of the copied marker, which tells the moved Vault
 * apart from anything else at the target path; `emptyTarget` says the target was an empty folder.
 * The record stays until the original location is gone.
 */
export const MOVE_JOURNAL = 'vault-move-journal.json';

export type MovePhase = 'copying' | 'placed' | 'switched' | 'cleaning';

export interface MoveJournal {
  version: 1;
  vaultId: string;
  source: string;
  target: string;
  staging: string;
  phase: MovePhase;
  marker: string | null;
  emptyTarget: boolean;
  removal: string | null;
}

export async function writeMoveJournal(profilePath: string, journal: MoveJournal): Promise<void> {
  await mkdir(profilePath, { recursive: true });
  await writePackageFile(path.join(profilePath, MOVE_JOURNAL), Buffer.from(JSON.stringify(journal)));
}

export async function clearMoveJournal(profilePath: string): Promise<void> {
  await rm(path.join(profilePath, MOVE_JOURNAL), { force: true });
}

async function readMoveJournal(profilePath: string): Promise<Partial<MoveJournal> | null | 'unreadable'> {
  try {
    return JSON.parse(await readFile(path.join(profilePath, MOVE_JOURNAL), 'utf8')) as Partial<MoveJournal>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'unreadable';
  }
}

/**
 * Removes the original location of a committed move: renames it to its removal name, recorded in the
 * journal first, then deletes that folder. Returns the path left behind when a step fails: the
 * original itself when the rename fails, otherwise the removal folder.
 */
export async function removeOriginal(
  profilePath: string, journal: MoveJournal, beforeDelete: () => Promise<void> | void = () => undefined,
): Promise<{ journal: MoveJournal; leftover: string | null }> {
  let current = journal;
  if (!current.removal) {
    current = { ...current, phase: 'cleaning', removal: removalFolder(current.source) };
    await writeMoveJournal(profilePath, current);
    try {
      await rename(current.source, current.removal!);
    } catch (error) {
      console.error('Unable to rename the original Vault location for removal', error);
      current = { ...current, phase: 'switched', removal: null };
      await writeMoveJournal(profilePath, current);
      return { journal: current, leftover: current.source };
    }
  }
  try {
    await beforeDelete();
    await rm(current.removal!, { recursive: true, force: true });
  } catch (error) {
    console.error('Unable to delete the original Vault location', error);
    return { journal: current, leftover: current.removal };
  }
  await clearMoveJournal(profilePath);
  return { journal: current, leftover: null };
}

export interface MoveRecovery {
  /** The move was committed and its jobs belong to the new location. */
  committed: boolean;
  vaultId: string;
  source: string;
  target: string;
  /** Jobs recorded at the new location while finishing the move. */
  reboundJobs: number;
  /** What could not be removed; null when nothing is left. */
  leftover: string | null;
}

/**
 * Takes a move that a stop interrupted forward or back, before any Vault opens. The move counts as
 * committed when its journal reached `switched` or the device selection names its target; then its
 * jobs are recorded at the target and the original location is removed, unless the original is the
 * selection or the Vault being opened (`kept`). Otherwise the staging folder is removed, a placed
 * target carrying the moved marker is taken back (leaving an empty folder where the move found one),
 * and the target's search database is removed. A journal naming folders the move did not create is
 * dropped without touching them.
 */
export async function recoverMove(
  profilePath: string,
  options: { selected: string | null; kept: readonly (string | null)[]; jobStore: JobStore; removeSearch: (root: string) => Promise<void> },
): Promise<MoveRecovery | null> {
  const read = await readMoveJournal(profilePath);
  if (read === null) return null;
  const journal = read === 'unreadable' ? null : read;
  const valid = journal && journal.version === 1 && typeof journal.vaultId === 'string'
    && typeof journal.source === 'string' && path.isAbsolute(journal.source)
    && typeof journal.target === 'string' && path.isAbsolute(journal.target)
    && typeof journal.staging === 'string' && journal.staging.startsWith(`${journal.target}.moving-`) && MOVING.test(journal.staging)
    && (journal.removal === null || journal.removal === undefined
      || (typeof journal.removal === 'string' && journal.removal.startsWith(`${journal.source}.moved-`) && REMOVING.test(journal.removal)));
  if (!valid) {
    await clearMoveJournal(profilePath);
    return null;
  }
  const record = { ...journal, removal: journal.removal ?? null } as MoveJournal;
  const committed = record.phase === 'switched' || record.phase === 'cleaning' || options.selected === record.target;
  await rm(record.staging, { recursive: true, force: true });
  if (!committed) {
    if (record.phase === 'placed' && !options.kept.includes(record.target) && record.marker
      && await markerDigest(record.target) === record.marker) {
      const back = movingFolder(record.target);
      await rename(record.target, back);
      await rm(back, { recursive: true, force: true });
      if (record.emptyTarget) await mkdir(record.target);
    } else if (record.phase === 'placed' && record.emptyTarget && !await lstatOrNull(record.target)) {
      // Stopped after clearing the empty target folder and before renaming the copy into it.
      await mkdir(record.target);
    }
    await options.removeSearch(record.target);
    await clearMoveJournal(profilePath);
    return { committed, vaultId: record.vaultId, source: record.source, target: record.target, reboundJobs: 0, leftover: null };
  }
  const reboundJobs = options.jobStore.rebind(record.source, record.target, record.vaultId);
  await options.jobStore.flush();
  await writeMoveJournal(profilePath, { ...record, phase: record.removal ? 'cleaning' : 'switched' });
  if (!record.removal && (options.kept.includes(record.source) || await readVaultId(record.source) !== record.vaultId)) {
    // The original is in use again, or something else now sits there: it is not the move's to remove.
    await clearMoveJournal(profilePath);
    return { committed, vaultId: record.vaultId, source: record.source, target: record.target, reboundJobs, leftover: null };
  }
  const { leftover } = await removeOriginal(profilePath, record);
  return { committed, vaultId: record.vaultId, source: record.source, target: record.target, reboundJobs, leftover };
}

/**
 * Profile record of the locations each Vault was moved from: `{ "version": 1, "vaults": { "<id>": ["<path>", …] } }`.
 * Activity recorded before events carried Vault IDs is found through these paths. Each Vault keeps
 * its 20 most recent previous locations, and the record keeps the 50 Vaults moved most recently.
 */
export const LOCATIONS_FILE = 'vault-locations.json';
const PATHS_PER_VAULT = 20;
const VAULTS_KEPT = 50;

async function readLocations(profilePath: string): Promise<Record<string, string[]>> {
  try {
    const value = JSON.parse(await readFile(path.join(profilePath, LOCATIONS_FILE), 'utf8')) as { vaults?: unknown };
    if (!value.vaults || typeof value.vaults !== 'object') return {};
    return Object.fromEntries(Object.entries(value.vaults)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === 'string')));
  } catch {
    // A missing or unreadable record only hides activity recorded before Vault IDs.
    return {};
  }
}

export async function previousLocations(profilePath: string, vaultId: string | null): Promise<string[]> {
  if (!vaultId) return [];
  return (await readLocations(profilePath))[vaultId] ?? [];
}

/** Records that the Vault with `vaultId` left `from` for `to`. */
export async function recordPreviousLocation(profilePath: string, vaultId: string, from: string, to: string): Promise<void> {
  const vaults = await readLocations(profilePath);
  const paths = [from, ...(vaults[vaultId] ?? []).filter((item) => item !== from && item !== to)].slice(0, PATHS_PER_VAULT);
  delete vaults[vaultId];
  const kept = Object.entries(vaults).slice(-(VAULTS_KEPT - 1));
  await mkdir(profilePath, { recursive: true });
  await writePackageFile(path.join(profilePath, LOCATIONS_FILE),
    Buffer.from(`${JSON.stringify({ version: 1, vaults: Object.fromEntries([...kept, [vaultId, paths]]) }, null, 2)}\n`));
}
