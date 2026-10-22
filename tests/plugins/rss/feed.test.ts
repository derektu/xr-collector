import { describe, expect, it } from 'vitest';
import { looksLikeFeed, parseFeed } from '../../../src/plugins/rss/feed.js';
import { articleKey, subscriptionId } from '../../../src/plugins/rss/server.js';
import { ARTICLE_KEY_PATTERN } from '../../../src/plugins/rss/shared.js';
import { atom, rss2 } from '../../support/synthetic-feeds.js';

const FEED = 'https://example.com/blog/feed.xml';
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 8, 0, 0));

describe('reading RSS 2.0 and Atom (R11-T1)', () => {
  it('reads an RSS 2.0 feed: full content, summaries, titles, links and RFC 822 dates, newest first', () => {
    const feed = parseFeed(rss2('部落格 & 筆記', [
      { title: '舊文', guid: 'a-1', link: 'https://example.com/a/1', publishedAt: day(1), summary: '<p>摘要</p>' },
      { title: '新文 <三>', guid: 'a-3', link: '/a/3', publishedAt: day(3), summary: '短', content: '<p>全文 <b>粗</b></p>' },
      { title: '中間', guid: 'a-2', link: 'https://example.com/a/2', publishedAt: day(2), summary: '<p>只有摘要</p>' },
    ]), FEED);

    expect(feed.title).toBe('部落格 & 筆記');
    expect(feed.entries.map((entry) => entry.title)).toEqual(['新文 <三>', '中間', '舊文']);
    expect(feed.entries[0]).toEqual({
      identity: 'id:a-3', title: '新文 <三>', link: 'https://example.com/a/3', publishedAt: day(3).toISOString(),
      html: '<p>全文 <b>粗</b></p>', extent: 'full', base: 'https://example.com/a/3',
    });
    expect(feed.entries[1]).toMatchObject({ html: '<p>只有摘要</p>', extent: 'summary' });
  });

  it('reads an Atom feed with xml:base, escaped HTML content and summaries', () => {
    const feed = parseFeed(atom('Atom 筆記', [
      { title: '全文', guid: 'tag:example.com,2026:1', link: 'posts/1', publishedAt: day(5), content: '<p>內文 <a href="../x">連結</a></p>' },
      { title: '摘要', guid: 'tag:example.com,2026:2', link: 'posts/2', publishedAt: day(4), summary: '<p>摘要而已</p>' },
    ], 'https://example.org/blog/'), FEED);

    expect(feed.title).toBe('Atom 筆記');
    expect(feed.entries[0]).toEqual({
      identity: 'id:tag:example.com,2026:1', title: '全文', link: 'https://example.org/blog/posts/1', publishedAt: day(5).toISOString(),
      html: '<p>內文 <a href="../x">連結</a></p>', extent: 'full', base: 'https://example.org/blog/posts/1',
    });
    expect(feed.entries[1]).toMatchObject({ extent: 'summary', html: '<p>摘要而已</p>' });
  });

  it('reads Atom xhtml content and RSS 1.0 (RDF) items', () => {
    const xhtml = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title type="html">X &lt;i&gt;y&lt;/i&gt;</title>
      <entry><id>urn:1</id><title>E</title><link href="https://example.com/e"/><updated>2026-10-01T00:00:00Z</updated>
      <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello &amp; <em>world</em></p></div></content></entry></feed>`, FEED);
    expect(xhtml.title).toBe('X y');
    expect(xhtml.entries[0]).toMatchObject({ extent: 'full', link: 'https://example.com/e' });
    expect(xhtml.entries[0]!.html).toContain('<p>Hello &amp; <em>world</em></p>');

    const rdf = parseFeed(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>RDF 站</title></channel>
      <item><title>R1</title><link>https://example.com/r1</link><dc:date>2026-10-02T00:00:00Z</dc:date><description>摘要</description></item>
    </rdf:RDF>`, FEED);
    expect(rdf).toMatchObject({ title: 'RDF 站', entries: [{ title: 'R1', link: 'https://example.com/r1', publishedAt: '2026-10-02T00:00:00.000Z', extent: 'summary' }] });
  });

  it('reads CDATA as written, decodes entities once in content and reads titles as HTML text', () => {
    const feed = parseFeed(`<rss version="2.0"><channel><title>A &amp; B</title>
      <item><guid>c</guid><title><![CDATA[C &amp; <b>D</b>]]></title><description><![CDATA[<p>甲 &amp; 乙</p>]]></description></item>
      <item><guid>e</guid><title>E &amp;amp; F</title><description>&lt;p&gt;&amp;lt;script&amp;gt;&lt;/p&gt;</description></item>
    </channel></rss>`, FEED);
    expect(feed.title).toBe('A & B');
    expect(feed.entries.map((entry) => [entry.title, entry.html])).toEqual([
      ['C & D', '<p>甲 &amp; 乙</p>'],
      ['E & F', '<p>&lt;script&gt;</p>'],
    ]);
  });

  it('puts undated articles first in feed order, keeps the first of the same identity and drops articles with nothing to identify them', () => {
    const feed = parseFeed(rss2('站', [
      { title: '有日期', guid: 'd', publishedAt: day(2) },
      { title: '沒日期一', guid: 'u1' },
      { title: '沒日期二', guid: 'u2' },
      { title: '重複', guid: 'd', publishedAt: day(9) },
      { title: '' },
    ]), FEED);
    expect(feed.entries.map((entry) => entry.title)).toEqual(['沒日期一', '沒日期二', '有日期']);
  });

  it('tells a feed from a web page and refuses a document that is no feed', () => {
    expect(looksLikeFeed(rss2('站', []))).toBe(true);
    expect(looksLikeFeed(atom('站', []))).toBe(true);
    expect(looksLikeFeed('<!doctype html><html><head></head></html>')).toBe(false);
    expect(() => parseFeed('<html><body>no</body></html>', FEED)).toThrow(expect.objectContaining({ code: 'feed_invalid' }));
    expect(parseFeed(rss2('', []), FEED).title).toBe('example.com');
  });
});

