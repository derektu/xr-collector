import { XMLParser } from 'fast-xml-parser';
import { CollectorError, type ContentExtent } from '../../core/types.js';
import { htmlToText } from './html.js';

/** One article of a feed, as the feed describes it. */
export interface FeedEntry {
  /** What identifies the article within its feed: its guid or Atom ID, else its address, else its title and time. */
  identity: string;
  title: string;
  /** The article's address, absolute; null when the feed gives none. */
  link: string | null;
  publishedAt: string | null;
  /** The article body as HTML, empty when the feed carries none. */
  html: string;
  /** Whether `html` is the full article or only the summary the feed offers. */
  extent: ContentExtent;
  /** The address relative links in `html` resolve against. */
  base: string;
}

export interface Feed {
  title: string;
  /** Articles newest first. */
  entries: FeedEntry[];
}

type XmlNode = Record<string, unknown>;

// Bodies stay raw text, so markup inside them is not parsed as feed elements; `rawText` decodes them.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  stopNodes: ['*.description', '*.content:encoded', '*.content', '*.summary'],
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

/** Whether a response body looks like a feed rather than a web page. */
export function looksLikeFeed(text: string): boolean {
  const start = text.slice(0, 2048).replace(/^﻿/u, '');
  return /<(rss|feed|rdf:RDF)[\s>]/u.test(start);
}

/**
 * Reads an RSS 2.0, RSS 1.0 (RDF) or Atom document fetched from `feedUrl`. Articles come newest
 * first; articles without a publish time come before the dated ones, in feed order, so a check
 * reaches them before the range ends its scan. Articles with nothing to identify them are left out,
 * and of articles with the same identity only the first is kept. Throws `feed_invalid` for a
 * document that is not a feed.
 */
export function parseFeed(xml: string, feedUrl: string): Feed {
  let document: XmlNode;
  try {
    document = parser.parse(xml) as XmlNode;
  } catch (error) {
    throw new CollectorError('feed_invalid', '這個網址的 feed 格式無法讀取。', { cause: error });
  }
  const rss = node(document.rss);
  const rdf = node(document['rdf:RDF']);
  const atom = node(document.feed);
  let title: string;
  let entries: FeedEntry[];
  if (rss || rdf) {
    const channel = node((rss ?? rdf)!.channel) ?? {};
    title = plainTitle(channel.title);
    const items = list(rss ? channel.item : rdf!.item);
    entries = items.map((item) => rssEntry(item, feedUrl));
  } else if (atom) {
    const feedBase = resolve(attribute(atom, 'xml:base'), feedUrl) ?? feedUrl;
    title = plainTitle(atom.title);
    entries = list(atom.entry).map((entry) => atomEntry(entry, feedBase));
  } else {
    throw new CollectorError('feed_invalid', '這個網址的 feed 格式無法讀取。');
  }
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (!entry.identity || seen.has(entry.identity)) return false;
    seen.add(entry.identity);
    return true;
  });
  const undated = unique.filter((entry) => !entry.publishedAt);
  const dated = unique.filter((entry) => entry.publishedAt).sort((left, right) => right.publishedAt!.localeCompare(left.publishedAt!));
  return { title: title || new URL(feedUrl).hostname, entries: [...undated, ...dated] };
}

function rssEntry(item: XmlNode, feedUrl: string): FeedEntry {
  const guid = text(item.guid);
  // A guid is the article's address unless the feed marks it otherwise.
  const permalink = attribute(item.guid, 'isPermaLink') !== 'false' ? resolve(guid, feedUrl) : null;
  const link = resolve(text(first(item.link)), feedUrl) ?? permalink;
  const publishedAt = date(text(item.pubDate) || text(item['dc:date']));
  const title = plainTitle(item.title);
  const full = rawText(item['content:encoded']);
  const summary = rawText(item.description);
  return {
    identity: identity(guid, link, title, publishedAt), title, link, publishedAt,
    html: full || summary, extent: full ? 'full' : 'summary', base: link ?? feedUrl,
  };
}

function atomEntry(entry: XmlNode, feedBase: string): FeedEntry {
  const base = resolve(attribute(entry, 'xml:base'), feedBase) ?? feedBase;
  const links = list(entry.link);
  const alternate = links.find((candidate) => (attribute(candidate, 'rel') ?? 'alternate') === 'alternate');
  const link = resolve(attribute(alternate, 'href'), base);
  const publishedAt = date(text(entry.published) || text(entry.updated));
  const title = plainTitle(entry.title);
  const content = node(entry.content) ?? (typeof entry.content === 'string' ? { '#text': entry.content } : null);
  // Content held at another address (`src`) is not in the feed.
  const full = content && !attribute(content, 'src') ? atomText(content) : '';
  const summaryNode = node(entry.summary) ?? (typeof entry.summary === 'string' ? { '#text': entry.summary } : null);
  const summary = summaryNode ? atomText(summaryNode) : '';
  return {
    identity: identity(text(entry.id), link, title, publishedAt), title, link, publishedAt,
    html: full || summary, extent: full ? 'full' : 'summary',
    base: resolve(attribute(content, 'xml:base'), base) ?? link ?? base,
  };
}

/** An Atom text construct as HTML: `xhtml` is markup already, `html` is escaped markup, `text` is plain text. */
function atomText(construct: XmlNode): string {
  const type = attribute(construct, 'type') ?? 'text';
  const raw = typeof construct['#text'] === 'string' ? construct['#text'] : '';
  if (type === 'xhtml') return raw;
  const decoded = rawText(raw);
  return type === 'html' || type === 'text/html' ? decoded : escapeHtml(decoded);
}

function identity(id: string, link: string | null, title: string, publishedAt: string | null): string {
  if (id) return `id:${id}`;
  if (link) return `link:${link}`;
  return title && publishedAt ? `title:${title}\n${publishedAt}` : '';
}

/** A title as plain text, whether the feed escaped markup into it or not. */
function plainTitle(value: unknown): string {
  return htmlToText(text(value)).replace(/\s+/gu, ' ').trim();
}

/**
 * The text of an element the parser left raw: CDATA sections taken as they are and XML entities
 * decoded elsewhere.
 */
function rawText(value: unknown): string {
  const raw = typeof value === 'string' ? value : text(value);
  return raw.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/u)
    .map((part) => part.startsWith('<![CDATA[') ? part.slice(9, -3) : decodeXml(part))
    .join('')
    .trim();
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/giu, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return codePoint(Number.parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith('#')) return codePoint(Number.parseInt(lower.slice(1), 10), whole);
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[lower] ?? whole;
  });
}

function codePoint(value: number, fallback: string): string {
  try { return String.fromCodePoint(value); } catch { return fallback; }
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function date(value: string): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** An absolute http(s) address of `value` against `base`; null for none or another scheme. */
export function resolve(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function node(value: unknown): XmlNode | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : null;
}

function list(value: unknown): XmlNode[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map((entry) => node(entry) ?? (typeof entry === 'string' ? { '#text': entry } : null))
    .filter((entry): entry is XmlNode => entry !== null);
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const found = node(value)?.['#text'];
  return typeof found === 'string' ? found.trim() : '';
}

function attribute(value: unknown, name: string): string | null {
  const found = node(value)?.[`@_${name}`];
  return typeof found === 'string' ? found : null;
}
