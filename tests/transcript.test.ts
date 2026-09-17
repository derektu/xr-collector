import { describe, expect, it } from 'vitest';
import { formatTranscriptSegments } from '../src/core/transcript.js';

describe('formatTranscriptSegments', () => {
  it('normalizes whitespace and preserves repeated text', () => {
    expect(formatTranscriptSegments([
      '  第一段\n字幕  ',
      '重複內容',
      '重複內容',
    ])).toBe('第一段 字幕 重複內容 重複內容');
  });

  it('creates paragraphs without adding or rewriting words', () => {
    const opening = `${'這是一段完整字幕內容'.repeat(20)}。`;
    expect(formatTranscriptSegments([
      opening,
      '下一段內容',
    ])).toBe(`${opening}\n\n下一段內容`);
  });
});
