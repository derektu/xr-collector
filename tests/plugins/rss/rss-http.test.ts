import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchText } from '../../../src/plugins/rss/http.js';
import { rssPlugin, subscriptionId } from '../../../src/plugins/rss/server.js';
import type { SourcePlugin } from '../../../src/plugins/types.js';
import { createHttpApp } from '../../../src/server/app.js';
import { page, rss2, SyntheticFeeds } from '../../support/synthetic-feeds.js';
import { youtubePlugins } from '../../support/youtube-sources.js';
import { cleanUp, machine, open, seed, temp } from '../../support/exchange-fixtures.js';
import { eventually } from '../../support/wait.js';

// RSS through the routes every source type shares (R11-T9): an Agent with a token previews,
// subscribes, changes, checks and removes an RSS subscription and reads its documents.

const TOKEN = 'rss-routes-token';
let feeds: SyntheticFeeds;
beforeEach(async () => { feeds = await SyntheticFeeds.start(); });
afterEach(async () => {
  await cleanUp();
  await feeds.close();
});

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

async function world() {
  const at = await machine('A', await temp());
  await seed(at.vault);
  const workspace = await open(at, { plugins: [...youtubePlugins(), rssPlugin((url, context) => fetchText(url, context.signal)) as unknown as SourcePlugin] });
  const options = {
    collector: workspace.collector, jobs: workspace.jobs, subscriptions: workspace.subscriptions.all(), schedule: workspace.schedule,
  };
  const agent = await createHttpApp({ ...options, agentToken: TOKEN });
  const send = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const response = await agent.inject({
      method, url, headers: { authorization: `Bearer ${TOKEN}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: response.statusCode, body: response.json() };
  };
  const settled = async (id: string) => {
    await eventually(async () => expect((await send('GET', `/api/jobs/${id}`)).body.job.state).toMatch(/^(completed|failed)$/u));
    return (await send('GET', `/api/jobs/${id}`)).body.job;
  };
  return { workspace, agent, send, settled, close: () => agent.close() };
}

describe('RSS on the shared routes (R11-T9)', () => {
  it('recognizes, previews, subscribes, reads, changes, checks and removes an RSS subscription', async () => {
    feeds.set('/feed.xml', { body: rss2('【合成】部落格', [{ title: '【合成】一', guid: '1', link: '/1', publishedAt: ago(1), summary: '摘要' }]) });
    feeds.set('/', { body: page('首頁', [{ href: '/feed.xml' }]), contentType: 'text/html' });
    const w = await world();
    const id = subscriptionId(feeds.url('/feed.xml'));

    const recognition = (await w.send('POST', '/api/url-recognitions', { url: feeds.url('/') })).body.recognition;
    expect(recognition).toMatchObject({
      status: 'ready', sourceType: 'rss', kind: 'feed', kindLabel: 'RSS', target: { id, title: '【合成】部落格', url: feeds.url('/feed.xml') },
      actions: [{ id: 'subscribe', label: '訂閱網站', request: { method: 'POST', path: '/api/subscriptions', body: { url: feeds.url('/feed.xml') } } }],
    });
    expect((await w.send('POST', '/api/subscription-previews', { url: feeds.url('/') })).body.preview)
      .toMatchObject({ type: 'rss', subscription: null, settings: { intervalMinutes: 60, backfillDays: 7, backfillMaxItems: 30 } });
    expect(await w.send('POST', '/api/items', { url: feeds.url('/1') })).toMatchObject({ status: 400, body: { error: { code: 'invalid_url' } } });

    const added = await w.settled((await w.send('POST', '/api/subscriptions', { url: feeds.url('/'), settings: { backfillMaxItems: 5 } })).body.job.id);
    expect(added).toMatchObject({ kind: 'rss.feed-add', result: { outcome: 'created' } });
    expect(await w.settled(added.result.followUpJobId)).toMatchObject({ kind: 'rss.feed', state: 'completed' });

    const patched = await w.send('PATCH', `/api/subscriptions/rss/${id}`, { settings: { backfillDays: 45 } });
    expect(patched).toMatchObject({ status: 200 });
    expect((await w.send('PATCH', `/api/subscriptions/rss/${id}`, { settings: { backfillDays: 61 } })).status).toBe(400);
    const detail = (await w.send('GET', `/api/subscriptions/rss/${id}`)).body;
    expect(detail).toMatchObject({
      subscription: { id, type: 'rss', kind: 'feed', kindLabel: 'RSS', settings: { backfillDays: 45, backfillMaxItems: 5 } },
      collection: [{ kind: 'check', created: 1 }, { kind: 'collected', title: '【合成】一' }],
    });
    const documents = (await w.send('GET', '/api/documents?sourceType=rss')).body.documents;
    expect(documents).toMatchObject([{ sourceType: 'rss', type: 'Article', title: '【合成】一', publisher: { id, name: '【合成】部落格' } }]);
    expect((await w.send('GET', `/api/documents/${encodeURIComponent(documents[0].id)}`)).body.document)
      .toMatchObject({ contentExtent: 'summary', bodyMarkdown: '摘要' });

    feeds.set('/feed.xml', { body: rss2('【合成】部落格', [{ title: '【合成】二', guid: '2', link: '/2', publishedAt: ago(0.5), content: '<p>全文</p>' }, { title: '【合成】一', guid: '1', link: '/1', publishedAt: ago(1), summary: '摘要' }]) });
    const checks = (await w.send('POST', '/api/subscription-checks', { subscriptions: [{ type: 'rss', id }] })).body;
    await w.settled(checks.submissions[0].job.id);
    expect((await w.send('GET', '/api/documents?sourceType=rss')).body.documents).toHaveLength(2);

    expect((await w.send('DELETE', `/api/subscriptions/rss/${id}?documents=delete`)).status).toBe(200);
    await eventually(async () => expect((await w.send('GET', '/api/documents?sourceType=rss')).body.documents).toEqual([]));
    expect((await w.send('GET', `/api/subscriptions/rss/${id}`)).body.error.code).toBe('subscription_not_found');
    await w.close();
  });
});
