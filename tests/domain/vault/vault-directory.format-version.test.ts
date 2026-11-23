import { expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../../../src/app/plugins/index.js';
import { FORMAT_VERSION } from '../../../src/domain/vault/vault-directory.js';

it('covers youtube and rss with format version 1, so adding a source type requires raising the format version', () => {
  expect({ formatVersion: FORMAT_VERSION, sourceTypes: SOURCE_DEFINITIONS.map((definition) => definition.id).sort() })
    .toEqual({ formatVersion: 1, sourceTypes: ['rss', 'youtube'] });
});
