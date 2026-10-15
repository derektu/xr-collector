import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../channels/json-file.js';
import type { DocumentSourceType } from '../core/types.js';

/**
 * Vault file of deleted documents, relative to the Vault root. Each record keeps a source item from
 * coming back through automatic or channel collection; only an explicit single-item collection
 * started after the deletion lifts it.
 *
 * `{ "version": 1, "deleted": [record, ...] }`. A record is keyed by `sourceType` and `sourceId`,
 * which together form the document ID (`youtube:<video ID>`), and keeps the title and publisher so
 * a merge or a deleted-document page can still name the item.
 */
export const DELETIONS_FILE = 'settings/deleted-documents.json';
const DELETIONS_VERSION = 1;
const SOURCE_TYPES: ReadonlySet<string> = new Set<DocumentSourceType>(['youtube']);

export interface DeletionRecord {
  sourceType: DocumentSourceType;
  sourceId: string;
  sourceUrl: string;
  title: string;
  publisherId: string | null;
  publisherName: string;
  /** When the deletion intent was recorded, from the same clock that stamps `collected_at`. */
  deletedAt: string;
}

export interface DeletionsFile {
  version: typeof DELETIONS_VERSION;
  deleted: DeletionRecord[];
}

export class InvalidDeletionsFile extends Error {}

/** The document ID a record stands for. */
export function deletionId(record: Pick<DeletionRecord, 'sourceType' | 'sourceId'>): string {
  return `${record.sourceType}:${record.sourceId}`;
}

/**
 * Whether a document collected at `collectedAt` belongs to the deletion made at `deletedAt`. Equal
 * times count as before the deletion, so a deletion always wins a tie; an explicit re-collection
 * stamps its document after the deletion time.
 */
export function collectedBeforeDeletion(collectedAt: string, deletedAt: string): boolean {
  return Date.parse(collectedAt) <= Date.parse(deletedAt);
}

/** The records of a deletions file; a missing file has none. Unknown versions and malformed records are refused. */
export function deletionsFromJson(value: unknown): DeletionRecord[] {
  if (value === undefined) return [];
  const file = value as Partial<DeletionsFile> | null;
  if (!file || typeof file !== 'object' || file.version !== DELETIONS_VERSION || !Array.isArray(file.deleted)
    || !file.deleted.every(isRecord)) {
    throw new InvalidDeletionsFile('Invalid deleted documents file');
  }
  const ids = new Set<string>();
  for (const record of file.deleted) {
    const id = deletionId(record);
    if (ids.has(id)) throw new InvalidDeletionsFile(`Duplicate deleted document ${id}`);
    ids.add(id);
  }
  return file.deleted;
}

export function deletionsToJson(records: DeletionRecord[]): DeletionsFile {
  return { version: DELETIONS_VERSION, deleted: records };
}

/**
 * The deletions file of one Vault. Reads go to the file every time, so records written by a merge
 * or restore are seen at once; writes from this process run one after another.
 */
export class DeletionLedger {
  private readonly filePath: string;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(root: string, private readonly now: () => Date) {
    this.filePath = path.join(root, DELETIONS_FILE);
  }

  async list(): Promise<DeletionRecord[]> {
    return deletionsFromJson(await readJsonFile(this.filePath));
  }

  async get(id: string): Promise<DeletionRecord | null> {
    return (await this.list()).find((record) => deletionId(record) === id) ?? null;
  }

  /** Records a deletion stamped with the Vault clock, replacing an earlier record of the same item. */
  record(entry: Omit<DeletionRecord, 'deletedAt'>): Promise<DeletionRecord> {
    const record: DeletionRecord = { ...entry, deletedAt: this.now().toISOString() };
    return this.write(async (records) => [...records.filter((candidate) => deletionId(candidate) !== deletionId(record)), record])
      .then(() => record);
  }

  /** Lifts the deletion of one item; nothing happens when it has none. */
  clear(id: string): Promise<void> {
    return this.write(async (records) => records.filter((record) => deletionId(record) !== id));
  }

  private write(change: (records: DeletionRecord[]) => Promise<DeletionRecord[]>): Promise<void> {
    const run = this.writeTail.then(async () => {
      const records = await this.list();
      const next = await change(records);
      if (next.length === records.length && next.every((record, index) => record === records[index])) return;
      await writeJsonFile(this.filePath, deletionsToJson(next));
    });
    this.writeTail = run.catch(() => undefined);
    return run;
  }
}

function isRecord(value: unknown): value is DeletionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DeletionRecord>;
  return typeof record.sourceType === 'string' && SOURCE_TYPES.has(record.sourceType)
    && typeof record.sourceId === 'string' && /^[A-Za-z0-9_-]{11}$/u.test(record.sourceId)
    && typeof record.sourceUrl === 'string'
    && typeof record.title === 'string'
    && (record.publisherId === null || typeof record.publisherId === 'string')
    && typeof record.publisherName === 'string'
    && typeof record.deletedAt === 'string' && !Number.isNaN(Date.parse(record.deletedAt));
}
