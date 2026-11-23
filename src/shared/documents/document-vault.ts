import type { DeletionRecord, DocumentKey, DocumentMetadata, DocumentStatus, SavedDocument } from './document-types.js';
import type { SourceDeclarations } from '../sources/source-registry.js';
import type { CapturedDocument } from '../sources/source-contract.js';

/** Filter value that selects documents saved without a publisher ID. */
export const NO_PUBLISHER_ID = 'none';

/** `read`, `list` and `getByKey` return only visible documents. */
export interface DocumentVault {
  readonly sources: SourceDeclarations;
  getByKey(key: DocumentKey): Promise<SavedDocument | null>;
  add(document: CapturedDocument, options?: { collectedAt?: Date }): Promise<SavedDocument>;
  list(): Promise<DocumentMetadata[]>;
  read(id: string): Promise<SavedDocument | null>;
  remove(id: string): Promise<void>;
  /** Sets a visible document's status and stamps its change time. */
  writeStatus(id: string, status: DocumentStatus): Promise<SavedDocument>;
  deletions: DeletionRecords;
  now: () => Date;
}

/** The deletion records of one Vault, keyed by document ID. */
export interface DeletionRecords {
  get(id: string): Promise<DeletionRecord | null>;
  /** Records a deletion stamped with the Vault clock, replacing an earlier record of the same item. */
  record(entry: Omit<DeletionRecord, 'deletedAt'>): Promise<DeletionRecord>;
  /** Lifts the deletion of one item; nothing happens when it has none. */
  clear(id: string): Promise<void>;
}
