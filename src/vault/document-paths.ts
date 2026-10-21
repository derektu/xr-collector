import { sourceDeclaration } from '../core/source-registry.js';
import type { DocumentSourceType } from '../core/types.js';

/**
 * Where documents live in a Vault and how a document ID maps to its file. A document ID is
 * `<source type>:<source ID>` and its file is `documents/<source type>/<source ID>.md`, relative to
 * the Vault root with `/` separators. Each registered source type declares which source IDs it
 * accepts, so a path or ID of an unregistered source type, or a malformed source ID, is never a
 * document.
 */

export interface DocumentKey {
  sourceType: DocumentSourceType;
  sourceId: string;
}

export function isSourceType(value: string): value is DocumentSourceType {
  return sourceDeclaration(value) !== undefined;
}

export function isSourceId(sourceType: DocumentSourceType, sourceId: string): boolean {
  return sourceDeclaration(sourceType)?.item.keyPattern.test(sourceId) ?? false;
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
