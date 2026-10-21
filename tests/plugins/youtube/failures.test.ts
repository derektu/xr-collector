import { describe, expect, it } from 'vitest';
import { youtubeDeclaration } from '../../../src/plugins/youtube/shared.js';
import { youtubeDefinition } from '../../../src/plugins/youtube/server.js';

describe('YouTube failures (N69-T10)', () => {
  it('classifies each capture error for checks and names it in short words', () => {
    const classes = Object.fromEntries(['network_error', 'rate_limited', 'no_subtitles', 'capture_failed', 'video_unavailable', 'unknown_code']
      .map((code) => [code, youtubeDefinition.classifyFailure({ code })]));
    expect(classes).toEqual({
      network_error: 'retry_now', rate_limited: 'rate_limited', no_subtitles: 'retry_next_check', capture_failed: 'retry_next_check',
      video_unavailable: 'skip', unknown_code: 'skip',
    });
    expect(youtubeDeclaration.failureLabels).toMatchObject({
      no_subtitles: '沒有字幕', video_unavailable: '影片不存在', network_error: '網路錯誤', capture_failed: '收集失敗',
    });
  });
});
