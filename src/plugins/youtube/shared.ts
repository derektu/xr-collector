import { intervalLabel } from '../../core/check-interval.js';
import type { SourcePluginDeclaration } from '../types.js';
import type { SubtitleKind } from './adapter.js';
import {
  BACKFILL_LIMITS,
  BACKFILL_WINDOWS,
  backfillPhrase,
  backfillWindowStart,
  type CollectionPolicy,
  DEFAULT_POLICY,
  INTERVAL_OPTIONS,
  isCollectionPolicy,
  parsePolicyPatch,
  windowLabel,
} from './settings.js';
import { classifyYouTubeInput, ownsYouTubeInput, parseYouTubeVideoUrl, VIDEO_ID_PATTERN, videoUrl } from './url.js';

/** Subtitle details that only YouTube transcripts carry. */
export interface YouTubeDocumentMetadata {
  languageCode: string;
  languageName: string | null;
  subtitleKind: SubtitleKind;
}

declare module '../../core/types.js' {
  interface DocumentDetails {
    /** Subtitle details of a YouTube transcript. */
    youtube?: YouTubeDocumentMetadata;
  }
}

/** The subtitle a YouTube document was made from, e.g. "字幕：中文（台灣）・人工字幕". */
export function subtitleLine(details: YouTubeDocumentMetadata | undefined): string | null {
  if (!details) return null;
  const language = details.languageName ?? details.languageCode;
  return `字幕：${language}・${details.subtitleKind === 'manual' ? '人工字幕' : '自動字幕'}`;
}

/**
 * YouTube as a source type: single videos by their watch address, and channels by address or
 * @handle as subscriptions. Every name and label the UI shows for YouTube comes from here.
 */
export const youtubeDeclaration: SourcePluginDeclaration<CollectionPolicy> = {
  id: 'youtube',
  label: 'YouTube',
  icon: 'youtube',
  kinds: [
    { id: 'video', label: 'YouTube 影片', capability: 'single', itemNoun: '影片' },
    { id: 'channel', label: 'YouTube 頻道', capability: 'subscription', itemNoun: '影片' },
  ],
  requiresLogin: false,
  settings: [
    {
      key: 'intervalMinutes', label: '檢查頻率', default: DEFAULT_POLICY.intervalMinutes,
      options: INTERVAL_OPTIONS.map((value) => ({ value, label: intervalLabel(value) })),
    },
    {
      key: 'backfillWindow', label: '時間範圍', default: DEFAULT_POLICY.backfillWindow,
      options: BACKFILL_WINDOWS.map((value) => ({ value, label: windowLabel(value) })),
    },
    {
      key: 'backfillMaxItems', label: '數量上限', default: DEFAULT_POLICY.backfillMaxItems,
      options: BACKFILL_LIMITS.map((value) => ({ value, label: `${value} 支影片` })),
    },
  ],
  item: {
    noun: '影片',
    measure: '支',
    keyPattern: VIDEO_ID_PATTERN,
    documentType: 'Transcript',
    urlForKey: videoUrl,
    openOriginalLabel: '開啟原始影片',
  },
  subscription: {
    targetNoun: '頻道',
    defaults: DEFAULT_POLICY,
    isValidSettings: isCollectionPolicy,
    parseSettingsPatch: parsePolicyPatch,
    describeSettings: backfillPhrase,
    checkRange: (settings, now) => ({ since: backfillWindowStart(now, settings.backfillWindow), maxItems: settings.backfillMaxItems }),
    sentence: ['收集最近', { field: 'backfillWindow' }, '內最新的', { field: 'backfillMaxItems' }],
  },
  jobKindNames: { item: 'video', check: 'channel', add: 'channel-add' },
  phaseLabels: { capture: '擷取字幕' },
  failureLabels: {
    no_subtitles: '沒有字幕', video_unavailable: '影片不存在', network_error: '網路錯誤', capture_failed: '收集失敗', rate_limited: 'YouTube 限制連線',
  },
  documentDetailLine: (document) => subtitleLine(document.youtube),
  prompts: {
    anyInput: '請輸入 YouTube 影片網址、頻道網址或 @handle。',
    itemInput: '請輸入 YouTube 影片網址。',
    subscriptionInput: '請輸入 YouTube 頻道網址或 @handle。',
    itemPlaceholder: '貼上 YouTube 影片網址',
    subscriptionPlaceholder: '貼上 YouTube 頻道網址或 @handle',
    itemCard: '收集這支影片的字幕，加入知識庫。',
  },
  owns: ownsYouTubeInput,
  classify(input) {
    const classified = classifyYouTubeInput(input);
    return classified.kind === 'video'
      ? { kind: 'item', ref: { key: classified.video.videoId, url: classified.video.canonicalUrl, title: null } }
      : { kind: 'subscription', url: classified.url };
  },
  parseItem(url) {
    const video = parseYouTubeVideoUrl(url);
    return { key: video.videoId, url: video.canonicalUrl, title: null };
  },
};
