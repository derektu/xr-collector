import type { NoteChange } from './change-feed.js';
import type {
  DocumentDeletion,
  DocumentFilter,
  DocumentMetadata,
  DocumentPage,
  DocumentSourcePublisher,
  DocumentSources,
  SavedDocument,
  SubscriptionRecord,
  TranscriptSearch,
} from './types.js';
import { CollectorError } from './types.js';
import { documentExcerpt } from './document-text.js';
import { sourceDeclaration } from './source-registry.js';
import type { CapturedDocument } from '../plugins/types.js';
import { collectedBeforeDeletion, deletionId, type DeletionLedger, type DeletionRecord } from '../vault/deleted-documents.js';
import { documentId, type DocumentKey } from '../vault/document-paths.js';
import type { NewJobEvent } from '../jobs/job-store.js';

/** Filter value that selects documents saved without a publisher ID. */
export const NO_PUBLISHER_ID = 'none';

/** The subscriptions of one source type, as the document source groups name publishers after them. */
export interface TypeSubscriptions {
  subscriptions: SubscriptionRecord[];
  /** Removal records of subscriptions removed and not added again. */
  removals?: Array<{ id: string; title: string }>;
}

/** Documents of one Vault; `read`, `list` and `getByKey` return only visible documents. */
export interface DocumentVault {
  getByKey(key: DocumentKey): Promise<SavedDocument | null>;
  add(document: CapturedDocument, options?: { collectedAt?: Date }): Promise<SavedDocument>;
  list(): Promise<DocumentMetadata[]>;
  read(id: string): Promise<SavedDocument | null>;
  /** Removes a document file. Vaults without deletion records cannot delete. */
  remove?(id: string): Promise<void>;
  deletions?: DeletionLedger;
  /** The clock behind collection and deletion times. */
  now?: () => Date;
}

export interface IndexOutcome {
  indexed: boolean;
  message?: string;
  /** The document was deleted before it could be indexed; nothing was indexed. */
  deleted?: boolean;
}

/**
 * Why a document is being saved. `explicitAt` is when the user asked for this one item; it is null
 * for automatic and subscription collection. Only an explicit request made after a deletion collects a
 * deleted item again.
 */
export interface SaveIntent {
  explicitAt: string | null;
}

export interface SaveResult {
  document: SavedDocument;
  /** The save lifted a deletion record. */
  recollected: boolean;
}

export interface CollectorOptions {
  /** Records a Vault-level event, such as a deletion, in the device activity log. */
  recordEvent?: (entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>) => void;
  /** Hears each document saved, indexed or deleted, once reads return the change. */
  noteChange?: NoteChange;
}

/**
 * Saves captured documents to one Vault and keeps its search projection in step. Saving, indexing
 * and deleting the same item run one at a time, so a deletion never interleaves with a save or an
 * index update of that item.
 */
