import { markdownToPlainText } from '../core/document-text.js';
import type { DocumentFilter, DocumentMetadata, DocumentSources } from '../core/types.js';

export const DOCUMENTS_PAGE_SIZE = 20;
export const SEARCH_DEBOUNCE_MS = 300;

/** Browse/search position that the documents URL carries, so returning or reloading restores it. */
export interface DocumentListState {
  query: string;
  /** '' for all sources, `<sourceType>` for one type, `<sourceType>:<publisherId>` for one publisher. */
  source: string;
  page: number;
}

export function parseListState(search: string): DocumentListState {
  const parameters = new URLSearchParams(search);
  const page = Number.parseInt(parameters.get('page') ?? '1', 10);
  return {
    query: parameters.get('q') ?? '',
    source: parameters.get('source') ?? '',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function listStateSearch(state: DocumentListState): string {
  const parameters = new URLSearchParams();
  if (state.query) parameters.set('q', state.query);
  if (state.source) parameters.set('source', state.source);
  if (state.page > 1) parameters.set('page', String(state.page));
  const text = parameters.toString();
  return text ? `?${text}` : '';
}

/**
 * The search box text after the URL query changes. A draft whose trimmed text already is the query
 * stays as typed, so a pause after a trailing space does not strip it mid-typing; any other query
 * (back, reload, clear) replaces the draft.
 */
export function draftForQuery(draft: string, query: string): string {
  return draft.trim() === query ? draft : query;
}

export function sourceFilter(source: string): DocumentFilter {
  if (!source) return {};
  const separator = source.indexOf(':');
  if (separator < 0) return { sourceType: source as DocumentFilter['sourceType'] };
  return { sourceType: source.slice(0, separator) as DocumentFilter['sourceType'], publisherId: source.slice(separator + 1) };
}

export interface SourceOption {
  value: string;
  label: string;
}

export interface SourceOptionGroup {
  label: string;
  options: SourceOption[];
}

/**
 * One grouped menu: every channel, then per source type its own "all" entry followed by its
 * publishers. A publisher whose subscription was removed is marked; one only added item by item is not.
 */
export function sourceOptions(sources: DocumentSources | null): { all: SourceOption; groups: SourceOptionGroup[] } {
  const all = { value: '', label: `全部頻道（${sources?.total ?? 0}）` };
  const groups = (sources?.groups ?? []).map((group) => ({
    label: group.label,
    options: [
      { value: group.sourceType, label: `${group.label}・全部（${group.count}）` },
      ...group.publishers.map((publisher) => ({
        value: `${group.sourceType}:${publisher.id ?? 'none'}`,
        label: `${publisher.name}${publisher.removed ? '・已移除' : ''}（${publisher.count}）`,
      })),
    ],
  }));
  return { all, groups };
}

const SOURCE_LABELS: Record<DocumentMetadata['sourceType'], string> = { youtube: 'YouTube' };

export function sourceTag(document: DocumentMetadata): string {
  return `${SOURCE_LABELS[document.sourceType]} · ${document.publisher.name}`;
}

/** Date-only values are shown as recorded; timestamps use the viewer's local date. */
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

export function subtitleLabel(document: DocumentMetadata): string | null {
  if (!document.youtube) return null;
  const language = document.youtube.languageName ?? document.youtube.languageCode;
  return `字幕：${language}・${document.youtube.subtitleKind === 'manual' ? '人工字幕' : '自動字幕'}`;
}

export interface SnippetPart {
  text: string;
  match: boolean;
}

/**
 * Splits a search snippet on its `<mark>` markers after reducing its Markdown to plain text;
 * everything stays text, nothing becomes HTML. Adjacent matches join into one highlight.
 */
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

/** Page numbers to show, with `null` for a gap, always including the first, last and neighbours of the current page. */
export function pageItems(current: number, totalPages: number): Array<number | null> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, current - 1, current, current + 1].filter((page) => page >= 1 && page <= totalPages));
  const sorted = [...pages].sort((left, right) => left - right);
  const items: Array<number | null> = [];
  for (const [index, page] of sorted.entries()) {
    if (index > 0 && page - sorted[index - 1]! > 1) items.push(null);
    items.push(page);
  }
  return items;
}

export function totalPages(total: number): number {
  return Math.max(1, Math.ceil(total / DOCUMENTS_PAGE_SIZE));
}

/** Path of the Reader for one document; IDs are encoded because they contain `:`. */
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

/**
 * The page a loaded list should show: the same page while it has rows, otherwise the last page that
 * has any, such as after the last document of a page was deleted here or from the Reader.
 */
export function pageWithRows(page: number, rowsOnPage: number, total: number): number {
  return rowsOnPage === 0 && page > 1 ? Math.min(page - 1, totalPages(total)) : page;
}

/** The source address of a document ID, for collecting a deleted document again; null for an unknown ID. */
export function sourceUrlOfDocumentId(id: string): string | null {
  const videoId = /^youtube:([A-Za-z0-9_-]{11})$/u.exec(id)?.[1];
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
}
