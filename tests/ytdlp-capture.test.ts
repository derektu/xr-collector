import { describe, expect, it } from 'vitest';
import { CollectorError } from '../src/core/types.js';
import { classifyYtDlpError, parseJson3Transcript } from '../src/capture/ytdlp-capture.js';

describe('parseJson3Transcript', () => {
  it('extracts subtitle text and preserves legitimate repetitions', () => {
    const result = parseJson3Transcript(JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: '重要提醒' }] },
        { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: '重要提醒' }] },
      ],
    }));
    expect(result).toEqual(['重要提醒', '重要提醒']);
  });

  it('joins segmented text and skips empty events', () => {
    const result = parseJson3Transcript(JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: '今天' }, { utf8: '\n來看市場' }] },
        { tStartMs: 20, segs: [] },
      ],
    }));
    expect(result).toEqual(['今天 來看市場']);
  });

  it('reports invalid subtitle JSON as capture failure', () => {
    expect(() => parseJson3Transcript('{')).toThrowError(
      expect.objectContaining<Partial<CollectorError>>({ code: 'capture_failed' }),
    );
  });
});

describe('classifyYtDlpError', () => {
  it('maps yt-dlp unavailable wording to a user-facing unavailable result', () => {
    const result = classifyYtDlpError(
      new Error('Command failed'),
      'ERROR: [youtube] aaaaaaaaaaa: This video is unavailable',
    );
    expect(result.code).toBe('video_unavailable');
  });
});
