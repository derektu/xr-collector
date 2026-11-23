import type { DocumentKey, SavedDocument } from './document-types.js';
import type { CapturedDocument } from '../sources/source-contract.js';

/** `explicitAt` is when the user asked for this one item; null for automatic and subscription collection. */
export interface SaveIntent {
  explicitAt: string | null;
}

export interface IndexOutcome {
  indexed: boolean;
  message?: string;
  deleted?: boolean;
}

export interface DocumentCollector {
  findExisting(key: DocumentKey): Promise<SavedDocument | null>;
  /** Whether discovery should pass over this item: it is in the Vault or the user deleted it. */
  isKnown(key: DocumentKey): Promise<boolean>;
  /** Whether a deletion keeps this request from collecting the item. */
  isDeletedFor(key: DocumentKey, intent: SaveIntent): Promise<boolean>;
  /** Saves a captured item; a deleted item that `intent` may not collect again fails with `document_deleted`. */
  save(captured: CapturedDocument, intent: SaveIntent): Promise<{ document: SavedDocument }>;
  /** Indexes the document as the Vault holds it now. */
  index(document: SavedDocument): Promise<IndexOutcome>;
}
