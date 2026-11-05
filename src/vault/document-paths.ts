import type { SourceDeclarations } from '../core/source-registry.js';
import { documentId } from '../core/document-id.js';
import type { DocumentKey, DocumentSourceType } from '../core/document-types.js';

/**
 * Where documents live in a Vault and how a document ID maps to its file. A document ID is
 * `<source type>:<source ID>` and its file is `documents/<source type>/<source ID>.md`, relative to
 * the Vault root with `/` separators. Each source type of `sources` declares which source IDs it
 * accepts, so a path or ID of a type `sources` lacks, or a malformed source ID, is never a
 * document.
 */

export function isSourceType(sources: SourceDeclarations, value: string): value is DocumentSourceType {
  return sources.get(value) !== undefined;
}

export function isSourceId(sources: SourceDeclarations, sourceType: DocumentSourceType, sourceId: string): boolean {
  return sources.get(sourceType)?.item.keyPattern.test(sourceId) ?? false;
}

export function documentPath(key: DocumentKey): string {
  return `documents/${key.sourceType}/${key.sourceId}.md`;
}

/** The source type and ID of a document file path, or null when the path is not a document. */
export function documentKeyFromPath(sources: SourceDeclarations, relative: string): DocumentKey | null {
  const match = /^documents\/([^/]+)\/([^/]+)\.md$/u.exec(relative);
  if (!match) return null;
  const [, sourceType = '', sourceId = ''] = match;
  if (!isSourceType(sources, sourceType) || !isSourceId(sources, sourceType, sourceId)) return null;
  return { sourceType, sourceId };
}

/** The source type and ID of a document ID, or null when the ID is malformed. */
export function documentKeyFromId(sources: SourceDeclarations, id: string): DocumentKey | null {
  const separator = id.indexOf(':');
  if (separator < 0) return null;
  const sourceType = id.slice(0, separator);
  const sourceId = id.slice(separator + 1);
  if (!isSourceType(sources, sourceType) || !isSourceId(sources, sourceType, sourceId)) return null;
  return { sourceType, sourceId };
}

export function documentIdFromPath(sources: SourceDeclarations, relative: string): string | null {
  const key = documentKeyFromPath(sources, relative);
  return key ? documentId(key) : null;
}

export function documentPathFromId(sources: SourceDeclarations, id: string): string | null {
  const key = documentKeyFromId(sources, id);
  return key ? documentPath(key) : null;
}
