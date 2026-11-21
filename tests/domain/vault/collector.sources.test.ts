import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Collector } from '../../../src/domain/vault/collector.js';
import { MarkdownVault } from '../../../src/domain/vault/markdown-vault.js';
import { VaultFileWriter } from '../../../src/domain/vault/vault-files.js';
import { transcriptDocument } from '../../../src/domain/sources/youtube/server.js';
import { video } from '../../support/exchange-fixtures.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('document sources', () => {
  it('names a publisher without a subscription after its newest document, because the Vault lists newest first', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-sources-'));
    roots.push(root);
    const clock = { now: new Date('2026-10-01T00:00:00.000Z') };
    const vault = new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES), { now: () => clock.now });
    await vault.add(transcriptDocument(video('aaaaaaaaaa1', { channelId: 'renamed-channel', channelTitle: '舊名稱' })));
    clock.now = new Date('2026-10-02T00:00:00.000Z');
    await vault.add(transcriptDocument(video('zzzzzzzzzz1', { channelId: 'renamed-channel', channelTitle: '新名稱' })));

    const sources = await new Collector(vault).sources({ youtube: { subscriptions: [] } });

    expect(sources.groups).toEqual([expect.objectContaining({
      sourceType: 'youtube',
      publishers: [expect.objectContaining({ id: 'renamed-channel', name: '新名稱', count: 2, subscribed: false })],
    })]);
  });
});
