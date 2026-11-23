const EXCERPT_LENGTH = 160;

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

export function documentExcerpt(bodyMarkdown: string): string {
  const text = markdownToPlainText(bodyMarkdown);
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH).trimEnd()}…` : text;
}
