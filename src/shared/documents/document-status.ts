import type { DocumentStatus } from './document-types.js';

const STATUSES: Readonly<Record<DocumentStatus, true>> = { draft: true, published: true };

function isDocumentStatus(value: unknown): value is DocumentStatus {
  return typeof value === 'string' && Object.hasOwn(STATUSES, value);
}

/** The status a value names; null when it names none. */
export function parseDocumentStatus(value: unknown): DocumentStatus | null {
  return isDocumentStatus(value) ? value : null;
}

export function storedDocumentStatus(value: unknown): DocumentStatus {
  return parseDocumentStatus(value) ?? 'published';
}
