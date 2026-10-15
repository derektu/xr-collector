import type {
  CapturedTranscript,
  DocumentFilter,
  DocumentMetadata,
  DocumentPage,
  DocumentSourcePublisher,
  DocumentSources,
  SavedDocument,
  TranscriptSearch,
  YouTubeChannel,
} from './types.js';
import { CollectorError } from './types.js';
import { documentExcerpt } from './document-text.js';

/** Filter value that selects documents saved without a publisher ID. */
export const NO_PUBLISHER_ID = 'none';
const SOURCE_LABELS: Record<DocumentMetadata['sourceType'], string> = { youtube: 'YouTube' };

export interface DocumentVault {
  getBySourceId(sourceId: string): Promise<SavedDocument | null>;
  add(capture: CapturedTranscript): Promise<SavedDocument>;
  list(): Promise<DocumentMetadata[]>;
  read(id: string): Promise<SavedDocument | null>;
}

export interface IndexOutcome {
  indexed: boolean;
  message?: string;
}

/** Saves captured documents to one Vault and keeps its search projection in step. */
export class Collector {
  constructor(
    private readonly vault: DocumentVault,
    private readonly search?: Pick<TranscriptSearch, 'index'>,
  ) {}

  findExisting(videoId: string): Promise<SavedDocument | null> {
    return this.vault.getBySourceId(videoId);
  }

  save(captured: CapturedTranscript): Promise<SavedDocument> {
    return this.vault.add(captured);
  }

  /** The Vault is authoritative: a failed index update reports itself and keeps the saved document. */
  async index(document: SavedDocument): Promise<IndexOutcome> {
    if (!this.search) return { indexed: false, message: '搜尋服務尚未啟用。' };
    try {
      await this.search.index(document);
      return { indexed: true };
    } catch (error) {
      console.error('Search index update failed', error);
      return { indexed: false, message: '搜尋索引更新失敗，可稍後重建索引。' };
    }
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

  /** Document counts per source type and publisher, named after the subscription list when present. */
  async sources(subscriptions: { youtube: YouTubeChannel[] }): Promise<DocumentSources> {
    const documents = await this.vault.list();
    const groups = new Map<DocumentMetadata['sourceType'], Map<string, DocumentSourcePublisher>>();
    for (const document of documents) {
      const publishers = groups.get(document.sourceType) ?? new Map<string, DocumentSourcePublisher>();
      groups.set(document.sourceType, publishers);
      const key = document.publisher.id ?? NO_PUBLISHER_ID;
      const entry = publishers.get(key);
      // Documents arrive newest first, so the first name seen is the most recent one.
      if (entry) entry.count += 1;
      else publishers.set(key, { id: document.publisher.id, name: document.publisher.name, count: 1, subscribed: false });
    }
    const channels = new Map(subscriptions.youtube.map((channel) => [channel.id, channel]));
    return {
      total: documents.length,
      groups: [...groups.entries()].map(([sourceType, publishers]) => {
        const list = [...publishers.values()].map((publisher) => {
          const channel = sourceType === 'youtube' && publisher.id ? channels.get(publisher.id) : undefined;
          if (publisher.id === null) return { ...publisher, name: '未知頻道', subscribed: null };
          return channel ? { ...publisher, name: channel.title || publisher.name, subscribed: true } : publisher;
        }).sort(comparePublishers);
        return {
          sourceType,
          label: SOURCE_LABELS[sourceType],
          count: list.reduce((sum, publisher) => sum + publisher.count, 0),
          publishers: list,
        };
      }),
    };
  }

  async read(id: string): Promise<SavedDocument> {
    const document = await this.vault.read(id);
    if (!document) {
      throw new CollectorError('document_not_found', '找不到這份文件。');
    }
    return document;
  }
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
