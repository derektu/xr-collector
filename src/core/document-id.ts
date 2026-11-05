import type { DocumentKey } from './document-types.js';

/** The ID of a document: `<source type>:<source ID>`. */
export function documentId(key: DocumentKey): string {
  return `${key.sourceType}:${key.sourceId}`;
}
