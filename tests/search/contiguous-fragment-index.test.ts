import { describe, expect, it } from 'vitest';
import type { SavedDocument } from '../../src/core/types.js';
import { ContiguousFragmentIndex } from '../../src/search/contiguous-fragment-index.js';

function document(id: string, title: string, publisher: string, body: string): SavedDocument {
  return {
    id: `youtube:${id}`, type: 'Transcript', sourceType: 'youtube', sourceId: id,
    sourceUrl: `https://example.com/${id}`, title, publisher: { id: 'publisher', name: publisher },
    publishedAt: '2026-10-01T00:00:00.000Z', collectedAt: '2026-10-02T00:00:00.000Z',
    youtube: { languageCode: 'zh-Hant', languageName: '繁體中文', subtitleKind: 'manual' }, bodyMarkdown: body,
  };
}

describe('ContiguousFragmentIndex', () => {
  it('requires each group inside one field while allowing groups at separate positions', () => {
    const exact = document('exact', '半導體與觀光產業', '頻道', '個股現金流量');
    const scattered = document('scattered', '半年展望', '導師頻道', '直觀地賣光股票');
    const crossField = document('crossfield', '半', '導', '體');
    const index = ContiguousFragmentIndex.fromDocuments([exact, scattered, crossField]);
    expect(index.eligibleIds(['半導'], {}, new Set())).toEqual([exact.id]);
    expect(index.eligibleIds(['導體'], {}, new Set())).toEqual([exact.id]);
    expect(index.eligibleIds(['觀光', '產業'], {}, new Set())).toEqual([exact.id]);
    expect(index.eligibleIds(['股'], {}, new Set())).toEqual([exact.id, scattered.id]);
    expect(index.eligibleIds(['半導體'], {}, new Set())).toEqual([exact.id]);
  });

  it('updates and deletes the derived postings without resurrecting stale documents', () => {
    const first = document('first', '舊標題', '頻道', '半導體');
    const index = ContiguousFragmentIndex.fromDocuments([first]);
    expect(index.eligibleIds(['導體'], {}, new Set())).toEqual([first.id]);
    index.upsert({ ...first, bodyMarkdown: '觀光' });
    expect(index.eligibleIds(['導體'], {}, new Set())).toEqual([]);
    expect(index.eligibleIds(['觀光'], {}, new Set())).toEqual([first.id]);
    index.remove([first.id]);
    expect(index.eligibleIds(['觀光'], {}, new Set())).toEqual([]);
  });
});
