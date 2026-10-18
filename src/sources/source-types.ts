import { BACKFILL_LIMITS, BACKFILL_WINDOWS, DEFAULT_POLICY, INTERVAL_OPTIONS, intervalLabel, windowLabel } from '../channels/collection-policy.js';
import {
  CollectorError,
  type ChannelPreview,
  type SourceTypeInfo,
  type UrlRecognition,
} from '../core/types.js';
import { classifyYouTubeInput } from './youtube/url.js';

/** Services a source type may call while recognizing an address. */
export interface RecognitionContext {
  /** Resolves a channel address and reports its subscription state and the settings it uses or would start with. */
  previewChannel(url: string): Promise<ChannelPreview>;
}

/**
 * A source type: the addresses it owns, what it can collect and the settings its subscriptions use.
 * The Sources page, its filters and the Add dialog are built from these declarations, so a new type
 * needs only a new declaration and the APIs its actions call.
 */
export interface SourceTypeDeclaration extends SourceTypeInfo {
  /** Whether the input belongs to this type; decided by syntax alone. */
  owns(input: string, url: URL | null): boolean;
  /** What an owned address is and what can be done with it. Not called when the type requires login. */
  recognize(input: string, context: RecognitionContext): Promise<UrlRecognition>;
}

const YOUTUBE_HOST = /(^|\.)youtube\.com$/u;

export const youtubeSourceType: SourceTypeDeclaration = {
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
  owns(input, url) {
    if (input.startsWith('@')) return true;
    if (!url) return false;
    const host = url.hostname.toLowerCase();
    return YOUTUBE_HOST.test(host) || host === 'youtu.be';
  },
  async recognize(input, context) {
    let classified;
    try {
      classified = classifyYouTubeInput(input);
    } catch (error) {
      if (error instanceof CollectorError) return unsupported(input, error.message, 'youtube');
      throw error;
    }
    if (classified.kind === 'video') {
      const { video } = classified;
      return {
        ...base('ready', classified.video.canonicalUrl),
        sourceType: 'youtube', kind: 'video', kindLabel: 'YouTube 影片',
        target: { id: video.videoId, title: null, url: video.canonicalUrl },
        actions: [{
          id: 'collect', label: '收集影片', primary: true,
          request: { method: 'POST', path: '/api/youtube/collect', body: { url: video.canonicalUrl } },
        }],
      };
    }
    let preview: ChannelPreview;
    try {
      preview = await context.previewChannel(classified.url);
    } catch (error) {
      if (error instanceof CollectorError) {
        return { ...base('unavailable', classified.url), sourceType: 'youtube', kind: 'channel', kindLabel: 'YouTube 頻道', message: error.message };
      }
      throw error;
    }
    const { channel, subscription } = preview;
    const actions: UrlRecognition['actions'] = !subscription
      ? [{ id: 'subscribe', label: '訂閱頻道', primary: true, request: { method: 'POST', path: '/api/youtube/channels', body: { url: channel.url } } }]
      : !subscription.enabled
        ? [{ id: 'resume', label: '恢復訂閱', primary: true, request: { method: 'PATCH', path: `/api/youtube/channels/${encodeURIComponent(channel.id)}`, body: { enabled: true } } }]
        : [];
    return {
      ...base('ready', channel.url),
      sourceType: 'youtube', kind: 'channel', kindLabel: 'YouTube 頻道',
      target: { id: channel.id, title: channel.title, url: channel.url },
      subscription: subscription ? { id: channel.id, enabled: subscription.enabled, settings: subscription.settings } : null,
      settings: DEFAULT_POLICY,
      autoCollection: preview.autoCollection,
      actions,
    };
  },
};

/** Every source type the product offers, in display order. */
export const SOURCE_TYPES: SourceTypeDeclaration[] = [youtubeSourceType];

/** The serializable part of a declaration that `GET /api/source-types` returns. */
export function sourceTypeInfo(declaration: SourceTypeDeclaration): SourceTypeInfo {
  const { id, label, icon, kinds, requiresLogin, settings } = declaration;
  return { id, label, icon, kinds, requiresLogin, settings };
}

/**
 * Recognizes a pasted address with the first declaration that owns it. Addresses no type owns are
 * `unsupported`; a type that requires login answers `login_required` without contacting the source.
 */
export async function recognizeUrl(input: string, declarations: SourceTypeDeclaration[], context: RecognitionContext): Promise<UrlRecognition> {
  let trimmed = input.trim();
  let url = absoluteUrl(trimmed);
  let owner = declarations.find((declaration) => declaration.owns(trimmed, url));
  if (!owner && !url) {
    // Addresses are often copied without their scheme (youtube.com/watch?v=…). Such an input is
    // read as https:// only when a type owns the result; any other bare string stays unsupported.
    const withScheme = `https://${trimmed}`;
    const candidate = /^[^\s/@:]+\.[^\s/]+(\/\S*)?$/u.test(trimmed) ? absoluteUrl(withScheme) : null;
    const candidateOwner = candidate ? declarations.find((declaration) => declaration.owns(withScheme, candidate)) : undefined;
    if (candidate && candidateOwner) { trimmed = withScheme; url = candidate; owner = candidateOwner; }
  }
  if (!owner) {
    return unsupported(trimmed, url ? '目前還不支援這個網站的網址。' : '請貼上完整網址，例如 https:// 開頭的網址。', null);
  }
  if (owner.requiresLogin) {
    return {
      ...base('login_required', trimmed),
      sourceType: owner.id,
      login: { sourceType: owner.id, label: owner.label, message: `需要先登入 ${owner.label} 才能收集這個網址的內容。` },
    };
  }
  return owner.recognize(trimmed, context);
}

function absoluteUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    // Not an absolute URL; a type may still own it, such as a YouTube @handle.
    return null;
  }
}

function base(status: UrlRecognition['status'], url: string): UrlRecognition {
  return {
    status, sourceType: null, kind: null, kindLabel: null, url, target: null,
    subscription: null, settings: null, autoCollection: null, actions: [], login: null, message: null,
  };
}

function unsupported(url: string, message: string, sourceType: UrlRecognition['sourceType']): UrlRecognition {
  return { ...base('unsupported', url), sourceType, message };
}
