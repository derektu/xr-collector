// What the Documents page shows: the list's query, source and page kept in the URL, the typed
// query keeping a trailing space, the source menu with removed subscriptions marked, date and
// source tags, highlighted snippets, page numbers, Reader paths, and the page the list lands on
// after a deletion.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentMetadata } from '../../../../src/shared/documents/document-types.js';
import {
  listStateSearch,
  pageItems,
  parseListState,
  draftForQuery,
  publishedDate,
  readerIdForPath,
  pageWithRows,
  readerPath,
  sameSource,
  snippetParts,
  sourceFilter,
  sourceMenu,
  sourceOptions,
  sourceTag,
  sourceUrlOfDocumentId,
} from '../../../../src/transport/web/documents/document-presentation.js';
import { PRODUCT_DECLARATIONS } from '../../../support/product-sources.js';

describe('document presentation', () => {
  it('round-trips the list position through the URL', () => {
    const state = { query: '森林 觀測', source: { sourceType: 'youtube', publisherId: 'UC-a' }, status: 'draft' as const, page: 3 };
    expect(parseListState(listStateSearch(state))).toEqual(state);
    expect(listStateSearch(state)).toContain('source=youtube%3AUC-a');
    const typeOnly = { query: '', source: { sourceType: 'rss', publisherId: null }, status: null, page: 1 };
    expect(listStateSearch(typeOnly)).toBe('?source=rss');
    expect(parseListState('?source=rss')).toEqual(typeOnly);
    expect(listStateSearch({ query: '', source: null, status: null, page: 1 })).toBe('');
    expect(parseListState('?page=-2')).toEqual({ query: '', source: null, status: null, page: 1 });
    expect(parseListState('?status=trash').status).toBeNull();
  });

  it('keeps a trailing space typed before the debounced query lands', () => {
    // Typing "machine " and pausing writes "machine" to the URL; the box must keep the space.
    expect(draftForQuery('machine ', 'machine')).toBe('machine ');
    expect(draftForQuery('\u0085\u00a0　', '')).toBe('\u0085\u00a0　');
    expect(draftForQuery('machine ', 'learning')).toBe('learning');
    expect(draftForQuery('machine', '')).toBe('');
  });

  it('maps menu choices to stable ID filters', () => {
    expect(sourceFilter(null)).toEqual({});
    expect(sourceFilter({ sourceType: 'youtube', publisherId: null })).toEqual({ sourceType: 'youtube' });
    expect(sourceFilter({ sourceType: 'youtube', publisherId: 'UC-a' })).toEqual({ sourceType: 'youtube', publisherId: 'UC-a' });
    expect(sourceFilter({ sourceType: 'youtube', publisherId: 'none' })).toEqual({ sourceType: 'youtube', publisherId: 'none' });
  });

  it('compares source choices by value because each URL read builds a new choice', () => {
    expect(sameSource(parseListState('?source=youtube%3AUC-a').source, parseListState('?source=youtube%3AUC-a').source)).toBe(true);
    expect(sameSource({ sourceType: 'youtube', publisherId: null }, { sourceType: 'youtube', publisherId: 'UC-a' })).toBe(false);
    expect(sameSource(null, null)).toBe(true);
  });

  it('groups the channel menu and marks removed subscriptions only', () => {
    const publishers = [
      { id: 'UC-a', name: 'Channel A', count: 2, subscribed: true, removed: false },
      { id: 'UC-b', name: 'Channel B', count: 1, subscribed: false, removed: false },
      { id: 'UC-c', name: 'Channel C', count: 1, subscribed: false, removed: true },
      { id: null, name: 'Unknown', count: 1, subscribed: null, removed: false },
    ];
    const sources = { total: 4, groups: [{ sourceType: 'youtube', label: 'YouTube', count: 4, publishers }] };
    const menu = sourceMenu(sources);
    expect(menu.all).toEqual({ source: null, scope: 'all', count: 4 });
    const publisher = (publisherId: string) => ({ sourceType: 'youtube', publisherId });
    expect(menu.groups[0]!.entries).toEqual([
      { source: { sourceType: 'youtube', publisherId: null }, scope: 'type', typeLabel: 'YouTube', count: 4 },
      { source: publisher('UC-a'), scope: 'publisher', name: 'Channel A', removed: false, count: 2 },
      { source: publisher('UC-b'), scope: 'publisher', name: 'Channel B', removed: false, count: 1 },
      { source: publisher('UC-c'), scope: 'publisher', name: 'Channel C', removed: true, count: 1 },
      { source: publisher('none'), scope: 'publisher', name: 'Unknown', removed: false, count: 1 },
    ]);
    expect(sourceOptions(sources).groups[0]!.options.map((option) => option.value)).toEqual(['youtube', 'youtube:UC-a', 'youtube:UC-b', 'youtube:UC-c', 'youtube:none']);
    expect(sourceOptions(sources).all.value).toBe('');
    expect(sourceMenu(null)).toEqual({ all: { source: null, scope: 'all', count: 0 }, groups: [] });
  });

  it('labels missing or unreadable dates and the source of list rows', () => {
    expect(publishedDate(null)).toBeNull();
    expect(publishedDate('not a date')).toBeNull();
    expect(sourceTag(PRODUCT_DECLARATIONS, { sourceType: 'youtube', publisher: { id: 'UC-a', name: 'Channel A' } } as DocumentMetadata)).toBe('YouTube · Channel A');
  });

  it('keeps snippet markup as text so a search snippet never injects HTML', () => {
    expect(snippetParts('…before <mark>forest</mark> and <mark>survey</mark>…')).toEqual([
      { text: '…before ', match: false }, { text: 'forest', match: true }, { text: ' and ', match: false },
      { text: 'survey', match: true }, { text: '…', match: false },
    ]);
    expect(snippetParts('<script>x</script>')).toEqual([{ text: '<script>x</script>', match: false }]);
  });

  it('joins adjacent snippet matches into one highlight', () => {
    expect(snippetParts('…- point one: <mark>forest</mark><mark>survey</mark> before **notes** 28\\*28…')).toEqual([
      { text: '…- point one: ', match: false }, { text: 'forestsurvey', match: true }, { text: ' before notes 28*28…', match: false },
    ]);
  });

  it('numbers pages with gaps around the current page', () => {
    expect(pageItems(1, 3)).toEqual([1, 2, 3]);
    expect(pageItems(1, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageItems(5, 10)).toEqual([1, 'gap', 4, 5, 6, 'gap', 10]);
    expect(pageItems(1, 10)).toEqual([1, 2, 'gap', 10]);
    expect(pageItems(3, 10)).toEqual([1, 2, 3, 4, 'gap', 10]);
  });

  it('encodes document IDs in Reader paths', () => {
    expect(readerPath('youtube:abc')).toBe('/documents/youtube%3Aabc');
    expect(readerIdForPath('/documents/youtube%3Aabc')).toBe('youtube:abc');
    expect(readerIdForPath('/documents')).toBeNull();
  });
});

describe('published dates', () => {
  const timeZone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'America/Los_Angeles'; });
  afterEach(() => { process.env.TZ = timeZone; });

  it('keeps a date-only value as recorded because Date parses date-only strings as UTC midnight', () => {
    expect(publishedDate('2026-09-01')).toBe('2026-09-01');
  });

  it("shows a timestamp in the viewer's local date", () => {
    expect(publishedDate('2026-09-01T03:00:00Z')).toBe('2026-08-31');
  });
});

describe('document deletion presentation (A8)', () => {
  it('moves the list to the last page with rows when the current page empties after a deletion', () => {
    expect(pageWithRows(3, 0, 40)).toBe(2);
    expect(pageWithRows(5, 0, 25)).toBe(2);
    expect(pageWithRows(3, 4, 44)).toBe(3);
    expect(pageWithRows(1, 0, 0)).toBe(1);
    expect(pageWithRows(2, 0, 0)).toBe(1);
  });

  it('collects a deleted document again from the address its ID encodes', () => {
    expect(sourceUrlOfDocumentId(PRODUCT_DECLARATIONS, 'youtube:dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(sourceUrlOfDocumentId(PRODUCT_DECLARATIONS, 'youtube:bad')).toBeNull();
  });
});
