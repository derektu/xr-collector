import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import { documentId } from '../../shared/documents/document-id.js';
import type { DocumentKey, DocumentSourceType } from '../../shared/documents/document-types.js';

export function isSourceType(sources: SourceDeclarations, value: string): value is DocumentSourceType {
  return sources.get(value) !== undefined;
}

export function isSourceId(sources: SourceDeclarations, sourceType: DocumentSourceType, sourceId: string): boolean {
  return sources.get(sourceType)?.item.keyPattern.test(sourceId) ?? false;
}

export function documentPath(key: DocumentKey): string {
  return `documents/${key.sourceType}/${key.sourceId}.md`;
}

export function documentKeyFromPath(sources: SourceDeclarations, relative: string): DocumentKey | null {
  const match = /^documents\/([^/]+)\/([^/]+)\.md$/u.exec(relative);
  if (!match) return null;
  const [, sourceType = '', sourceId = ''] = match;
  if (!isSourceType(sources, sourceType) || !isSourceId(sources, sourceType, sourceId)) return null;
  return { sourceType, sourceId };
}

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
