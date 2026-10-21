import { CollectorError } from '../../core/types.js';

/** One YouTube video: its 11-character ID and its canonical watch address. */
export interface YouTubeVideoRef {
  videoId: string;
  canonicalUrl: string;
}

/** What a single pasted YouTube address asks for. Shared by the UI button label and the HTTP entry point. */
export type YouTubeInput =
  | { kind: 'video'; video: YouTubeVideoRef }
  | { kind: 'channel'; url: string };

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const HANDLE_PATTERN = /^@[\p{L}\p{N}._-]{1,100}$/u;
const YOUTUBE_HOST = /(^|\.)youtube\.com$/u;

/** The canonical watch address of a video. */
export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Whether an input is a YouTube address or an @handle, judged by its syntax alone. */
export function ownsYouTubeInput(input: string, url: URL | null): boolean {
  if (input.startsWith('@')) return true;
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return YOUTUBE_HOST.test(host) || host === 'youtu.be';
}

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
    canonicalUrl: videoUrl(videoId),
  };
}

/**
 * Classifies a video or channel address by its syntax alone. A watch URL that also names a
 * playlist is the single video; a playlist-only URL is unsupported. Nothing here contacts YouTube.
 */
export function classifyYouTubeInput(input: string): YouTubeInput {
  const trimmed = input.trim();
  if (trimmed === '') throw new CollectorError('invalid_url', '請輸入 YouTube 影片網址、頻道網址或 @handle。');
  if (trimmed.startsWith('@')) {
    if (!HANDLE_PATTERN.test(trimmed)) throw new CollectorError('invalid_url', '這個 @handle 格式無法辨識。');
    return { kind: 'channel', url: `https://www.youtube.com/${trimmed}` };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CollectorError('invalid_url', '請輸入有效的 YouTube 影片網址、頻道網址或 @handle。');
  }
  const host = url.hostname.toLowerCase();
  const youtube = host === 'youtube.com' || host.endsWith('.youtube.com');
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || (!youtube && host !== 'youtu.be')) {
    throw new CollectorError('invalid_url', '這不是 YouTube 網址。');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const first = parts[0] ?? '';
  // An embedded playlist's path segment is 11 characters long and would otherwise read as a video ID.
  if (youtube && first === 'embed' && parts[1] === 'videoseries') {
    throw new CollectorError('unsupported_url', '目前不支援播放清單網址；請貼上清單中的單支影片網址。');
  }

  try {
    return { kind: 'video', video: parseYouTubeVideoUrl(trimmed) };
  } catch {
    // Not a video address; it may still be a playlist or a channel.
  }

  if (youtube && (first === 'playlist' || (first === 'watch' && url.searchParams.has('list')))) {
    throw new CollectorError('unsupported_url', '目前不支援播放清單網址；請貼上清單中的單支影片網址。');
  }
  if (youtube && HANDLE_PATTERN.test(decodeURIComponent(first))) {
    return { kind: 'channel', url: `https://www.youtube.com/${first}` };
  }
  if (youtube && ['channel', 'c', 'user'].includes(first) && parts[1]) {
    return { kind: 'channel', url: `https://www.youtube.com/${first}/${parts[1]}` };
  }
  throw new CollectorError('invalid_url', '這個網址不包含可辨識的 YouTube 影片或頻道。');
}
