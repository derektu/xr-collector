import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startSearchRuntime } from '../../../src/domain/search/runtime.js';
import type { DocumentVault } from '../../../src/shared/documents/document-vault.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('a search engine that cannot start is unavailable rather than failed, since a rebuild cannot help, and reports only a short reason, leaving the cause, such as a local path, to the program log', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-search-runtime-'));
  roots.push(root);
  const lexiconPath = path.join(root, 'missing-lexicon.txt');
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const runtime = await startSearchRuntime({
    vault: {} as DocumentVault, sources: PRODUCT_SOURCES, binaryPath: path.join(root, 'meilisearch'),
    lexiconPath, searchData: path.join(root, 'search'), vaultRoot: path.join(root, 'vault'),
  });
  expect(runtime.search.status()).toMatchObject({ state: 'unavailable', message: '無法啟動搜尋引擎。' });
  expect(log.mock.calls.flat().join(' ')).toContain('missing-lexicon.txt');
  await runtime.close();
});
