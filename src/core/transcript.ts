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
  return paragraphs.join('\n\n');
}
