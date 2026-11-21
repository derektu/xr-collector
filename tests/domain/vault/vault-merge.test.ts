import { describe, expect, it } from 'vitest';
import type { DeletionRecord } from '../../../src/shared/documents/document-types.js';
import { DELETIONS_FILE, deletionsToJson } from '../../../src/domain/vault/deleted-documents.js';
import { planChanges, type FileSource, type ItemStates } from '../../../src/domain/vault/vault-merge.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';

function source(files: Record<string, Buffer>): FileSource {
  return {
    paths: () => Object.keys(files),
    has: (file) => file in files,
    read: async (file) => files[file] ?? Promise.reject(new Error(`Missing file: ${file}`)),
  };
}

const deletions = (record: DeletionRecord) => Buffer.from(JSON.stringify(deletionsToJson([record])));

describe('planChanges', () => {
  it('removes a document file a deletion hides even though the local side does not list it, since hidden files are not registered', async () => {
    const record: DeletionRecord = {
      sourceType: 'youtube', sourceId: 'gone0000001', sourceUrl: 'https://www.youtube.com/watch?v=gone0000001',
      title: '已刪除', publisherId: 'UC123', publisherName: '測試頻道', deletedAt: '2026-10-01T00:00:00.000Z',
    };
    const local = source({ [DELETIONS_FILE]: deletions(record) });
    const incoming = source({ [DELETIONS_FILE]: deletions({ ...record, deletedAt: '2026-10-02T00:00:00.000Z' }) });
    const localStates: ItemStates = new Map([['document:youtube:gone0000001', { state: 'deleted', digest: null, at: record.deletedAt }]]);

    const plan = await planChanges(PRODUCT_SOURCES, local, incoming, ['document:youtube:gone0000001'], localStates);

    expect(local.has('documents/youtube/gone0000001.md')).toBe(false);
    expect(plan.changes.get('documents/youtube/gone0000001.md')).toBeNull();
    expect(plan.displaced).toEqual([]);
  });
});
