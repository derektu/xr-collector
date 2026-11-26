// Broken, the UI or an authorized Agent cannot export, preview, import, open or create a Vault, an Agent without a key
// reaches them, or an export replaces an existing file.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpApp } from '../../../../src/transport/server/app.js';
import { MarkdownVault } from '../../../../src/domain/vault/markdown-vault.js';
import { VaultFileWriter } from '../../../../src/domain/vault/vault-files.js';
import { transcriptDocument } from '../../../../src/domain/sources/youtube/server.js';
import { cleanUp, fileOf, machine, open, seed, temp, video } from '../../../support/exchange-fixtures.js';
import { ensureMarker, packageBytes } from '../../../support/package-fixtures.js';
import { PRODUCT_SOURCES } from '../../../support/product-sources.js';
import { acceptsBearer } from '../../../support/agent-access.js';

afterEach(cleanUp);

const AGENT = 'test-token';

describe('Vault transfer routes', () => {
  it('export, compare, apply and cancel files named by path for the app and an authorized Agent', async () => {
    const root = await temp();
    const local = await machine('Local', root); const incoming = await machine('Incoming', root);
    await seed(local.vault); await seed(incoming.vault);
    await new MarkdownVault(new VaultFileWriter(incoming.vault, PRODUCT_SOURCES)).add(transcriptDocument(video('new00000001')));
    const file = await fileOf(incoming.exports, 'incoming.zip', await packageBytes(incoming.vault));
    const workspace = await open(local);
    for (const agentToken of [undefined, AGENT]) {
      const app = await createHttpApp({ sources: PRODUCT_SOURCES, collector: workspace.collector, transfer: workspace.operations, ...(agentToken ? { agentAuthorize: acceptsBearer(agentToken) } : {}) });
      const headers = agentToken ? { authorization: `Bearer ${agentToken}` } : {};
      const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
      try {
        if (agentToken) expect((await app.inject({ method: 'POST', url: '/api/vault/export', payload: {} })).statusCode).toBe(401);
        const suggestion = (await app.inject({ url: '/api/vault/export/suggestion', headers })).json();
        expect(suggestion).toEqual({ folder: local.exports, path: expect.stringContaining(local.exports) });
        const target = path.join(local.exports, `${agentToken ?? 'ui'}.zip`);
        const exported = await post('/api/vault/export', { path: target });
        expect([exported.statusCode, exported.json()]).toMatchObject([200, { state: 'completed', result: { exportPath: target } }]);
        const repeat = await post('/api/vault/export', { path: target });
        expect([repeat.statusCode, repeat.json().error.code]).toEqual([409, 'file_exists']);
        const body = await app.inject({ method: 'POST', url: '/api/vault/import/preview', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('PK') });
        expect(body.statusCode).toBe(415);
        const missing = await post('/api/vault/import/preview', { path: path.join(root, 'none.zip') });
        expect([missing.statusCode, missing.json().error.code]).toEqual([400, 'invalid_request']);

        const preview = await post('/api/vault/import/preview', { path: file });
        expect([preview.statusCode, preview.json()]).toMatchObject([200, { id: expect.any(String), package: { fileName: 'incoming.zip' } }]);
        const { id } = preview.json();
        expect((await post('/api/vault/import/apply', { id, mode: 'other' })).statusCode).toBe(400);
        if (!agentToken) {
          expect((await post('/api/vault/import/cancel', { id })).json()).toEqual({ cancelled: true });
          continue;
        }
        const apply = await post('/api/vault/import/apply', { id, mode: 'merge' });
        expect([apply.statusCode, apply.json().operation]).toEqual([202, 'import']);
        await workspace.operations.finished();
        expect((await app.inject({ url: '/api/vault/status', headers })).json()).toMatchObject({ state: 'completed', operation: 'import', result: { importMode: 'merge' } });
      } finally { await app.close(); }
    }
  });

  it('open and create another Vault for an Agent, answer vault_invalid for an unusable folder and vault_location_fixed for a fixed location', async () => {
    const root = await temp();
    const local = await machine('Local', root);
    const other = path.join(root, 'Other');
    await ensureMarker(other);
    const workspace = await open(local);
    const app = await createHttpApp({ sources: PRODUCT_SOURCES, collector: workspace.collector, transfer: workspace.operations, agentAuthorize: acceptsBearer(AGENT) });
    const fixed = await open(await machine('Fixed', root), { fixedLocation: true });
    const fixedApp = await createHttpApp({ sources: PRODUCT_SOURCES, transfer: fixed.operations });
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${AGENT}` }, payload });
    try {
      const unusable = await post('/api/vault/open', { path: path.join(root, 'Nothing') });
      expect([unusable.statusCode, unusable.json().error.code]).toEqual([422, 'vault_invalid']);
      const created = await post('/api/vault/create', { location: root, name: 'Created' });
      expect([created.statusCode, created.json().operation]).toEqual([202, 'create']);
      await workspace.operations.finished();
      const opened = await post('/api/vault/open', { path: other });
      expect([opened.statusCode, opened.json().operation]).toEqual([202, 'open']);
      await workspace.operations.finished();
      expect(workspace.operations.status()).toMatchObject({ state: 'completed', vaultPath: other });

      for (const [url, payload] of [['/api/vault/open', { path: other }], ['/api/vault/create', { location: root, name: 'Elsewhere' }]] as const) {
        const refused = await fixedApp.inject({ method: 'POST', url, payload });
        expect([refused.statusCode, refused.json().error.code], url).toEqual([409, 'vault_location_fixed']);
      }
    } finally { await app.close(); await fixedApp.close(); }
  });
});
