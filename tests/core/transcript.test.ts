import { describe, expect, it } from 'vitest';
import { documentExcerpt } from '../../src/core/document-text.js';
import { formatTranscriptSegments } from '../../src/core/transcript.js';

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

  it('keeps Markdown syntax in subtitle text literal', () => {
    expect(formatTranscriptSegments(['# 不是標題', '一張 28*28 的圖', '用 [括號] 與 <b> 與 snake_case'])).toBe(
      '\\# 不是標題 一張 28\\*28 的圖 用 \\[括號\\] 與 \\<b\\> 與 snake\\_case',
    );
    expect(formatTranscriptSegments(['1. 第一點'])).toBe('1\\. 第一點');
  });

  it('turns escaped subtitle text back into the original words for excerpts', () => {
    const body = formatTranscriptSegments(['# 一張 28*28 的圖', '[括號] snake_case']);
    expect(documentExcerpt(body)).toBe('# 一張 28*28 的圖 [括號] snake_case');
  });
});

