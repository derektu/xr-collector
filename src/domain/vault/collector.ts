import type { NoteChange } from '../../shared/api/changes.js';
import type {
  DocumentDeletion,
  DocumentFilter,
  DocumentKey,
  DocumentMetadata,
  DocumentPage,
  DocumentSourcePublisher,
  DocumentSources,
  DocumentStatus,
  DocumentStatusCounts,
  SavedDocument,
} from '../../shared/documents/document-types.js';
import type { SubscriptionRecord } from '../../shared/subscriptions/subscription-types.js';
import type { TranscriptSearch } from '../../shared/api/search-types.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import { documentExcerpt } from '../../shared/documents/document-text.js';
import type { CapturedDocument } from '../../shared/sources/source-contract.js';
import { collectedBeforeDeletion } from '../../shared/documents/deletion-rule.js';
import { documentId } from '../../shared/documents/document-id.js';
import type { NewJobEvent } from '../../shared/activity/activity-types.js';
import { NO_PUBLISHER_ID, type DocumentVault } from '../../shared/documents/document-vault.js';
import type { DocumentCollector, IndexOutcome, SaveIntent } from '../../shared/documents/document-collector.js';
import type { LogWriter } from '../../shared/log/log-types.js';

export interface TypeSubscriptions {
  subscriptions: SubscriptionRecord[];
  removals?: Array<{ id: string; title: string }>;
}

export interface CollectorOptions {
  log: LogWriter;
  recordEvent?: (entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>) => void;
  noteChange?: NoteChange;
}

