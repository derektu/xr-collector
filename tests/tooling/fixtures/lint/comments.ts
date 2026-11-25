// Retries three times because the server is flaky.
export const RETRIES = 3;
/* The default page size. */
export const PAGE_SIZE = 50;
// External: Meilisearch document ids allow only A-Z, a-z, 0-9, '-' and '_'.
// https://www.meilisearch.com/docs/learn/getting_started/primary_key#formatting-the-document-id
// and every id is unique within an index.
export const ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

// A line after a gap starts a new comment.
export const SEPARATOR = '-'; // External: a trailing comment states one fact.
// The line after code starts a new comment.
