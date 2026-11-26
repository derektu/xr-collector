// Broken, a search engine that cannot start shows as a failure a rebuild could fix, or shows a local path instead of keeping it in the program log.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startSearchRuntime } from '../../../src/domain/search/runtime.js';
import type { DocumentVault } from '../../../src/shared/documents/document-vault.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';
import { recordingLog } from '../../support/log.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('a search engine that cannot start is unavailable rather than failed, since a rebuild cannot help, and reports only a short reason, leaving the cause, such as a local path, to the program log', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-search-runtime-'));
  roots.push(root);
  const lexiconPath = path.join(root, 'missing-lexicon.txt');
  const log = recordingLog();
  const runtime = await startSearchRuntime({
    log,
    vault: {} as DocumentVault, sources: PRODUCT_SOURCES, binaryPath: path.join(root, 'meilisearch'),
    lexiconPath, searchData: path.join(root, 'search'), vaultRoot: path.join(root, 'vault'),
  });
  expect(runtime.search.status()).toMatchObject({ state: 'unavailable', message: '無法啟動搜尋引擎。' });
  expect(log.records).toEqual([expect.objectContaining({ level: 'error', message: expect.stringContaining('missing-lexicon.txt') })]);
  await runtime.close();
});
