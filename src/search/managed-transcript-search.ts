import type {
  SavedDocument,
  SearchQuery,
  SearchResponse,
  SearchState,
  SearchStatus,
  TranscriptSearch,
} from '../core/types.js';
import { CollectorError } from '../core/types.js';

export interface SearchBackend {
  initialize(): Promise<void>;
  count(): Promise<number>;
  /** Whether the index holds exactly these documents with identical content. */
  isCurrent(documents: SavedDocument[]): Promise<boolean>;
  replaceAll(documents: SavedDocument[]): Promise<void>;
  upsert(document: SavedDocument): Promise<void>;
  remove(ids: string[]): Promise<void>;
  /** `excludeIds` are document IDs left out of the results and the total. */
  search(query: SearchQuery, excludeIds: string[]): Promise<SearchResponse>;
}

/**
 * Deleted documents the index may still hold, at most this many. Searches leave them out with an
 * engine filter; beyond the limit the index is rebuilt from the Vault, which keeps every filter short.
 */
export const MAX_PENDING_REMOVALS = 100;

/** Device-side record of index maintenance that outlives one process. */
export interface SearchStateStore {
  load(): Promise<{ lastRebuiltAt: string | null }>;
  save(state: { lastRebuiltAt: string | null }): Promise<void>;
}

export interface SearchProjectionLifecycle {
  /** An engine/schema profile change removed the old projection, so even an empty Vault is rebuilt. */
  forceRebuild?: boolean;
  /** Commits the semantic profile only after a complete replacement succeeds. */
  afterRebuild?: () => Promise<void>;
}

export class ManagedTranscriptSearch implements TranscriptSearch {
  private currentStatus: SearchStatus = {
    state: 'starting',
    indexedDocuments: 0,
    lastRebuiltAt: null,
  };

  private operationTail: Promise<void> = Promise.resolve();
  /** Deleted documents not yet confirmed gone from the index; searches exclude them. */
  private readonly pendingRemovals = new Set<string>();

  constructor(
    private readonly backend: SearchBackend,
    private readonly loadDocuments: () => Promise<SavedDocument[]>,
    private readonly stateStore?: SearchStateStore,
    private readonly now: () => Date = () => new Date(),
    private readonly lifecycle: SearchProjectionLifecycle = {},
  ) {}

