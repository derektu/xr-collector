const PARAGRAPH_TARGET_LENGTH = 180;
const PARAGRAPH_MAX_LENGTH = 360;
const SENTENCE_END = /[。！？.!?][」』”’）)]?$/u;

export function formatTranscriptSegments(segments: string[]): string {
  const paragraphs: string[] = [];
  let paragraph = '';

  for (const segment of segments) {
    const text = segment.replace(/\s+/gu, ' ').trim();
    if (!text) continue;

    const candidate = paragraph ? `${paragraph} ${text}` : text;
    if (paragraph && candidate.length > PARAGRAPH_MAX_LENGTH) {
      paragraphs.push(paragraph);
      paragraph = text;
    } else {
      paragraph = candidate;
    }

    if (paragraph.length >= PARAGRAPH_TARGET_LENGTH && SENTENCE_END.test(text)) {
      paragraphs.push(paragraph);
      paragraph = '';
    }
  }

  if (paragraph) paragraphs.push(paragraph);
  return paragraphs.map(escapeMarkdownText).join('\n\n');
}

/**
 * Subtitle text is plain text; escaping Markdown syntax keeps characters such as `28*28` or a
 * leading `#` literal when the body is rendered as Markdown.
 */
export function escapeMarkdownText(text: string): string {
  return text
    .replace(/[\\`*_[\]<>~|]/gu, (character) => `\\${character}`)
    .replace(/^(\s*)([#+-]|\d+[.)])(?=\s|$)/u, (_match, space: string, marker: string) => `${space}${marker.replace(/([#+\-.)])$/u, '\\$1')}`);
}
