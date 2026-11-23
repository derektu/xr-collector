import type { DocumentFilter, DocumentMetadata, DocumentStatusCounts, SavedDocument } from '../documents/document-types.js';

export interface SearchQuery extends DocumentFilter {
  query: string;
  offset?: number;
  limit?: number;
  publishedFrom?: string;
  publishedTo?: string;
}

export interface SearchHit extends DocumentMetadata {
  snippet: string;
}

export interface SearchResponse {
  hits: SearchHit[];
  total: number;
  statusCounts: DocumentStatusCounts;
  offset: number;
  limit: number;
}

export type SearchState = 'starting' | 'updating' | 'rebuilding' | 'ready' | 'error';

export interface SearchStatus {
  state: SearchState;
  indexedDocuments: number;
  lastRebuiltAt: string | null;
  message?: string;
}

export interface SearchStatusReport extends SearchStatus {
  vaultDocuments: number;
}

export interface TranscriptSearch {
  status(): SearchStatus;
  index(document: SavedDocument): Promise<void>;
  /** Removes a deleted document; it is excluded from results from the moment this is called. */
  remove(id: string): Promise<void>;
  search(query: SearchQuery): Promise<SearchResponse>;
  rebuild(): Promise<void>;
}
