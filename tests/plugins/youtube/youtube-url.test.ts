import { describe, expect, it } from 'vitest';
import { classifyYouTubeInput } from '../../../src/plugins/youtube/url.js';

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
