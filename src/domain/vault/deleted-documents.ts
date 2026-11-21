import path from 'node:path';
import type { DeletionRecords } from '../../shared/documents/document-vault.js';
import { readJsonFile } from '../../shared/lib/json-file.js';
import { documentId } from '../../shared/documents/document-id.js';
import type { DeletionRecord } from '../../shared/documents/document-types.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import type { VaultFiles } from '../../shared/vault/vault-files.js';
import { isSourceId, isSourceType } from './document-paths.js';

export const DELETIONS_FILE = 'settings/deleted-documents.json';
const DELETIONS_VERSION = 1;

export interface DeletionsFile {
  version: typeof DELETIONS_VERSION;
  deleted: DeletionRecord[];
}

export class InvalidDeletionsFile extends Error {}

export function deletionsFromJson(value: unknown, sources: SourceDeclarations): DeletionRecord[] {
  if (value === undefined) return [];
  const file = value as Partial<DeletionsFile> | null;
  if (!file || typeof file !== 'object' || file.version !== DELETIONS_VERSION || !Array.isArray(file.deleted)
    || !file.deleted.every((record) => isRecord(record, sources))) {
    throw new InvalidDeletionsFile('Invalid deleted documents file');
  }
  const ids = new Set<string>();
  for (const record of file.deleted) {
    const id = documentId(record);
    if (ids.has(id)) throw new InvalidDeletionsFile(`Duplicate deleted document ${id}`);
    ids.add(id);
  }
  return file.deleted;
}

export function deletionsToJson(records: DeletionRecord[]): DeletionsFile {
  return { version: DELETIONS_VERSION, deleted: records };
}

export class DeletionLedger implements DeletionRecords {
  private readonly filePath: string;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly files: VaultFiles, private readonly now: () => Date) {
    this.filePath = path.join(files.root, ...DELETIONS_FILE.split('/'));
  }

  async list(): Promise<DeletionRecord[]> {
    return deletionsFromJson(await readJsonFile(this.filePath), this.files.sources);
  }

  async get(id: string): Promise<DeletionRecord | null> {
    return (await this.list()).find((record) => documentId(record) === id) ?? null;
  }

  record(entry: Omit<DeletionRecord, 'deletedAt'>): Promise<DeletionRecord> {
    const record: DeletionRecord = { ...entry, deletedAt: this.now().toISOString() };
    return this.write(async (records) => [...records.filter((candidate) => documentId(candidate) !== documentId(record)), record])
      .then(() => record);
  }

  clear(id: string): Promise<void> {
    return this.write(async (records) => records.filter((record) => documentId(record) !== id));
  }

  private write(change: (records: DeletionRecord[]) => Promise<DeletionRecord[]>): Promise<void> {
    const run = this.writeTail.then(async () => {
      const records = await this.list();
      const next = await change(records);
      if (next.length === records.length && next.every((record, index) => record === records[index])) return;
      await this.files.writeJson(DELETIONS_FILE, deletionsToJson(next));
    });
    this.writeTail = run.catch(() => undefined);
    return run;
  }
}

function isRecord(value: unknown, sources: SourceDeclarations): value is DeletionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DeletionRecord>;
  return typeof record.sourceType === 'string' && isSourceType(sources, record.sourceType)
    && typeof record.sourceId === 'string' && isSourceId(sources, record.sourceType, record.sourceId)
    && typeof record.sourceUrl === 'string'
    && typeof record.title === 'string'
    && (record.publisherId === null || typeof record.publisherId === 'string')
    && typeof record.publisherName === 'string'
    && typeof record.deletedAt === 'string' && !Number.isNaN(Date.parse(record.deletedAt));
}
