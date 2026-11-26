// Broken, after an import replaces the Vault, turning automatic collection off leaves subscriptions checking on their own.
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownVault } from '../../../src/domain/vault/markdown-vault.js';
import { transcriptDocument } from '../../../src/domain/sources/youtube/server.js';
import { VaultFileWriter } from '../../../src/domain/vault/vault-files.js';
import { packageBytes } from '../../support/package-fixtures.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';
import { cleanUp, fileOf, importFile, machine, open, seed, video } from '../../support/exchange-fixtures.js';

afterEach(cleanUp);

describe('automatic collection after an import', () => {
  it('follows the schedule switch in subscriptions, because the import replaces the scheduler they ask', async () => {
    const local = await machine('Local'); const incoming = await machine('Incoming', local.root);
    await seed(local.vault); await seed(incoming.vault);
    await new MarkdownVault(new VaultFileWriter(incoming.vault, PRODUCT_SOURCES)).add(transcriptDocument(video('new00000001')));
    const workspace = await open(local);
    const youtube = () => workspace.subscriptions.all().find((service) => service.type === 'youtube')!;
    expect((await youtube().listSubscriptions())[0]!.checkStatus.state).not.toBe('auto_check_off');

    const file = await fileOf(incoming.exports, 'incoming.zip', await packageBytes(incoming.vault));
    expect((await importFile(workspace, file, 'replace')).status.state).toBe('completed');
    await workspace.schedule.updateSchedule({ enabled: false });

    expect((await youtube().listSubscriptions())[0]!.checkStatus.state).toBe('auto_check_off');
  });
});
