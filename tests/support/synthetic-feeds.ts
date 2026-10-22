import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local web server of synthetic feeds and pages for RSS tests. Each path answers with the route
 * the test sets: a status, a body and a content type, optionally after a delay. Requests to paths
 * without a route answer 404. Every request is counted by path.
 */
export interface Route {
  status?: number;
  body: string;
  contentType?: string;
  delayMs?: number;
}

export class SyntheticFeeds {
  readonly routes = new Map<string, Route>();
  readonly requests = new Map<string, number>();
  private constructor(private readonly server: Server, readonly origin: string) {}

  static async start(): Promise<SyntheticFeeds> {
    let feeds!: SyntheticFeeds;
    const server = createServer((request, response) => {
      const key = new URL(request.url ?? '/', feeds.origin).pathname;
      const route = feeds.routes.get(key);
      feeds.requests.set(key, (feeds.requests.get(key) ?? 0) + 1);
      const answer = () => {
        if (!route) {
          response.writeHead(404).end('not found');
          return;
        }
        response.writeHead(route.status ?? 200, { 'content-type': route.contentType ?? 'application/rss+xml; charset=utf-8' }).end(route.body);
      };
      if (route?.delayMs) setTimeout(answer, route.delayMs);
      else answer();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    feeds = new SyntheticFeeds(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return feeds;
  }

  url(pathname: string): string {
    return `${this.origin}${pathname}`;
  }

  set(pathname: string, route: Route): void {
    this.routes.set(pathname, route);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export interface SyntheticArticle {
  title: string;
  link?: string;
  guid?: string;
  publishedAt?: Date | null;
  /** Full content: `content:encoded` in RSS, `content` in Atom. */
  content?: string;
  /** Summary: `description` in RSS, `summary` in Atom. */
  summary?: string;
}

const escape = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

/** An RSS 2.0 document. Bodies go in CDATA sections; titles are escaped. */
export function rss2(title: string, articles: SyntheticArticle[]): string {
  const items = articles.map((article) => [
    '<item>',
    `<title>${escape(article.title)}</title>`,
    article.link ? `<link>${escape(article.link)}</link>` : '',
    article.guid ? `<guid isPermaLink="false">${escape(article.guid)}</guid>` : '',
    article.publishedAt ? `<pubDate>${article.publishedAt.toUTCString()}</pubDate>` : '',
    article.summary !== undefined ? `<description>${escape(article.summary)}</description>` : '',
    article.content !== undefined ? `<content:encoded><![CDATA[${article.content}]]></content:encoded>` : '',
    '</item>',
  ].join('')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>${escape(title)}</title><link>https://example.com/</link>
${items}
</channel></rss>`;
}

/** An Atom document with `xml:base` set to `base` when given; bodies are `html` text constructs. */
export function atom(title: string, articles: SyntheticArticle[], base?: string): string {
  const entries = articles.map((article) => [
    '<entry>',
    `<title>${escape(article.title)}</title>`,
    article.guid ? `<id>${escape(article.guid)}</id>` : '',
    article.link ? `<link rel="alternate" href="${escape(article.link)}"/>` : '',
    article.publishedAt ? `<updated>${article.publishedAt.toISOString()}</updated>` : '',
    article.summary !== undefined ? `<summary type="html">${escape(article.summary)}</summary>` : '',
    article.content !== undefined ? `<content type="html">${escape(article.content)}</content>` : '',
    '</entry>',
  ].join('')).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"${base ? ` xml:base="${escape(base)}"` : ''}><title>${escape(title)}</title>
${entries}
</feed>`;
}

/** A web page that announces `feeds` with `<link rel="alternate">`, by their (possibly relative) addresses. */
export function page(title: string, feeds: Array<{ href: string; type?: string }>): string {
  const links = feeds.map((feed) => `<link rel="alternate" type="${feed.type ?? 'application/rss+xml'}" href="${escape(feed.href)}">`).join('');
  return `<!doctype html><html><head><title>${escape(title)}</title>${links}</head><body><p>${escape(title)}</p></body></html>`;
}
