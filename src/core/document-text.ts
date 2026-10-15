const EXCERPT_LENGTH = 160;

/** Reduces Markdown to readable plain text for list excerpts and search snippets. */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/(?<!\\)(\*\*|__|\*|_|~~|`)/gu, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The opening of a document body as plain text, cut at a fixed length. */
export function documentExcerpt(bodyMarkdown: string): string {
  const text = markdownToPlainText(bodyMarkdown);
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH).trimEnd()}…` : text;
}
