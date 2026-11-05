// What the Documents page shows: the list's query, source and page kept in the URL, the typed
// query keeping a trailing space, the source menu with removed subscriptions marked, date and
// source tags, highlighted snippets, page numbers, Reader paths, and the page the list lands on
// after a deletion.
import { describe, expect, it } from 'vitest';
import type { DocumentMetadata } from '../../src/core/document-types.js';
import {
  listStateSearch,
  pageItems,
  parseListState,
  draftForQuery,
  publishedDate,
  readerIdForPath,
  readerPath,
  snippetParts,
  sourceFilter,
  sourceMenu,
  sourceTag,
} from '../../src/web/document-presentation.js';
import { PRODUCT_DECLARATIONS } from '../support/product-sources.js';

describe('document presentation', () => {
  it('round-trips the list position through the URL', () => {
    const state = { query: '森林 觀測', source: 'youtube:UC-a', page: 3 };
    expect(parseListState(listStateSearch(state))).toEqual(state);
    expect(listStateSearch({ query: '', source: '', page: 1 })).toBe('');
    expect(parseListState('?page=-2')).toEqual({ query: '', source: '', page: 1 });
  });

  it('keeps a trailing space typed before the debounced query lands', () => {
    // Typing "machine " and pausing writes "machine" to the URL; the box must keep the space.
    expect(draftForQuery('machine ', 'machine')).toBe('machine ');
    expect(draftForQuery('\u0085\u00a0　', '')).toBe('\u0085\u00a0　');
    expect(draftForQuery('machine ', 'learning')).toBe('learning');
    expect(draftForQuery('machine', '')).toBe('');
  });

  it('maps menu values to stable ID filters', () => {
    expect(sourceFilter('')).toEqual({});
    expect(sourceFilter('youtube')).toEqual({ sourceType: 'youtube' });
    expect(sourceFilter('youtube:UC-a')).toEqual({ sourceType: 'youtube', publisherId: 'UC-a' });
    expect(sourceFilter('youtube:none')).toEqual({ sourceType: 'youtube', publisherId: 'none' });
  });

  it('groups the channel menu and marks removed subscriptions only', () => {
    const publishers = [
      { id: 'UC-a', name: 'Channel A', count: 2, subscribed: true, removed: false },
      { id: 'UC-b', name: 'Channel B', count: 1, subscribed: false, removed: false },
      { id: 'UC-c', name: 'Channel C', count: 1, subscribed: false, removed: true },
      { id: null, name: 'Unknown', count: 1, subscribed: null, removed: false },
    ];
    const menu = sourceMenu({ total: 4, groups: [{ sourceType: 'youtube', label: 'YouTube', count: 4, publishers }] });
    expect(menu.all).toEqual({ value: '', scope: 'all', count: 4 });
    expect(menu.groups[0]!.entries).toEqual([
      { value: 'youtube', scope: 'type', typeLabel: 'YouTube', count: 4 },
      { value: 'youtube:UC-a', scope: 'publisher', name: 'Channel A', removed: false, count: 2 },
      { value: 'youtube:UC-b', scope: 'publisher', name: 'Channel B', removed: false, count: 1 },
      { value: 'youtube:UC-c', scope: 'publisher', name: 'Channel C', removed: true, count: 1 },
      { value: 'youtube:none', scope: 'publisher', name: 'Unknown', removed: false, count: 1 },
    ]);
    expect(sourceMenu(null)).toEqual({ all: { value: '', scope: 'all', count: 0 }, groups: [] });
  });

  it('labels dates, sources and highlighted snippets for list rows', () => {
    expect(publishedDate(null)).toBeNull();
    expect(publishedDate('2026-09-01')).toBe('2026-09-01');
    expect(publishedDate('not a date')).toBeNull();
    expect(sourceTag(PRODUCT_DECLARATIONS, { sourceType: 'youtube', publisher: { id: 'UC-a', name: 'Channel A' } } as DocumentMetadata)).toBe('YouTube · Channel A');
    expect(snippetParts('…before <mark>forest</mark> and <mark>survey</mark>…')).toEqual([
      { text: '…before ', match: false }, { text: 'forest', match: true }, { text: ' and ', match: false },
      { text: 'survey', match: true }, { text: '…', match: false },
    ]);
    expect(snippetParts('<script>x</script>')).toEqual([{ text: '<script>x</script>', match: false }]);
    expect(snippetParts('…- point one: <mark>forest</mark><mark>survey</mark> before **notes** 28\\*28…')).toEqual([
      { text: '…- point one: ', match: false }, { text: 'forestsurvey', match: true }, { text: ' before notes 28*28…', match: false },
    ]);
  });

  it('numbers pages with gaps around the current page', () => {
    expect(pageItems(1, 3)).toEqual([1, 2, 3]);
    expect(pageItems(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageItems(1, 10)).toEqual([1, 2, null, 10]);
  });

  it('encodes document IDs in Reader paths', () => {
    expect(readerPath('youtube:abc')).toBe('/documents/youtube%3Aabc');
    expect(readerIdForPath('/documents/youtube%3Aabc')).toBe('youtube:abc');
    expect(readerIdForPath('/documents')).toBeNull();
  });
});

describe('document deletion presentation (A8)', () => {
  it('states where the list goes and how to collect again', async () => {
    const { pageWithRows, sourceUrlOfDocumentId } = await import('../../src/web/document-presentation.js');
    expect(pageWithRows(3, 0, 40)).toBe(2);
    expect(pageWithRows(5, 0, 25)).toBe(2);
    expect(pageWithRows(3, 4, 44)).toBe(3);
    expect(pageWithRows(1, 0, 0)).toBe(1);
    expect(pageWithRows(2, 0, 0)).toBe(1);
    expect(sourceUrlOfDocumentId(PRODUCT_DECLARATIONS, 'youtube:dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(sourceUrlOfDocumentId(PRODUCT_DECLARATIONS, 'youtube:bad')).toBeNull();
  });
});
