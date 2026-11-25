import { expect, it } from 'vitest';
import packageJson from '../../../package.json' with { type: 'json' };
import runtimePins from '../../../src/domain/search/meilisearch-runtime-pins.json' with { type: 'json' };
import { SEARCH_INDEX_VERSION } from '../../../src/domain/search/search-projection.js';

it('builds index version 1 with Meilisearch 1.53.2 and opencc-js 1.4.2, so changing either requires raising the index version', () => {
  expect({ indexVersion: SEARCH_INDEX_VERSION, meilisearch: runtimePins.version, opencc: packageJson.dependencies['opencc-js'] }).toEqual({
    indexVersion: 1,
    meilisearch: '1.53.2',
    opencc: '1.4.2',
  });
});
