import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import packageJson from '../../../package.json' with { type: 'json' };
import runtimePins from '../../../src/domain/search/meilisearch-runtime-pins.json' with { type: 'json' };
import { SEARCH_INDEX_VERSION } from '../../../src/domain/search/search-projection.js';

it('builds index version 1 with Meilisearch 1.53.2, opencc-js 1.4.2 and the shipped lexicon, so changing any of them requires raising the index version', async () => {
  const lexicon = createHash('sha256').update(await readFile(path.resolve('resources/search/coct-main.txt'))).digest('hex');
  expect({ indexVersion: SEARCH_INDEX_VERSION, meilisearch: runtimePins.version, opencc: packageJson.dependencies['opencc-js'], lexicon }).toEqual({
    indexVersion: 1,
    meilisearch: '1.53.2',
    opencc: '1.4.2',
    lexicon: '4b2d026eaa353ffde900f36049e72f1fa6902fbf25b14dbcb0b675d541e01264',
  });
});
