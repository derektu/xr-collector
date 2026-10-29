// The documents a run holds, read from each source of `instance.state()` on its own: the API list,
// the Vault files and the search index. A flow compares the three to prove a write reached the data,
// not only the API that the ticket may have changed.

/** Meilisearch keys are the document IDs in base64url. */
const fromIndexKey = (key) => Buffer.from(key, 'base64url').toString('utf8');

/** The sorted document IDs of the API list. */
export const apiIds = (state) => (state.api.documents?.documents ?? []).map((document) => document.id).sort();

/** The sorted document IDs of the Vault's Markdown files. */
export const vaultIds = (state) => (state.vault.documents ?? []).map((document) => document.frontmatter?.collector?.id).filter(Boolean).sort();

/** The sorted document IDs of the search index; null when the index cannot be read. */
export const indexIds = (state) => {
  const index = state.index.indexes?.find((entry) => ['documents_v3', 'documents_v2'].includes(entry.uid));
  return index ? index.keys.map(fromIndexKey).sort() : null;
};

/** The `sourceType:sourceId` of every deletion record in the Vault; null when the file is missing. */
export const deletedIds = (state) => state.vault.files?.['settings/deleted-documents.json']?.deleted
  ?.map((entry) => `${entry.sourceType}:${entry.sourceId}`).sort() ?? null;

/** Whether two sorted ID lists are the same; a null list (unreadable) never is. */
export const sameIds = (actual, expected) => actual !== null && JSON.stringify(actual) === JSON.stringify(expected);
