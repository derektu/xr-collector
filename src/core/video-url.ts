import { CollectorError, type YouTubeVideoRef } from './types.js';

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeVideoUrl(input: string): YouTubeVideoRef {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CollectorError('invalid_url', '請輸入有效的 YouTube 影片網址。');
  }

  const host = url.hostname.toLowerCase();
  let videoId: string | null = null;

  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v');
    } else {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') {
        videoId = parts[1] ?? null;
      }
    }
  }

  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
    throw new CollectorError('invalid_url', '這個網址不包含可辨識的 YouTube 影片 ID。');
  }

  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}
