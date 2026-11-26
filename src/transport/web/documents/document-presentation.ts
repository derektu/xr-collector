import { markdownToPlainText } from '../../../shared/documents/document-text.js';
import { trimSearchQueryWhitespace } from '../../../shared/api/search-query.js';
import type { SourceDeclarations } from '../../../shared/sources/source-registry.js';
import type { DocumentFilter, DocumentMetadata, DocumentSources, DocumentSourceType, DocumentStatus, DocumentStatusCounts } from '../../../shared/documents/document-types.js';
import { parseDocumentStatus } from '../../../shared/documents/document-status.js';

export const DOCUMENTS_PAGE_SIZE = 20;
export const SEARCH_DEBOUNCE_MS = 300;

export interface DocumentSourceChoice {
  sourceType: DocumentSourceType;
  publisherId: string | null;
}

export interface DocumentListState {
  query: string;
  source: DocumentSourceChoice | null;
  status: DocumentStatus | null;
  page: number;
}

export function parseListState(search: string): DocumentListState {
  const parameters = new URLSearchParams(search);
  const page = Number.parseInt(parameters.get('page') ?? '1', 10);
  return {
    query: parameters.get('q') ?? '',
    source: parseSourceParam(parameters.get('source') ?? ''),
    status: parseDocumentStatus(parameters.get('status')),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function listStateSearch(state: DocumentListState): string {
  const parameters = new URLSearchParams();
  if (state.query) parameters.set('q', state.query);
  if (state.source) parameters.set('source', sourceParam(state.source));
  if (state.status) parameters.set('status', state.status);
  if (state.page > 1) parameters.set('page', String(state.page));
  const text = parameters.toString();
  return text ? `?${text}` : '';
}

export function draftForQuery(draft: string, query: string): string {
  return trimSearchQueryWhitespace(draft) === query ? draft : query;
}

export function sourceParam(source: DocumentSourceChoice | null): string {
  if (!source) return '';
  return source.publisherId === null ? source.sourceType : `${source.sourceType}:${source.publisherId}`;
}

export function parseSourceParam(text: string): DocumentSourceChoice | null {
  if (!text) return null;
  const separator = text.indexOf(':');
  if (separator < 0) return { sourceType: text, publisherId: null };
  return { sourceType: text.slice(0, separator), publisherId: text.slice(separator + 1) };
}

export function sameSource(left: DocumentSourceChoice | null, right: DocumentSourceChoice | null): boolean {
  return sourceParam(left) === sourceParam(right);
}

export function sourceFilter(source: DocumentSourceChoice | null): DocumentFilter {
  if (!source) return {};
  return source.publisherId === null ? { sourceType: source.sourceType } : { sourceType: source.sourceType, publisherId: source.publisherId };
}

export const STATUS_FILTERS: ReadonlyArray<{ status: DocumentStatus | null; label: string }> = [
  { status: null, label: '全部' },
  { status: 'published', label: '正式' },
  { status: 'draft', label: '草稿' },
];

export function statusFilterCount(counts: DocumentStatusCounts, status: DocumentStatus | null): number {
  return status ? counts[status] : counts.draft + counts.published;
}

export interface SourceOption {
  value: string;
  label: string;
}

export interface SourceOptionGroup {
  label: string;
  options: SourceOption[];
}

export type SourceMenuEntry =
  | { source: null; scope: 'all'; count: number }
  | { source: DocumentSourceChoice; scope: 'type'; typeLabel: string; count: number }
  | { source: DocumentSourceChoice; scope: 'publisher'; name: string; removed: boolean; count: number };

export function sourceMenu(sources: DocumentSources | null): { all: SourceMenuEntry; groups: Array<{ label: string; entries: SourceMenuEntry[] }> } {
  return {
    all: { source: null, scope: 'all', count: sources?.total ?? 0 },
    groups: (sources?.groups ?? []).map((group) => ({
      label: group.label,
      entries: [
        { source: { sourceType: group.sourceType, publisherId: null }, scope: 'type', typeLabel: group.label, count: group.count },
        ...group.publishers.map((publisher): SourceMenuEntry => ({
          source: { sourceType: group.sourceType, publisherId: publisher.id ?? 'none' }, scope: 'publisher', name: publisher.name, removed: publisher.removed, count: publisher.count,
        })),
      ],
    })),
  };
}

function sourceMenuText(entry: SourceMenuEntry): string {
  switch (entry.scope) {
    case 'all': return `全部（${entry.count}）`;
    case 'type': return `${entry.typeLabel}・全部（${entry.count}）`;
    case 'publisher': return `${entry.name}${entry.removed ? '・已移除' : ''}（${entry.count}）`;
  }
}

export function sourceOptions(sources: DocumentSources | null): { all: SourceOption; groups: SourceOptionGroup[] } {
  const menu = sourceMenu(sources);
  const option = (entry: SourceMenuEntry) => ({ value: sourceParam(entry.source), label: sourceMenuText(entry) });
  return { all: option(menu.all), groups: menu.groups.map((group) => ({ label: group.label, options: group.entries.map(option) })) };
}

export function sourceTag(declarations: SourceDeclarations, document: DocumentMetadata): string {
  return `${declarations.get(document.sourceType)?.label ?? document.sourceType} · ${document.publisher.name}`;
}

export function publishedDate(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(publishedAt)) return publishedAt;
  const date = new Date(publishedAt);
  return Number.isNaN(date.getTime()) ? null : localDate(date);
}

export function publishedLabel(publishedAt: string | null): string {
  const date = publishedDate(publishedAt);
  return date ? `發布 ${date}` : '發布日期未知';
}

export function collectedShortLabel(collectedAt: string): string {
  return `收集 ${localDate(new Date(collectedAt)).slice(5)}`;
}

export function collectedLabel(collectedAt: string): string {
  const date = new Date(collectedAt);
  return `收集 ${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateTimeLabel(value: string): string {
  const date = new Date(value);
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function subtitleLabel(declarations: SourceDeclarations, document: DocumentMetadata): string | null {
  return declarations.get(document.sourceType)?.documentDetailLine?.(document) ?? null;
}

export interface SnippetPart {
  text: string;
  match: boolean;
}

export function snippetParts(raw: string): SnippetPart[] {
  const snippet = markdownToPlainText(raw.replaceAll('</mark><mark>', ''));
  const parts: SnippetPart[] = [];
  const pattern = /<mark>([\s\S]*?)<\/mark>/gu;
  let last = 0;
  for (const match of snippet.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: snippet.slice(last, match.index), match: false });
    parts.push({ text: match[1] ?? '', match: true });
    last = match.index + match[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts.filter((part) => part.text !== '');
}

export type PageItem = number | 'gap';

export const MAX_PAGES_WITHOUT_GAPS = 7;

export function pageItems(current: number, totalPages: number): PageItem[] {
  if (totalPages <= MAX_PAGES_WITHOUT_GAPS) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, current - 1, current, current + 1].filter((page) => page >= 1 && page <= totalPages));
  const items: PageItem[] = [];
  let previous: number | null = null;
  for (const page of [...pages].sort((left, right) => left - right)) {
    if (previous !== null && page - previous > 1) items.push('gap');
    items.push(page);
    previous = page;
  }
  return items;
}

export function totalPages(total: number): number {
  return Math.max(1, Math.ceil(total / DOCUMENTS_PAGE_SIZE));
}

export function readerPath(id: string): string {
  return `/documents/${encodeURIComponent(id)}`;
}

export function readerIdForPath(pathname: string): string | null {
  const match = /^\/documents\/([^/]+)\/?$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function pageWithRows(page: number, rowsOnPage: number, total: number): number {
  return rowsOnPage === 0 && page > 1 ? Math.min(page - 1, totalPages(total)) : page;
}

export function sourceUrlOfDocumentId(declarations: SourceDeclarations, id: string): string | null {
  const separator = id.indexOf(':');
  if (separator < 0) return null;
  const item = declarations.get(id.slice(0, separator))?.item;
  const key = id.slice(separator + 1);
  return item?.urlForKey && item.keyPattern.test(key) ? item.urlForKey(key) : null;
}
