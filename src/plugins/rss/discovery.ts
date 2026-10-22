import type { Element, Root } from 'hast';
import rehypeParse from 'rehype-parse';
import { unified } from 'unified';
import { resolve } from './feed.js';

const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/xml', 'text/xml']);

/**
 * The feed addresses a web page announces with `<link rel="alternate">`, absolute and in page
 * order. Relative addresses resolve against the page's `<base href>`, else against `pageUrl`.
 */
export function findFeedLinks(html: string, pageUrl: string): string[] {
  const tree = unified().use(rehypeParse).parse(html) as Root;
  const links: Element[] = [];
  let base = pageUrl;
  const visit = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.tagName === 'base' && typeof child.properties.href === 'string' && base === pageUrl) {
        base = resolve(child.properties.href, pageUrl) ?? pageUrl;
      }
      if (child.tagName === 'link') links.push(child);
      visit(child);
    }
  };
  visit(tree);
  const found: string[] = [];
  for (const link of links) {
    const rel = link.properties.rel;
    const rels = (Array.isArray(rel) ? rel : [rel]).map((value) => String(value).toLowerCase());
    const type = String(link.properties.type ?? '').toLowerCase().split(';')[0]!.trim();
    if (!rels.includes('alternate') || !FEED_TYPES.has(type)) continue;
    const href = resolve(typeof link.properties.href === 'string' ? link.properties.href : null, base);
    if (href && !found.includes(href)) found.push(href);
  }
  return found;
}