  status(): SearchStatus {
    return { ...this.currentStatus };
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      this.setState('starting');
      const stored = await this.stateStore?.load().catch(() => null);
      this.currentStatus = { ...this.currentStatus, lastRebuiltAt: stored?.lastRebuiltAt ?? null };
      await this.backend.initialize();
      const removed = [...this.pendingRemovals];
      const documents = await this.loadDocuments();
      // Equal counts do not prove freshness; compare every document's content fingerprint.
      if (this.lifecycle.forceRebuild || !(await this.backend.isCurrent(documents))) await this.replaceAll(documents);
      for (const id of removed) this.pendingRemovals.delete(id);
      this.currentStatus = {
        state: 'ready',
        indexedDocuments: documents.length,
        lastRebuiltAt: this.currentStatus.lastRebuiltAt,
      };
    }, '無法啟動搜尋索引。');
  }

  rebuild(): Promise<void> {
    return this.enqueue(async () => {
      const removed = [...this.pendingRemovals];
      const documents = await this.loadDocuments();
      await this.replaceAll(documents);
      for (const id of removed) this.pendingRemovals.delete(id);
      this.currentStatus = {
        state: 'ready',
        indexedDocuments: documents.length,
        lastRebuiltAt: this.currentStatus.lastRebuiltAt,
      };
    }, '無法重建搜尋索引。');
  }

  index(document: SavedDocument): Promise<void> {
    return this.enqueue(async () => {
      this.setState('updating');
      await this.backend.upsert(document);
      this.pendingRemovals.delete(document.id);
      await this.flushRemovals().catch(() => undefined);
      this.currentStatus = {
        state: 'ready',
        indexedDocuments: await this.backend.count(),
        lastRebuiltAt: this.currentStatus.lastRebuiltAt,
      };
    }, '無法更新搜尋索引。');
  }

  /**
   * Excludes the document from searches at once, then removes it from the index. A failed removal
   * keeps the exclusion and is tried again with the next index change; once too many removals wait,
   * the index is rebuilt from the Vault.
   */
  remove(id: string): Promise<void> {
    this.pendingRemovals.add(id);
    if (this.pendingRemovals.size > MAX_PENDING_REMOVALS) {
      return this.enqueue(async () => {
        const removed = [...this.pendingRemovals];
        await this.replaceAll(await this.loadDocuments());
        for (const id of removed) this.pendingRemovals.delete(id);
        this.currentStatus = {
          state: 'ready',
          indexedDocuments: await this.backend.count(),
          lastRebuiltAt: this.currentStatus.lastRebuiltAt,
        };
      }, '無法重建搜尋索引。');
    }
    const run = this.operationTail.then(async () => {
      await this.flushRemovals();
      if (this.currentStatus.state === 'ready') {
        this.currentStatus = { ...this.currentStatus, indexedDocuments: await this.backend.count().catch(() => this.currentStatus.indexedDocuments) };
      }
    });
    this.operationTail = run.catch(() => undefined);
    return run;
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    if (this.currentStatus.state !== 'ready' || this.pendingRemovals.size > MAX_PENDING_REMOVALS) {
      throw new CollectorError(
        'search_unavailable',
        this.currentStatus.message ?? '搜尋索引尚未就緒。',
      );
    }
    try {
      return await this.backend.search(query, [...this.pendingRemovals]);
    } catch (error) {
      this.currentStatus = {
        ...this.currentStatus,
        state: 'error',
        message: '無法查詢搜尋索引。',
      };
      throw new CollectorError(
        'search_unavailable',
        '無法查詢搜尋索引。',
        { cause: error },
      );
    }
  }

  private async flushRemovals(): Promise<void> {
    if (this.pendingRemovals.size === 0) return;
    const ids = [...this.pendingRemovals];
    await this.backend.remove(ids);
    for (const id of ids) this.pendingRemovals.delete(id);
  }

  private async replaceAll(documents: SavedDocument[]): Promise<void> {
    this.setState('rebuilding');
    await this.backend.replaceAll(documents);
    const lastRebuiltAt = this.now().toISOString();
    this.currentStatus = { ...this.currentStatus, lastRebuiltAt };
    await this.stateStore?.save({ lastRebuiltAt }).catch((error: unknown) => {
      console.warn('Unable to record the search rebuild time', error);
    });
    await this.lifecycle.afterRebuild?.();
  }

  private enqueue(work: () => Promise<void>, errorMessage: string): Promise<void> {
    const run = this.operationTail.then(work, work).catch((error: unknown) => {
      this.currentStatus = {
        ...this.currentStatus,
        state: 'error',
        message: errorMessage,
      };
      throw error;
    });
    this.operationTail = run.catch(() => undefined);
    return run;
  }

  private setState(state: SearchState): void {
    const { message: _message, ...status } = this.currentStatus;
    this.currentStatus = { ...status, state };
  }
}

export class UnavailableTranscriptSearch implements TranscriptSearch {
  private readonly currentStatus: SearchStatus;

  constructor(message: string) {
    this.currentStatus = {
      state: 'error',
      indexedDocuments: 0,
      lastRebuiltAt: null,
      message,
    };
  }

  status(): SearchStatus {
    return { ...this.currentStatus };
  }

  async index(): Promise<void> {
    throw new CollectorError('search_unavailable', this.currentStatus.message ?? '搜尋服務無法使用。');
  }

  async remove(): Promise<void> {
    throw new CollectorError('search_unavailable', this.currentStatus.message ?? '搜尋服務無法使用。');
  }

  async search(): Promise<SearchResponse> {
    throw new CollectorError('search_unavailable', this.currentStatus.message ?? '搜尋服務無法使用。');
  }

  async rebuild(): Promise<void> {
    throw new CollectorError('search_unavailable', this.currentStatus.message ?? '搜尋服務無法使用。');
  }
}
