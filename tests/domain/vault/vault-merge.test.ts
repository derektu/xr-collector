// Broken, an import preview counts removals wrong, or a merge leaves a deleted document's file in place.
import { describe, expect, it } from 'vitest';
import type { DeletionRecord } from '../../../src/shared/documents/document-types.js';
import type { ChangeCounts } from '../../../src/shared/vault/vault-types.js';
import { DELETIONS_FILE, deletionsToJson } from '../../../src/domain/vault/deleted-documents.js';
import { compareItems, planChanges, type FileSource, type ItemState, type ItemStates } from '../../../src/domain/vault/vault-merge.js';
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

const present = (digest: string, at: string): ItemState => ({ state: 'present', digest, at });
const deleted = (at: string): ItemState => ({ state: 'deleted', digest: null, at });
const counts = (documents: Partial<Record<'added' | 'updated' | 'removed', number>>, subscriptions: Partial<Record<'added' | 'updated' | 'removed', number>> = {}) => ({
  documents: { added: 0, updated: 0, removed: 0, ...documents }, subscriptions: { added: 0, updated: 0, removed: 0, ...subscriptions },
});
const EARLY = '2030-01-01T00:00:00.000Z';
const LATE = '2030-01-02T00:00:00.000Z';

interface CountRule { name: string; local: [string, ItemState][]; incoming: [string, ItemState][]; merge: ChangeCounts; replace: ChangeCounts }

describe('compareItems', () => {
  it.each<CountRule>([
    {
      name: 'a deletion record of a document this Vault never had counts as a document removal, so the person sees it will be written',
      local: [], incoming: [['document:youtube:x', deleted(LATE)]],
      merge: counts({ removed: 1 }), replace: counts({ removed: 1 }),
    },
    {
      name: 'a removal record of a subscription this Vault never had counts as a subscription removal',
      local: [], incoming: [['subscription:youtube:UCX', deleted(LATE)]],
      merge: counts({}, { removed: 1 }), replace: counts({}, { removed: 1 }),
    },
    {
      name: 'a newer deletion record of a document this Vault also deleted counts as a removal',
      local: [['document:youtube:x', deleted(EARLY)]], incoming: [['document:youtube:x', deleted(LATE)]],
      merge: counts({ removed: 1 }), replace: counts({ removed: 1 }),
    },
    {
      name: 'records add to real deletions in one removal figure',
      local: [['document:youtube:a', present('a', EARLY)]],
      incoming: [['document:youtube:a', deleted(LATE)], ['document:youtube:x', deleted(LATE)]],
      merge: counts({ removed: 2 }), replace: counts({ removed: 2 }),
    },
    {
      name: 'replacing with a records-only Vault counts each record as a removal, since replace writes the records too',
      local: [['document:youtube:a', present('a', EARLY)]],
      incoming: [['document:youtube:x', deleted(LATE)], ['document:youtube:y', deleted(LATE)], ['subscription:youtube:UCX', deleted(LATE)]],
      merge: counts({ removed: 2 }, { removed: 1 }), replace: counts({ removed: 3 }, { removed: 1 }),
    },
    {
      name: 'identical Vaults have nothing to count',
      local: [['document:youtube:a', present('a', EARLY)], ['document:youtube:x', deleted(EARLY)]],
      incoming: [['document:youtube:a', present('a', EARLY)], ['document:youtube:x', deleted(EARLY)]],
      merge: counts({}), replace: counts({}),
    },
  ])(
    '$name', ({ local, incoming, merge, replace }) => {
      const comparison = compareItems(new Map(local), new Map(incoming));

      expect(comparison.merge).toEqual(merge);
      expect(comparison.replace).toEqual(replace);
    },
  );
});
