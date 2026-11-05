// Which addresses count as one YouTube video: watch, youtu.be, shorts and live links normalize to
// one canonical watch URL, and other sites, channels and look-alike hosts are refused.
import { describe, expect, it } from 'vitest';
import { CollectorError } from '../../../src/core/collector-error.js';
import { parseYouTubeVideoUrl } from '../../../src/plugins/youtube/url.js';

describe('parseYouTubeVideoUrl', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=12',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ])('normalizes %s', (input) => {
    expect(parseYouTubeVideoUrl(input)).toEqual({
      videoId: 'dQw4w9WgXcQ',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
  });

  it.each([
    '',
    'not a url',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/@channel',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
  ])('rejects %s', (input) => {
    expect(() => parseYouTubeVideoUrl(input)).toThrowError(CollectorError);
  });
});
