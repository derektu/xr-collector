import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import type { SyncPointSummary } from '../core/types.js';

/**
 * Sync points of a Vault: the content of the Vault at each of its recent exports and imports, as a
 * digest per item. An import compares the local content, the newest sync point the import file and
 * the Vault share, and the file, so it can tell which side changed what since the two last met.
 *
 * The file lives in the Vault folder, beside the marker, so it moves with the Vault and stays valid
 * when the folder is copied to another machine. It belongs to this Vault and never goes into an
 * export file:
 *
 * ```json
 * { "version": 1, "points": [{ "id": "<UUID>", "at": "<ISO time>", "kind": "export" | "import",
 *   "machine": "<machine name>", "items": { "<item key>": "<digest>" } }] }
 * ```
 *
 * Points are newest first, at most `SYNC_HISTORY` of them. An export by hand and a finished import
 * each add one; the export taken automatically before an import applies adds none, so importing
 * that export later still compares against the sync points the Vault shared with other machines.
 */
export const SYNC_FILE = 'xr-collector-sync.json';
export const SYNC_FORMAT_VERSION = 1;
export const SYNC_HISTORY = 5;

/**
 * Item keys: `document:<document ID>` and `channel:<channel ID>`. A document's digest covers its
 * content without collection and change times, or is `deleted` while a deletion record stands for
 * it; a subscription's digest covers what a person sets on it.
 */
export type SyncItems = ReadonlyMap<string, string>;

export interface SyncPoint {
  id: string;
  at: string;
  kind: 'export' | 'import';
  /** The machine whose content the point holds: this machine for an export, the exporting one for an import. */
  machine: string | null;
  items: SyncItems;
}

export interface SyncHistory {
  points: SyncPoint[];
  /** Why the file could not be read; such a Vault shares no sync point with any import file. */
  problem: string | null;
}

/** The sync points of a Vault, newest first; a Vault without the file has none. */
export async function readSyncHistory(root: string): Promise<SyncHistory> {
  let text: string;
  try {
    text = await readFile(path.join(root, SYNC_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { points: [], problem: null };
    return { points: [], problem: `無法讀取同步點紀錄 ${SYNC_FILE}。` };
  }
  try {
    return { points: syncPointsFromJson(JSON.parse(text)), problem: null };
  } catch {
    return { points: [], problem: `同步點紀錄 ${SYNC_FILE} 格式錯誤。` };
  }
}

function syncPointsFromJson(value: unknown): SyncPoint[] {
  const file = value as { version?: unknown; points?: unknown } | null;
  if (!file || file.version !== SYNC_FORMAT_VERSION || !Array.isArray(file.points)) throw new Error('Invalid sync file');
  return file.points.map((entry: unknown) => {
    const point = entry as Partial<Record<keyof SyncPoint, unknown>> | null;
    if (!point || typeof point.id !== 'string' || typeof point.at !== 'string' || (point.kind !== 'export' && point.kind !== 'import')
      || !(point.machine === null || typeof point.machine === 'string') || !point.items || typeof point.items !== 'object') {
      throw new Error('Invalid sync point');
    }
    const items = Object.entries(point.items as Record<string, unknown>);
    if (!items.every(([, digest]) => typeof digest === 'string')) throw new Error('Invalid sync point');
    return { id: point.id, at: point.at, kind: point.kind, machine: point.machine, items: new Map(items as [string, string][]) };
  });
}

/** The bytes of a sync file holding `point` ahead of `earlier`, trimmed to `SYNC_HISTORY` points. */
export function syncFileBytes(point: SyncPoint, earlier: readonly SyncPoint[]): Buffer {
  const points = [point, ...earlier.filter((entry) => entry.id !== point.id)].slice(0, SYNC_HISTORY);
  return Buffer.from(`${JSON.stringify({
    version: SYNC_FORMAT_VERSION,
    points: points.map((entry) => ({ ...entry, items: Object.fromEntries(entry.items) })),
  })}\n`);
}

/** The newest point of a history as the status shows it. */
export function syncSummary(history: SyncHistory): SyncPointSummary | null {
  const point = history.points[0];
  return point ? { at: point.at, kind: point.kind, machine: point.machine } : null;
}

/** The sync point both sides know: the first of the file's own point and its ancestors that the Vault has. */
export function sharedPoint(history: SyncHistory, candidates: readonly (string | null)[]): SyncPoint | null {
  for (const id of candidates) {
    const point = id ? history.points.find((entry) => entry.id === id) : undefined;
    if (point) return point;
  }
  return null;
}

/**
 * The name of this machine as exports and conflicts show it: `XR_COLLECTOR_MACHINE_NAME` when set,
 * otherwise the host name without the `.local` suffix macOS adds.
 */
export function machineName(): string {
  const configured = process.env.XR_COLLECTOR_MACHINE_NAME?.trim();
  return configured || hostname().replace(/\.local$/iu, '') || '這台電腦';
}
