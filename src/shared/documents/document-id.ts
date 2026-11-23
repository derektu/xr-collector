import type { DocumentKey } from './document-types.js';

export function documentId(key: DocumentKey): string {
  return `${key.sourceType}:${key.sourceId}`;
}
