export type DocumentSourceType = string;

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

export type DocumentStatus = 'draft' | 'published';

export interface DocumentStatusCounts {
  draft: number;
  published: number;
}

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
  status: DocumentStatus;
  contentExtent?: ContentExtent;
}

export interface SavedDocument extends DocumentMetadata {
  bodyMarkdown: string;
}

export interface DocumentSummary extends DocumentMetadata {
  /** Plain-text opening of the body, not a generated summary. */
  excerpt: string;
}

export interface DocumentFilter {
  sourceType?: DocumentSourceType;
  /** A publisher ID, or `none` for documents without one. */
  publisherId?: string;
  status?: DocumentStatus;
}

export interface DocumentPage {
  documents: DocumentSummary[];
  /** Documents matching the whole filter. */
  total: number;
  /** Documents matching every filter but the status, by status. */
  statusCounts: DocumentStatusCounts;
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

export interface DocumentDeletion {
  deleted: { id: string; sourceType: DocumentSourceType; sourceId: string; title: string; deletedAt: string };
  /**
   * True when search already excludes the document and its index entry is removed in the background;
   * false when no search service runs, and the next search start leaves the document out.
   */
  indexed: boolean;
  indexMessage?: string;
}

export interface DeletionRecord extends DocumentKey {
  sourceUrl: string;
  title: string;
  publisherId: string | null;
  publisherName: string;
  deletedAt: string;
}
