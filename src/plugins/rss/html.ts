import type { Element, ElementContent, Root, RootContent } from 'hast';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

/** Elements whose content is never part of an article's text. */
const DROPPED = new Set(['script', 'style', 'noscript', 'template', 'form', 'input', 'select', 'textarea', 'button']);

/** Elements that embed what they show; each becomes a link to it. */
const EMBEDDED = new Set(['iframe', 'video', 'audio']);

/**
 * An article body in HTML as Markdown. Links and images resolve against `base` to absolute http(s)
 * addresses, and ones that do not resolve keep only their text. Images stay as Markdown images of
 * their remote address. A table becomes a GFM table; a table with merged cells or another table
 * inside becomes one paragraph per row. An embedded frame, video or audio becomes a link to what it
 * shows. Scripts, styles, forms and comments are left out, and no raw HTML is kept.
 */
export async function htmlToMarkdown(html: string, base: string): Promise<string> {
  if (!html.trim()) return '';
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html);
  prepare(tree, base);
  const processor = unified().use(rehypeRemark).use(remarkGfm).use(remarkStringify, { bullet: '-', fences: true, rule: '-' });
  return processor.stringify(await processor.run(tree)).trim();
}

/** The text of an HTML fragment, without markup. */
export function htmlToText(html: string): string {
  if (!/[<&]/u.test(html)) return html;
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html);
  return textOf(tree);
}

function prepare(parent: Root | Element, base: string): void {
  const children: Array<RootContent | ElementContent> = [];
  for (const child of parent.children) {
    if (child.type !== 'element') {
      if (child.type === 'text') children.push(child);
      continue;
    }
    if (DROPPED.has(child.tagName)) continue;
    if (child.tagName === 'table' && isComplexTable(child)) {
      children.push(...tableRows(child, base));
      continue;
    }
    if (EMBEDDED.has(child.tagName)) {
      const source = absolute(child.properties.src, base) ?? sourceOf(child, base);
      if (source) children.push(element('p', [element('a', [text(String(child.properties.title || source))], { href: source })]));
      continue;
    }
    if (child.tagName === 'a') {
      const href = absolute(child.properties.href, base);
      if (!href) {
        // A link that leads nowhere keeps its text.
        const wrapper = element('span', child.children);
        prepare(wrapper, base);
        children.push(...wrapper.children);
        continue;
      }
      child.properties.href = href;
    }
    if (child.tagName === 'img') {
      const source = absolute(child.properties.src, base) ?? absolute(child.properties.dataSrc, base);
      if (!source) continue;
      child.properties.src = source;
    }
    prepare(child, base);
    children.push(child);
  }
  parent.children = children as never;
}

/** The first address among a video's or audio's `<source>` elements that resolves. */
function sourceOf(media: Element, base: string): string | null {
  for (const child of media.children) {
    if (child.type !== 'element' || child.tagName !== 'source') continue;
    const source = absolute(child.properties.src, base);
    if (source) return source;
  }
  return null;
}

function isComplexTable(table: Element): boolean {
  let complex = false;
  const visit = (node: Element) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.tagName === 'table') complex = true;
      if ((child.tagName === 'td' || child.tagName === 'th')
        && (Number(child.properties.colSpan ?? 1) > 1 || Number(child.properties.rowSpan ?? 1) > 1)) complex = true;
      visit(child);
    }
  };
  visit(table);
  return complex;
}

/** A table's rows as paragraphs, the cells' text separated by " / ". */
function tableRows(table: Element, base: string): Element[] {
  const rows: Element[] = [];
  const visit = (node: Element) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.tagName === 'tr') {
        const cells = child.children.filter((cell): cell is Element => cell.type === 'element' && (cell.tagName === 'td' || cell.tagName === 'th'));
        const line = cells.map((cell) => textOf(cell).replace(/\s+/gu, ' ').trim()).filter(Boolean).join(' / ');
        if (line) rows.push(element('p', [text(line)]));
      } else if (child.tagName !== 'table') {
        visit(child);
      } else {
        rows.push(...tableRows(child, base));
      }
    }
  };
  visit(table);
  return rows;
}

function absolute(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

function textOf(node: Root | Element): string {
  return node.children.map((child) => {
    if (child.type === 'text') return child.value;
    if (child.type === 'element') return DROPPED.has(child.tagName) ? '' : textOf(child);
    return '';
  }).join('');
}

function element(tagName: string, children: ElementContent[], properties: Element['properties'] = {}): Element {
  return { type: 'element', tagName, properties, children };
}

function text(value: string): ElementContent {
  return { type: 'text', value };
}
