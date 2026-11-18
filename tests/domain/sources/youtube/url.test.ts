// Telling what a pasted YouTube input is: one video (playlist parameters dropped), a channel by
// handle or address, a playlist, refused as unsupported, or an invalid address. Watch, youtu.be,
// shorts and live links of one video normalize to one canonical watch URL, and other sites,
// channels and look-alike hosts are refused as a video.
import { describe, expect, it } from 'vitest';
import { CollectorError } from '../../../../src/shared/lib/collector-error.js';
import { classifyYouTubeInput, parseYouTubeVideoUrl } from '../../../../src/domain/sources/youtube/url.js';

describe('classifyYouTubeInput', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=12', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&index=3', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('treats %s as one video', (input, id) => {
    expect(classifyYouTubeInput(input)).toEqual({
      kind: 'video', video: { videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` },
    });
  });

  it.each([
    ['@3blue1brown', 'https://www.youtube.com/@3blue1brown'],
    [' https://www.youtube.com/@3blue1brown/videos ', 'https://www.youtube.com/@3blue1brown'],
    ['https://youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw/featured', 'https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw'],
    ['http://www.youtube.com/c/sample', 'https://www.youtube.com/c/sample'],
    ['https://www.youtube.com/user/older', 'https://www.youtube.com/user/older'],
  ])('treats %s as a channel', (input, url) => {
    expect(classifyYouTubeInput(input)).toEqual({ kind: 'channel', url });
  });

  it.each([
    'https://www.youtube.com/playlist?list=PLabc',
    'https://www.youtube.com/watch?list=PLabc',
    'https://www.youtube.com/embed/videoseries?list=PLabc',
  ])('reports %s as an unsupported playlist', (input) => {
    expect(() => classifyYouTubeInput(input)).toThrowError(expect.objectContaining({ code: 'unsupported_url' }));
  });

  it.each(['', 'not a url', '@', 'https://example.com/@sample', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/feed/trending'])(
    'rejects %s',
    (input) => {
      expect(() => classifyYouTubeInput(input)).toThrowError(expect.objectContaining({ code: 'invalid_url' }));
    },
  );
});

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
