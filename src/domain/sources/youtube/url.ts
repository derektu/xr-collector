import { CollectorError } from '../../../shared/lib/collector-error.js';

export interface YouTubeVideoRef {
  videoId: string;
  canonicalUrl: string;
}

export type YouTubeInput =
  | { kind: 'video'; video: YouTubeVideoRef }
  | { kind: 'channel'; url: string };

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const HANDLE_PATTERN = /^@[\p{L}\p{N}._-]{1,100}$/u;
const YOUTUBE_HOST = /(^|\.)youtube\.com$/u;

export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function ownsYouTubeInput(input: string, url: URL | null): boolean {
  if (input.startsWith('@')) return true;
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return YOUTUBE_HOST.test(host) || host === 'youtu.be';
}

function tryParseYouTubeVideoUrl(input: string): YouTubeVideoRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const videoId = videoIdFromUrl(url);
  return videoId ? { videoId, canonicalUrl: videoUrl(videoId) } : null;
}

export function parseYouTubeVideoUrl(input: string): YouTubeVideoRef {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CollectorError('invalid_url', '請輸入有效的 YouTube 影片網址。');
  }
  const videoId = videoIdFromUrl(url);
  if (!videoId) {
    throw new CollectorError('invalid_url', '這個網址不包含可辨識的 YouTube 影片 ID。');
  }
  return { videoId, canonicalUrl: videoUrl(videoId) };
}

function videoIdFromUrl(url: URL): string | null {
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

  return videoId && VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
}

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
  if (youtube && first === 'embed' && parts[1] === 'videoseries') {
    throw new CollectorError('unsupported_url', '目前不支援播放清單網址；請貼上清單中的單支影片網址。');
  }

  const video = tryParseYouTubeVideoUrl(trimmed);
  if (video) return { kind: 'video', video };

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
