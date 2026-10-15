import type { DocumentSourceType } from '../core/types.js';

/**
 * Where documents live in a Vault and how a document ID maps to its file. A document ID is
 * `<source type>:<source ID>` and its file is `documents/<source type>/<source ID>.md`, relative to
 * the Vault root with `/` separators. Each source type defines which source IDs it accepts, so a
 * path or ID of an unknown source type, or a malformed source ID, is never a document.
 */
const SOURCE_ID_RULES: Readonly<Record<DocumentSourceType, RegExp>> = {
  youtube: /^[A-Za-z0-9_-]{11}$/u,
};

export interface DocumentKey {
  sourceType: DocumentSourceType;
  sourceId: string;
}

export function isSourceType(value: string): value is DocumentSourceType {
  return Object.hasOwn(SOURCE_ID_RULES, value);
}

export function isSourceId(sourceType: DocumentSourceType, sourceId: string): boolean {
  return SOURCE_ID_RULES[sourceType].test(sourceId);
}

export function documentId(key: DocumentKey): string {
  return `${key.sourceType}:${key.sourceId}`;
}

export function documentPath(key: DocumentKey): string {
  return `documents/${key.sourceType}/${key.sourceId}.md`;
}

/** The source type and ID of a document file path, or null when the path is not a document. */
export function documentKeyFromPath(relative: string): DocumentKey | null {
  const match = /^documents\/([^/]+)\/([^/]+)\.md$/u.exec(relative);
  if (!match) return null;
  const [, sourceType = '', sourceId = ''] = match;
  if (!isSourceType(sourceType) || !isSourceId(sourceType, sourceId)) return null;
  return { sourceType, sourceId };
}

/** The source type and ID of a document ID, or null when the ID is malformed. */
export function documentKeyFromId(id: string): DocumentKey | null {
  const separator = id.indexOf(':');
  if (separator < 0) return null;
  const sourceType = id.slice(0, separator);
  const sourceId = id.slice(separator + 1);
  if (!isSourceType(sourceType) || !isSourceId(sourceType, sourceId)) return null;
  return { sourceType, sourceId };
}

export function documentIdFromPath(relative: string): string | null {
  const key = documentKeyFromPath(relative);
  return key ? documentId(key) : null;
}

export function documentPathFromId(id: string): string | null {
  const key = documentKeyFromId(id);
  return key ? documentPath(key) : null;
}
