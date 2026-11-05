/** ID of a source type whose documents the Vault can hold: the ID of a registered source plugin. */
export type DocumentSourceType = string;

/** A document's source type and source ID; together they form its ID, `<source type>:<source ID>`. */
export interface DocumentKey {
  sourceType: DocumentSourceType;
  sourceId: string;
}

/** Who published a document; `id` is null for documents saved without a stable publisher ID. */
export interface DocumentPublisher {
  id: string | null;
  name: string;
}

/**
 * Type-specific document details, each under a field named after its source type. Every source
 * plugin adds its own field to this interface; the core passes the field through untouched.
 */
export interface DocumentDetails {}

/**
 * How much of the item a document body holds: `full` for the whole content, `summary` for only the
 * summary the source offers.
 */
export type ContentExtent = 'full' | 'summary';

/** Source-independent document fields shared by browse, search and read. */
export interface DocumentMetadata extends DocumentDetails {
  id: string;
  /** The frontmatter `type` its source type gives its documents. */
  type: string;
  sourceType: DocumentSourceType;
  sourceId: string;
  sourceUrl: string;
  title: string;
  publisher: DocumentPublisher;
  publishedAt: string | null;
  collectedAt: string;
  /** Set on a document read from the Vault; browse and search results leave it out. */
  contentExtent?: ContentExtent;
}

export interface SavedDocument extends DocumentMetadata {
  bodyMarkdown: string;
}

export interface DocumentSummary extends DocumentMetadata {
  /** Plain-text opening of the body, not a generated summary. */
  excerpt: string;
}

/** Narrows browse and search to one source type, optionally one publisher within it. */
export interface DocumentFilter {
  sourceType?: DocumentSourceType;
  /** A publisher ID, or `none` for documents without one; requires `sourceType`. */
  publisherId?: string;
}

export interface DocumentPage {
  documents: DocumentSummary[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface DocumentSourcePublisher {
  id: string | null;
  name: string;
  count: number;
  /**
   * Whether the publisher is in the source's subscription list. False covers both a removed
   * subscription whose documents stay and a publisher only collected item by item; null when the
   * documents carry no publisher ID to match.
   */
  subscribed: boolean | null;
  /** The publisher's subscription was removed and not added again; its documents stay. */
  removed: boolean;
}

export interface DocumentSourceGroup {
  sourceType: DocumentSourceType;
  label: string;
  count: number;
  publishers: DocumentSourcePublisher[];
}

export interface DocumentSources {
  total: number;
  groups: DocumentSourceGroup[];
}

/** The result of deleting a document. */
export interface DocumentDeletion {
  deleted: { id: string; sourceType: DocumentSourceType; sourceId: string; title: string; deletedAt: string };
  /**
   * True when the search service excludes the document from results; its index entry is removed in
   * the background, and a failed removal is recorded as `document.index_remove_failed`. False when
   * no search service runs; the next search start compares the index with the Vault and leaves the
   * document out.
   */
  indexed: boolean;
  indexMessage?: string;
}

/**
 * A deleted item, kept so automatic and subscription collection do not bring it back. The title and
 * publisher let an import or a deleted-document page still name the item.
 */
export interface DeletionRecord extends DocumentKey {
  sourceUrl: string;
  title: string;
  publisherId: string | null;
  publisherName: string;
  /** When the deletion intent was recorded, from the same clock that stamps `collected_at`. */
  deletedAt: string;
}