export class Collector {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly vault: DocumentVault,
    private readonly search?: Pick<TranscriptSearch, 'index'> & Partial<Pick<TranscriptSearch, 'remove'>>,
    private readonly options: CollectorOptions = {},
  ) {}

  findExisting(key: DocumentKey): Promise<SavedDocument | null> {
    return this.vault.getByKey(key);
  }

  /** Whether discovery should pass over this item: it is in the Vault or the user deleted it. */
  async isKnown(key: DocumentKey): Promise<boolean> {
    if (await this.vault.getByKey(key)) return true;
    return (await this.vault.deletions?.get(documentId(key))) != null;
  }

  /** Whether a deletion keeps this request from collecting the item: a record exists and the request does not postdate it. */
  async isDeletedFor(key: DocumentKey, intent: SaveIntent): Promise<boolean> {
    const deletion = await this.vault.deletions?.get(documentId(key));
    return deletion != null && !explicitAfter(intent, deletion.deletedAt);
  }

  /**
   * Saves a captured item. A deleted item is saved only for an explicit request made after the
   * deletion: the document is stamped after the deletion time, then the record is lifted, so a stop
   * in between still leaves the document visible. Any other save of a deleted item fails with
   * `document_deleted`.
   */
  save(captured: CapturedDocument, intent: SaveIntent = { explicitAt: null }): Promise<SaveResult> {
    const id = documentId({ sourceType: captured.sourceType, sourceId: captured.key });
    return this.exclusive(id, async () => {
      const deletion = await this.vault.deletions?.get(id);
      if (!deletion) {
        const document = await this.vault.add(captured);
        this.noted(id);
        return { document, recollected: false };
      }
      if (!explicitAfter(intent, deletion.deletedAt)) {
        const target = sourceDeclaration(captured.sourceType)?.subscription?.targetNoun ?? '訂閱';
        throw new CollectorError('document_deleted', `這份文件已刪除，自動與${target}收集會略過。`);
      }
      const now = (this.vault.now ?? (() => new Date()))();
      const after = new Date(Date.parse(deletion.deletedAt) + 1);
      const document = await this.vault.add(captured, { collectedAt: now > after ? now : after });
      await this.vault.deletions!.clear(id);
      this.noted(id);
      this.options.recordEvent?.({
        severity: 'info', eventType: 'document.recollected', message: `已重新收集「${document.title}」，解除刪除紀錄。`,
        documentId: id, sourceId: document.sourceId, sourceTitle: document.title,
      });
      return { document, recollected: true };
    });
  }

  /**
   * Indexes the document as the Vault holds it now. A document deleted meanwhile is not indexed.
   * The Vault is authoritative: a failed index update reports itself and keeps the saved document.
   */
  index(document: SavedDocument): Promise<IndexOutcome> {
    return this.exclusive(document.id, async () => {
      const current = await this.vault.read(document.id);
      if (!current) return { indexed: false, deleted: true };
      if (!this.search) return { indexed: false, message: '搜尋服務尚未啟用。' };
      try {
        await this.search.index(current);
        this.noted(current.id);
        return { indexed: true };
      } catch (error) {
        console.error('Search index update failed', error);
        return { indexed: false, message: '搜尋索引更新失敗，可稍後重建索引。' };
      }
    });
  }

  /**
   * Deletes a document: the deletion record goes first and hides the document at once, then the
   * file is removed and the search excludes the document. The index entry is removed in the
   * background, so a deletion never waits for a rebuild; a failed removal is recorded as a warning
   * and the document stays excluded until the index catches up. A stop after the record leaves work
   * that opening the Vault finishes.
   */
  delete(id: string): Promise<DocumentDeletion> {
    return this.exclusive(id, async () => {
      const { deletions, remove } = this.vault;
      if (!deletions || !remove) throw new CollectorError('invalid_request', '這個知識庫不支援刪除文件。');
      const document = await this.vault.read(id);
      if (!document) {
        if (await deletions.get(id)) throw new CollectorError('document_deleted', '這份文件已刪除。');
        throw new CollectorError('document_not_found', '找不到這份文件。');
      }
      const record = await deletions.record({
        sourceType: document.sourceType, sourceId: document.sourceId, sourceUrl: document.sourceUrl, title: document.title,
        publisherId: document.publisher.id, publisherName: document.publisher.name,
      });
      const event = { documentId: id, sourceId: document.sourceId, sourceTitle: document.title };
      try {
        await remove.call(this.vault, id);
      } catch (error) {
        console.error('Document file removal failed', error);
        this.options.recordEvent?.({
          severity: 'error', eventType: 'document.delete_failed', ...event,
          message: `「${document.title}」已標記為刪除，但檔案無法移除；下次開啟知識庫時會再移除。`,
        });
      }
      let indexed = true;
      let indexMessage: string | undefined;
      if (!this.search?.remove) {
        indexed = false;
        indexMessage = '搜尋服務尚未啟用；下次啟動搜尋時會排除這份文件。';
      } else {
        // Calling remove excludes the document from searches at once; the index entry goes in the background.
        void this.search.remove(id).catch((error: unknown) => {
          console.error('Search index removal failed', error);
          this.options.recordEvent?.({
            severity: 'warning', eventType: 'document.index_remove_failed', ...event,
            message: `「${document.title}」已刪除，搜尋索引稍後更新；搜尋結果已排除這份文件。`,
          });
        });
      }
      // Noted once searches exclude the document, so a reader searching again after it no longer finds it.
      this.noted(id);
      this.options.recordEvent?.({ severity: 'info', eventType: 'document.deleted', message: `已刪除「${document.title}」。`, ...event });
      return {
        deleted: { id, sourceType: record.sourceType, sourceId: record.sourceId, title: record.title, deletedAt: record.deletedAt },
        indexed,
        ...(indexMessage ? { indexMessage } : {}),
      };
    });
  }

  /**
   * Records the deletion of an item that has no document yet, such as an item still capturing, so
   * a capture that finishes later is not saved (`document_deleted`) unless an explicit request
   * comes after the record. An item already in the Vault or already deleted is left alone.
   */
  recordDeletion(entry: Omit<DeletionRecord, 'deletedAt'>): Promise<void> {
    const id = deletionId(entry);
    return this.exclusive(id, async () => {
      const { deletions } = this.vault;
      if (!deletions) throw new CollectorError('invalid_request', '這個知識庫不支援刪除文件。');
      if (await this.vault.read(id) || await deletions.get(id)) return;
      await deletions.record(entry);
    });
  }

  private noted(id: string): void {
    this.options.noteChange?.({ kind: 'document', id });
  }

  /** Runs `work` after every earlier operation on the same item has finished. */
  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(id, tail);
    void tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return run;
  }

  /** Metadata of every document, newest collection first, then by ID. */
  list(): Promise<DocumentMetadata[]> {
    return this.vault.list();
  }

  /** One page of Vault documents; only the returned page is read for excerpts. */
  async listDocuments(filter: DocumentFilter, page: { offset: number; limit: number }): Promise<DocumentPage> {
    const matching = (await this.vault.list()).filter((document) => matchesFilter(document, filter));
    const slice = matching.slice(page.offset, page.offset + page.limit);
    const documents = await Promise.all(slice.map(async (metadata) => {
      const document = await this.vault.read(metadata.id);
      return { ...metadata, excerpt: document ? documentExcerpt(document.bodyMarkdown) : '' };
    }));
    return {
      documents,
      total: matching.length,
      offset: page.offset,
      limit: page.limit,
      nextOffset: page.offset + page.limit < matching.length ? page.offset + page.limit : null,
    };
  }

  /**
   * Document counts per source type and publisher, named after the type's subscription list when
   * present, otherwise after the removal record of a removed subscription.
   */
  async sources(byType: Readonly<Record<string, TypeSubscriptions>>): Promise<DocumentSources> {
    const documents = await this.vault.list();
    const groups = new Map<DocumentMetadata['sourceType'], Map<string, DocumentSourcePublisher>>();
    for (const document of documents) {
      const publishers = groups.get(document.sourceType) ?? new Map<string, DocumentSourcePublisher>();
      groups.set(document.sourceType, publishers);
      const key = document.publisher.id ?? NO_PUBLISHER_ID;
      const entry = publishers.get(key);
      // Documents arrive newest first, so the first name seen is the most recent one.
      if (entry) entry.count += 1;
      else publishers.set(key, { id: document.publisher.id, name: document.publisher.name, count: 1, subscribed: false, removed: false });
    }
    return {
      total: documents.length,
      groups: [...groups.entries()].map(([sourceType, publishers]) => {
        const declaration = sourceDeclaration(sourceType);
        const subscribed = new Map((byType[sourceType]?.subscriptions ?? []).map((record) => [record.id, record]));
        const removals = new Map((byType[sourceType]?.removals ?? []).map((record) => [record.id, record]));
        const unknown = `未知${declaration?.subscription?.targetNoun ?? '發布者'}`;
        const list = [...publishers.values()].map((publisher) => {
          const subscription = publisher.id ? subscribed.get(publisher.id) : undefined;
          if (publisher.id === null) return { ...publisher, name: unknown, subscribed: null };
          if (subscription) return { ...publisher, name: subscription.title || publisher.name, subscribed: true };
          const removal = publisher.id ? removals.get(publisher.id) : undefined;
          return removal ? { ...publisher, name: removal.title || publisher.name, removed: true } : publisher;
        }).sort(comparePublishers);
        return {
          sourceType,
          label: declaration?.label ?? sourceType,
          count: list.reduce((sum, publisher) => sum + publisher.count, 0),
          publishers: list,
        };
      }),
    };
  }

  async read(id: string): Promise<SavedDocument> {
    const document = await this.vault.read(id);
    if (!document) {
      if (await this.vault.deletions?.get(id)) throw new CollectorError('document_deleted', '這份文件已刪除。');
      throw new CollectorError('document_not_found', '找不到這份文件。');
    }
    return document;
  }
}

/** Whether the request is explicit and made after the deletion; a request at the deletion time counts as before it. */
function explicitAfter(intent: SaveIntent, deletedAt: string): boolean {
  return intent.explicitAt !== null && !collectedBeforeDeletion(intent.explicitAt, deletedAt);
}

function matchesFilter(document: DocumentMetadata, filter: DocumentFilter): boolean {
  if (filter.sourceType && document.sourceType !== filter.sourceType) return false;
  if (filter.publisherId === undefined) return true;
  return filter.publisherId === NO_PUBLISHER_ID ? document.publisher.id === null : document.publisher.id === filter.publisherId;
}

/** Named publishers alphabetically, same names by ID; documents without a publisher ID last. */
function comparePublishers(left: DocumentSourcePublisher, right: DocumentSourcePublisher): number {
  if ((left.id === null) !== (right.id === null)) return left.id === null ? 1 : -1;
  return left.name.localeCompare(right.name, 'zh-Hant') || (left.id ?? '').localeCompare(right.id ?? '');
}
