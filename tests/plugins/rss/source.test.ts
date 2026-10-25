import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findFeedLinks } from '../../../src/plugins/rss/discovery.js';
import { decode, fetchText } from '../../../src/plugins/rss/http.js';
import { articleKey, FEED_CACHE_MS, rssDefinition, rssPlugin, subscriptionId } from '../../../src/plugins/rss/server.js';
import { rssDeclaration } from '../../../src/plugins/rss/shared.js';
import type { ListedItem, SourcePlugin, SubscriptionTarget } from '../../../src/plugins/types.js';
import { atom, page, rss2, SyntheticFeeds } from '../../support/synthetic-feeds.js';

let feeds: SyntheticFeeds;
beforeEach(async () => { feeds = await SyntheticFeeds.start(); });
afterEach(async () => { await feeds.close(); });

const now = Date.now();
const ago = (days: number) => new Date(now - days * 86_400_000);
const plugin = (clock?: { now: number }) => rssPlugin((url, context) => fetchText(url, context.signal), clock ? { now: () => clock.now } : {});

async function listed(source: SourcePlugin, target: SubscriptionTarget): Promise<ListedItem[]> {
  const items: ListedItem[] = [];
  for await (const item of source.listSubscriptionItems!(target, {})) items.push(item);
  return items;
}

describe('finding the feed of an address (R11-T4)', () => {
  it('finds the feeds a page announces, relative addresses resolved against the page or its base', () => {
    expect(findFeedLinks(page('站', [{ href: '/feed.xml' }, { href: 'atom.xml', type: 'application/atom+xml' }, { href: '/feed.xml' }]), 'https://example.com/blog/'))
      .toEqual(['https://example.com/feed.xml', 'https://example.com/blog/atom.xml']);
    expect(findFeedLinks('<html><head><base href="https://cdn.example/x/"><link rel="alternate" type="application/rss+xml" href="f.xml"></head></html>', 'https://example.com/'))
      .toEqual(['https://cdn.example/x/f.xml']);
    expect(findFeedLinks('<html><head><link rel="stylesheet" href="a.css"><link rel="alternate" type="text/html" href="/en"></head></html>', 'https://example.com/')).toEqual([]);
  });

  it('subscribes to a feed address directly and to the first feed a site page announces', async () => {
    feeds.set('/feed.xml', { body: rss2('【合成】部落格', [{ title: '文一', guid: 'g1', publishedAt: ago(1) }]) });
    feeds.set('/', { body: page('首頁', [{ href: '/feed.xml' }]), contentType: 'text/html; charset=utf-8' });
    const source = plugin();
    const direct = await source.resolveTarget!(feeds.url('/feed.xml'), {});
    const viaPage = await source.resolveTarget!(feeds.url('/'), {});
    expect(direct).toEqual({ id: subscriptionId(feeds.url('/feed.xml')), title: '【合成】部落格', url: feeds.url('/feed.xml') });
    expect(viaPage).toEqual(direct);
  });

  it('refuses a page without a feed and an address that answers nothing', async () => {
    feeds.set('/plain', { body: page('沒有 feed', []), contentType: 'text/html' });
    feeds.set('/broken', { body: page('壞連結', [{ href: '/missing.xml' }]), contentType: 'text/html' });
    const source = plugin();
    await expect(source.resolveTarget!(feeds.url('/plain'), {})).rejects.toMatchObject({ code: 'invalid_subscription', message: '這個網址沒有 RSS feed。' });
    await expect(source.resolveTarget!(feeds.url('/broken'), {})).rejects.toMatchObject({ code: 'feed_not_found' });
    await expect(source.resolveTarget!(feeds.url('/nothing'), {})).rejects.toMatchObject({ code: 'feed_not_found' });
  });

  it('owns web addresses no other type owns and classifies them as subscriptions', () => {
    const own = (input: string) => rssDeclaration.owns(input, (() => { try { return new URL(input); } catch { return null; } })());
    expect(own('https://example.com/feed')).toBe(true);
    expect(own('http://example.com/')).toBe(true);
    expect(own('https://www.youtube.com/@someone')).toBe(false);
    expect(own('ftp://example.com/feed')).toBe(false);
    expect(own('not a url')).toBe(false);
    expect(rssDeclaration.classify('https://example.com/feed#top')).toEqual({ kind: 'subscription', url: 'https://example.com/feed' });
    expect(() => rssDeclaration.parseItem('https://example.com/a')).toThrow(expect.objectContaining({ code: 'invalid_url' }));
  });
});

