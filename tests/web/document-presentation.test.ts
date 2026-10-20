import { describe, expect, it } from 'vitest';
import type { DocumentMetadata } from '../../src/core/types.js';
import {
  listStateSearch,
  pageItems,
  parseListState,
  draftForQuery,
  publishedLabel,
  readerIdForPath,
  readerPath,
  snippetParts,
  sourceFilter,
  sourceOptions,
  sourceTag,
} from '../../src/web/document-presentation.js';

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
    const menu = sourceOptions({
      total: 4,
      groups: [{
        sourceType: 'youtube', label: 'YouTube', count: 4, publishers: [
          { id: 'UC-a', name: '頻道 A', count: 2, subscribed: true, removed: false },
          { id: 'UC-b', name: '頻道 B', count: 1, subscribed: false, removed: false },
          { id: 'UC-c', name: '頻道 C', count: 1, subscribed: false, removed: true },
          { id: null, name: '未知頻道', count: 1, subscribed: null, removed: false },
        ],
      }],
    });
    expect(menu.all).toEqual({ value: '', label: '全部頻道（4）' });
    expect(menu.groups[0]!.options).toEqual([
      { value: 'youtube', label: 'YouTube・全部（4）' },
      { value: 'youtube:UC-a', label: '頻道 A（2）' },
      { value: 'youtube:UC-b', label: '頻道 B（1）' },
      { value: 'youtube:UC-c', label: '頻道 C・已移除（1）' },
      { value: 'youtube:none', label: '未知頻道（1）' },
    ]);
  });

  it('labels dates, sources and highlighted snippets for list rows', () => {
    expect(publishedLabel(null)).toBe('發布日期未知');
    expect(publishedLabel('2026-09-01')).toBe('發布 2026-09-01');
    expect(sourceTag({ sourceType: 'youtube', publisher: { id: 'UC-a', name: '頻道 A' } } as DocumentMetadata)).toBe('YouTube · 頻道 A');
    expect(snippetParts('…前<mark>森林</mark>中<mark>觀測</mark>…')).toEqual([
      { text: '…前', match: false }, { text: '森林', match: true }, { text: '中', match: false },
      { text: '觀測', match: true }, { text: '…', match: false },
    ]);
    expect(snippetParts('<script>x</script>')).toEqual([{ text: '<script>x</script>', match: false }]);
    expect(snippetParts('…- 第一點：<mark>森林</mark><mark>觀測</mark>前 **記錄** 28\\*28…')).toEqual([
      { text: '…- 第一點：', match: false }, { text: '森林觀測', match: true }, { text: '前 記錄 28*28…', match: false },
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
    const { skipReasonLabel } = await import('../../src/web/job-presentation.js');
    expect(pageWithRows(3, 0, 40)).toBe(2);
    expect(pageWithRows(5, 0, 25)).toBe(2);
    expect(pageWithRows(3, 4, 44)).toBe(3);
    expect(pageWithRows(1, 0, 0)).toBe(1);
    expect(pageWithRows(2, 0, 0)).toBe(1);
    expect(sourceUrlOfDocumentId('youtube:dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(sourceUrlOfDocumentId('youtube:bad')).toBeNull();
    expect(skipReasonLabel('deleted')).toBe('文件已刪除');
  });
});
