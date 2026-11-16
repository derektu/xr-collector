import type { DocumentStatus } from './document-types.js';

/** Every document status, so a status added to the type must be added here to typecheck. */
const STATUSES: Readonly<Record<DocumentStatus, true>> = { draft: true, published: true };

/** The status a value names; null when it names none. Requests and frontmatter both read status through it. */
export function parseDocumentStatus(value: unknown): DocumentStatus | null {
  return typeof value === 'string' && Object.hasOwn(STATUSES, value) ? value as DocumentStatus : null;
}

/** The status of a document whose frontmatter `status` is `value`: published unless it names draft. */
export function storedDocumentStatus(value: unknown): DocumentStatus {
  return parseDocumentStatus(value) ?? 'published';
}