describe('article keys (R11-T2)', () => {
  const sub = subscriptionId(FEED);
  const keysOf = (xml: string) => parseFeed(xml, FEED).entries.map((entry) => articleKey(sub, entry));

  it('keeps an article\'s key across reads of its feed, whatever else changes', () => {
    const first = keysOf(rss2('站', [{ title: '原標題', guid: 'g-1', link: 'https://example.com/1', publishedAt: day(1) }]));
    const again = keysOf(rss2('站', [{ title: '改過的標題', guid: 'g-1', link: 'https://example.com/1?utm=x', publishedAt: day(2) }]));
    expect(first).toEqual(again);
    expect(first[0]).toMatch(ARTICLE_KEY_PATTERN);
    expect(sub).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('identifies an article without a guid by its address, and one without either by its title and time', () => {
    const byLink = parseFeed(rss2('站', [{ title: 'T', link: 'https://example.com/p' }]), FEED).entries[0]!;
    const byTitle = parseFeed(rss2('站', [{ title: 'T', publishedAt: day(3) }]), FEED).entries[0]!;
    expect(byLink.identity).toBe('link:https://example.com/p');
    expect(byTitle.identity).toBe(`title:T\n${day(3).toISOString()}`);
    expect(keysOf(rss2('站', [{ title: 'T', publishedAt: day(3) }]))).toEqual(keysOf(rss2('站', [{ title: 'T', publishedAt: day(3) }])));
  });

  it('gives the same guid in two feeds two keys', () => {
    const entry = parseFeed(rss2('站', [{ title: 'T', guid: '1' }]), FEED).entries[0]!;
    expect(articleKey(subscriptionId('https://one.example/feed'), entry)).not.toBe(articleKey(subscriptionId('https://two.example/feed'), entry));
  });
});
