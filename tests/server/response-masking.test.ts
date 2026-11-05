// Every answer and change event the HTTP listeners send has the process's known secrets masked,
// whichever route, hook or not-found answer produced it, so a key that reaches any message on its way
// to the UI or an Agent leaves masked. Document text and addresses that only look like credentials
// ("ring bearer", a feed's `?key=`) pass unchanged. The Agent connection data hands out the key by
// design, and files pass unchanged.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ChangeFeed, formatCursor } from '../../src/core/change-feed.js';
import { CollectorError } from '../../src/core/collector-error.js';
import { protectSecret } from '../../src/core/redact.js';
import { createHttpApp } from '../../src/server/app.js';
import { anyService, appWithEveryRoute } from '../support/api-routes.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';

const SECRET = 'response-masking-secret-296';
protectSecret(SECRET);

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function start(changes = new ChangeFeed()): Promise<FastifyInstance> {
  const app = await appWithEveryRoute({
    changes,
    transfer: anyService({ enterRequest: () => () => undefined }),
    agentConnection: anyService({
      status: () => ({ state: 'available', message: `金鑰 ${SECRET}` }),
      connection: () => ({ url: 'http://127.0.0.1:1', token: SECRET }),
      resetKey: async () => ({ url: 'http://127.0.0.1:1', token: SECRET }),
      download: async () => Buffer.from(`zip ${SECRET}`),
    }),
  });
  apps.push(app);
  return app;
}

describe('HTTP answers', () => {
  it('mask known secrets in every string of a JSON answer, on a route the app does not declare', async () => {
    const app = await start();
    app.get('/api/test/secret', async () => ({ message: `失敗：${SECRET}`, nested: [{ detail: `key ${SECRET}` }], count: 3, at: new Date(0) }));
    app.get('/api/test/secret-error', async () => { throw new CollectorError('invalid_request', `無效：${SECRET}`); });

    const answer = await app.inject({ method: 'GET', url: '/api/test/secret' });
    expect(answer.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(answer.json()).toEqual({ message: '失敗：[已遮蔽]', nested: [{ detail: 'key [已遮蔽]' }], count: 3, at: '1970-01-01T00:00:00.000Z' });
    const error = await app.inject({ method: 'GET', url: '/api/test/secret-error' });
    expect(error.statusCode).toBe(400);
    expect(error.json()).toEqual({ error: { code: 'invalid_request', message: '無效：[已遮蔽]' } });
  });

  it('send document text and addresses that look like credentials unchanged', async () => {
    const app = await start();
    const document = {
      bodyMarkdown: 'He was the ring bearer of the ceremony. Authorization: Bearer is a header name.',
      sourceUrl: 'https://feeds.example.test/private.xml?key=abc123&token=feed-token',
    };
    app.get('/api/test/document', async () => ({ document }));
    expect((await app.inject({ method: 'GET', url: '/api/test/document' })).json()).toEqual({ document });
  });

  it('mask known secrets in an answer without a matching route', async () => {
    const app = await createHttpApp({ sources: PRODUCT_SOURCES, notReady: () => `知識庫無法使用：${SECRET}` });
    apps.push(app);
    const answer = await app.inject({ method: 'GET', url: '/api/no-such-route' });
    expect(answer.statusCode).toBe(503);
    expect(answer.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(answer.json()).toEqual({ error: { code: 'vault_not_ready', message: '知識庫無法使用：[已遮蔽]' } });
  });

  it('hand out the Agent key only in the connection data, and send files unchanged', async () => {
    const app = await start();
    const connection = await app.inject({ method: 'GET', url: '/api/device/agent/connection' });
    expect(connection.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(connection.json().connection.token).toBe(SECRET);
    expect((await app.inject({ method: 'POST', url: '/api/device/agent/key/reset' })).json().connection.token).toBe(SECRET);
    expect((await app.inject({ method: 'GET', url: '/api/device/agent' })).json()).toEqual({ agent: { state: 'available', message: '金鑰 [已遮蔽]' } });
    expect((await app.inject({ method: 'GET', url: '/api/device/agent/skill' })).body).toBe(`zip ${SECRET}`);
  });

  it('mask the changes a waiting read and the event stream send', async () => {
    const changes = new ChangeFeed({ defer: () => undefined });
    const app = await start(changes);
    const origin = formatCursor({ epoch: changes.epoch, number: 0 });
    changes.note({ kind: 'pacing', group: `group ${SECRET}` });
    changes.flush();

    const read = (await app.inject({ method: 'GET', url: `/api/changes?after=${origin}` })).json() as { batches: Array<{ changes: unknown[] }> };
    expect(read.batches[0]!.changes).toEqual([{ kind: 'pacing', group: 'group [已遮蔽]' }]);

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number };
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events?after=${origin}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: change')) text += decoder.decode((await reader.read()).value, { stream: true });
    while (!text.slice(text.indexOf('event: change')).includes('\n\n')) text += decoder.decode((await reader.read()).value, { stream: true });
    controller.abort();
    expect(text).toContain('"group":"group [已遮蔽]"');
    expect(text).not.toContain(SECRET);
  });
});