export class Collector implements DocumentCollector {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly vault: DocumentVault,
    private readonly search: (Pick<TranscriptSearch, 'index'> & Partial<Pick<TranscriptSearch, 'remove'>>) | undefined,
    private readonly options: CollectorOptions,
  ) {}

  findExisting(key: DocumentKey): Promise<SavedDocument | null> {
    return this.vault.getByKey(key);
  }

  async isKnown(key: DocumentKey): Promise<boolean> {
    if (await this.vault.getByKey(key)) return true;
    return (await this.vault.deletions.get(documentId(key))) != null;
  }

  async isDeletedFor(key: DocumentKey, intent: SaveIntent): Promise<boolean> {
    const deletion = await this.vault.deletions.get(documentId(key));
    return deletion != null && !explicitAfter(intent, deletion.deletedAt);
  }

  save(captured: CapturedDocument, intent: SaveIntent = { explicitAt: null }): Promise<{ document: SavedDocument }> {
    const id = documentId({ sourceType: captured.sourceType, sourceId: captured.key });
    return this.exclusive(id, async () => {
      const deletion = await this.vault.deletions.get(id);
      if (!deletion) {
        const document = await this.vault.add(captured);
        this.noted(id);
        return { document };
      }
      if (!explicitAfter(intent, deletion.deletedAt)) {
        const target = this.vault.sources.get(captured.sourceType)?.subscription?.targetNoun ?? '訂閱';
        throw new CollectorError('document_deleted', `這份文件已刪除，自動與${target}收集會略過。`);
      }
      const now = this.vault.now();
      const after = new Date(Date.parse(deletion.deletedAt) + 1);
      const document = await this.vault.add(captured, { collectedAt: now > after ? now : after });
      await this.vault.deletions.clear(id);
      this.noted(id);
      return { document };
    });
  }

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
        this.options.log.write({ level: 'error', source: 'vault', message: 'Search index update failed', error });
        return { indexed: false, message: '搜尋索引更新失敗，可稍後重建索引。' };
      }
    });
  }

  delete(id: string): Promise<DocumentDeletion> {
    return this.exclusive(id, async () => {
      const { deletions } = this.vault;
      const document = await this.vault.read(id);
      if (!document) {
        if (await deletions.get(id)) throw new CollectorError('document_deleted', '這份文件已刪除。');
        throw new CollectorError('document_not_found', '找不到這份文件。');
      }
      const record = await deletions.record({
        sourceType: document.sourceType, sourceId: document.sourceId, sourceUrl: document.sourceUrl, title: document.title,
        publisherId: document.publisher.id, publisherName: document.publisher.name,
      });
      const event = { documentId: id, sourceId: document.sourceId, sourceTitle: document.title, namesSource: true as const };
      try {
        await this.vault.remove(id);
      } catch (error) {
        this.options.log.write({ level: 'error', source: 'vault', message: 'Document file removal failed', error });
        this.options.recordEvent?.({
          eventType: 'document.delete_failed', ...event,
          message: `「${document.title}」已標記為刪除，但檔案無法移除。`,
        });
      }
      let indexed = true;
      let indexMessage: string | undefined;
      if (!this.search?.remove) {
        indexed = false;
        indexMessage = '搜尋服務尚未啟用；下次啟動搜尋時會排除這份文件。';
      } else {
        void this.search.remove(id).catch((error: unknown) => {
          this.options.log.write({ level: 'error', source: 'vault', message: 'Search index removal failed', error });
          this.options.recordEvent?.({
            eventType: 'document.index_remove_failed', ...event,
            message: `「${document.title}」已刪除，搜尋索引稍後更新；搜尋結果已排除這份文件。`,
          });
        });
      }
      this.noted(id);
      this.options.recordEvent?.({ eventType: 'document.deleted', message: `已刪除「${document.title}」。`, ...event });
      return {
        deleted: { id, sourceType: record.sourceType, sourceId: record.sourceId, title: record.title, deletedAt: record.deletedAt },
        indexed,
        ...(indexMessage ? { indexMessage } : {}),
      };
    });
  }

  setStatus(id: string, status: DocumentStatus): Promise<SavedDocument> {
    return this.exclusive(id, async () => {
      const current = await this.read(id);
      if (current.status === status) return current;
      const document = await this.vault.writeStatus(id, status);
      const event = { documentId: id, sourceId: document.sourceId, sourceTitle: document.title, namesSource: true as const };
      if (this.search) {
        try {
          await this.search.index(document);
        } catch (error) {
          this.options.log.write({ level: 'error', source: 'vault', message: 'Search index update failed', error });
          this.options.recordEvent?.({
            eventType: 'document.index_failed', ...event,
            message: `「${document.title}」的狀態已變更，搜尋索引更新失敗，可稍後重建索引。`,
          });
        }
      }
      this.noted(id);
      this.options.recordEvent?.({
        eventType: 'document.status_changed', detail: status, ...event,
        message: status === 'published' ? `已發布「${document.title}」。` : `已將「${document.title}」改回草稿。`,
      });
      return document;
    });
  }

  private noted(id: string): void {
    this.options.noteChange?.({ kind: 'document', id });
  }

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

  async listDocuments(filter: DocumentFilter, page: { offset: number; limit: number }): Promise<DocumentPage> {
    const { status, ...others } = filter;
    const statusCounts: DocumentStatusCounts = { draft: 0, published: 0 };
    const matching: DocumentMetadata[] = [];
    for (const document of await this.vault.list()) {
      if (!matchesFilter(document, others)) continue;
      statusCounts[document.status] += 1;
      if (status === undefined || document.status === status) matching.push(document);
    }
    const slice = matching.slice(page.offset, page.offset + page.limit);
    const documents = await Promise.all(slice.map(async (metadata) => {
      const document = await this.vault.read(metadata.id);
      return { ...metadata, excerpt: document ? documentExcerpt(document.bodyMarkdown) : '' };
    }));
    return {
      documents,
      total: matching.length,
      statusCounts,
      offset: page.offset,
      limit: page.limit,
      nextOffset: page.offset + page.limit < matching.length ? page.offset + page.limit : null,
    };
  }

  async sources(byType: Readonly<Record<string, TypeSubscriptions>>): Promise<DocumentSources> {
    const documents = await this.vault.list();
    const groups = new Map<DocumentMetadata['sourceType'], Map<string, DocumentSourcePublisher>>();
    for (const document of documents) {
      const publishers = groups.get(document.sourceType) ?? new Map<string, DocumentSourcePublisher>();
      groups.set(document.sourceType, publishers);
      const key = document.publisher.id ?? NO_PUBLISHER_ID;
      const entry = publishers.get(key);
      if (entry) entry.count += 1;
      else publishers.set(key, { id: document.publisher.id, name: document.publisher.name, count: 1, subscribed: false, removed: false });
    }
    return {
      total: documents.length,
      groups: [...groups.entries()].map(([sourceType, publishers]) => {
        const declaration = this.vault.sources.get(sourceType);
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
      if (await this.vault.deletions.get(id)) throw new CollectorError('document_deleted', '這份文件已刪除。');
      throw new CollectorError('document_not_found', '找不到這份文件。');
    }
    return document;
  }
}

function explicitAfter(intent: SaveIntent, deletedAt: string): boolean {
  return intent.explicitAt !== null && !collectedBeforeDeletion(intent.explicitAt, deletedAt);
}

function matchesFilter(document: DocumentMetadata, filter: Omit<DocumentFilter, 'status'>): boolean {
  if (filter.sourceType && document.sourceType !== filter.sourceType) return false;
  if (filter.publisherId === undefined) return true;
  return filter.publisherId === NO_PUBLISHER_ID ? document.publisher.id === null : document.publisher.id === filter.publisherId;
}

function comparePublishers(left: DocumentSourcePublisher, right: DocumentSourcePublisher): number {
  if ((left.id === null) !== (right.id === null)) return left.id === null ? 1 : -1;
  return left.name.localeCompare(right.name, 'zh-Hant') || (left.id ?? '').localeCompare(right.id ?? '');
}