describe('reading a feed over HTTP (R11-T6)', () => {
  it('classifies failures: server errors are retried now, a limit, a missing or an invalid feed fails the check', async () => {
    feeds.set('/busy', { status: 503, body: 'busy' });
    feeds.set('/limited', { status: 429, body: 'slow down' });
    feeds.set('/gone', { status: 410, body: 'gone' });
    feeds.set('/forbidden', { status: 403, body: 'no' });
    feeds.set('/junk', { body: 'not xml at all <' });
    const target = (path: string) => ({ id: 'x', title: 'x', url: feeds.url(path) });
    const source = plugin();
    const code = async (path: string) => (await listed(source, target(path)).catch((error: { code: string }) => error)) as { code: string };
    expect((await code('/busy')).code).toBe('network_error');
    expect((await code('/limited')).code).toBe('rate_limited');
    expect((await code('/gone')).code).toBe('feed_not_found');
    expect((await code('/forbidden')).code).toBe('feed_unavailable');
    expect((await code('/junk')).code).toBe('feed_invalid');
    await expect(fetchText('http://127.0.0.1:9/feed')).rejects.toMatchObject({ code: 'network_error' });
    expect(['network_error', 'rate_limited', 'feed_not_found', 'feed_unavailable', 'feed_invalid', 'article_missing', 'whatever']
      .map((errorCode) => rssDefinition.classifyFailure({ code: errorCode })))
      .toEqual(['retry_now', 'retry_next_check', 'retry_next_check', 'retry_next_check', 'retry_next_check', 'retry_next_check', 'skip']);
  });

  it('decodes the charset the response or the document declares', () => {
    const big5 = new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5]);
    expect(decode(big5, 'application/rss+xml; charset=big5')).toBe('中文');
    const declared = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="big5"?>'), ...big5]);
    expect(decode(declared, 'application/xml')).toContain('中文');
    expect(decode(new TextEncoder().encode('中文'), null)).toBe('中文');
  });
});

describe('collecting an article from its feed', () => {
  it('lists articles newest first and captures one from the feed read last, with its body, extent and publisher', async () => {
    feeds.set('/feed.xml', { body: rss2('【合成】部落格', [
      { title: '全文', guid: 'g1', link: '/p/1', publishedAt: ago(1), content: '<p>全文 <a href="/x">連結</a></p>' },
      { title: '摘要', guid: 'g2', link: '/p/2', publishedAt: ago(2), summary: '<p>摘要</p>' },
    ]) });
    const source = plugin();
    const target = await source.resolveTarget!(feeds.url('/feed.xml'), {});
    const items = await listed(source, target);
    expect(items.map((item) => [item.title, item.url, item.eligible])).toEqual([['全文', feeds.url('/p/1'), true], ['摘要', feeds.url('/p/2'), true]]);
    const before = feeds.requests.get('/feed.xml');

    const full = await source.captureItem(items[0]!, { subscription: target });
    const summary = await source.captureItem(items[1]!, { subscription: target });
    expect(feeds.requests.get('/feed.xml')).toBe(before);
    expect(full).toEqual({
      key: items[0]!.key, sourceUrl: feeds.url('/p/1'), title: '全文', publisher: { id: target.id, name: '【合成】部落格' },
      publishedAt: items[0]!.publishedAt, bodyMarkdown: `全文 [連結](${feeds.url('/x')})`, contentExtent: 'full', details: null,
    });
    expect(summary).toMatchObject({ bodyMarkdown: '摘要', contentExtent: 'summary' });
  });

  it('reads the feed again for a capture after a restart or once the read is old, and reports an article the feed dropped', async () => {
    const articles = [{ title: '一', guid: 'g1', publishedAt: ago(1), content: '<p>一</p>' }];
    feeds.set('/feed.xml', { body: atom('站', articles) });
    const target = { id: subscriptionId(feeds.url('/feed.xml')), title: '站', url: feeds.url('/feed.xml') };
    const key = articleKey(target.id, { identity: 'id:g1' });

    const restarted = plugin();
    expect(await restarted.captureItem({ key, url: '', title: null }, { subscription: target })).toMatchObject({ title: '一' });
    expect(feeds.requests.get('/feed.xml')).toBe(1);

    const clock = { now };
    const source = plugin(clock);
    await listed(source, target);
    clock.now += FEED_CACHE_MS + 1;
    await source.captureItem({ key, url: '', title: null }, { subscription: target });
    expect(feeds.requests.get('/feed.xml')).toBe(3);

    feeds.set('/feed.xml', { body: atom('站', []) });
    await expect(plugin().captureItem({ key, url: '', title: null }, { subscription: target })).rejects.toMatchObject({ code: 'article_missing' });
    await expect(source.captureItem({ key, url: '', title: null }, {})).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('skips an article published before the range at capture', async () => {
    feeds.set('/feed.xml', { body: rss2('站', [{ title: '舊', guid: 'old', publishedAt: ago(40), summary: '舊' }]) });
    const source = plugin();
    const target = await source.resolveTarget!(feeds.url('/feed.xml'), {});
    const [item] = await listed(source, target);
    await expect(source.captureItem(item!, { subscription: target, publishedNotBefore: ago(30).toISOString() }))
      .rejects.toMatchObject({ code: 'out_of_range' });
  });
});
