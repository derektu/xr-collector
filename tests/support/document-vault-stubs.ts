import type { DeletionRecords, DocumentVault } from '../../src/shared/documents/document-vault.js';

export async function unusedVaultWrite(): Promise<never> {
  throw new Error('this test does not change documents');
}

export const NO_DELETIONS: DeletionRecords = {
  get: async () => null,
  record: unusedVaultWrite,
  clear: unusedVaultWrite,
};

export function withoutDocumentChanges(
  now: () => Date = () => new Date(),
): Pick<DocumentVault, 'remove' | 'writeStatus' | 'deletions' | 'now'> {
  return { remove: unusedVaultWrite, writeStatus: unusedVaultWrite, deletions: NO_DELETIONS, now };
}
