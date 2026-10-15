import type {
  CapturedTranscript,
  DocumentSummary,
  SavedDocument,
  TranscriptSearch,
} from './types.js';
import { CollectorError } from './types.js';

export interface DocumentVault {
  getBySourceId(sourceId: string): Promise<SavedDocument | null>;
  add(capture: CapturedTranscript): Promise<SavedDocument>;
  list(): Promise<DocumentSummary[]>;
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

  list(): Promise<DocumentSummary[]> {
    return this.vault.list();
  }

  async read(id: string): Promise<SavedDocument> {
    const document = await this.vault.read(id);
    if (!document) {
      throw new CollectorError('document_not_found', '找不到這份文件。');
    }
    return document;
  }
}
