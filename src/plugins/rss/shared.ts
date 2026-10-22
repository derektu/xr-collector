import { sourceDeclarations } from '../../core/source-registry.js';
import { CollectorError } from '../../core/types.js';
import type { SourcePluginDeclaration } from '../types.js';
import {
  DEFAULT_SETTINGS,
  describeSettings,
  isRssSettings,
  parseSettingsPatch,
  type RssSettings,
  SETTING_FIELDS,
  windowStart,
} from './settings.js';

/** An article key: 16 hexadecimal digits of a hash of the subscription and the article's identity. */
export const ARTICLE_KEY_PATTERN = /^[0-9a-f]{16}$/u;

/** An http(s) address, the only kind a feed or a site that announces one can have. */
function isWebAddress(url: URL | null): url is URL {
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:');
}

/**
 * RSS and Atom feeds as a source type: subscriptions only, to a feed address or to a site whose
 * pages announce a feed. A feed's address has no fixed form, so RSS owns every web address no other
 * registered type owns, and resolving the subscription decides whether a feed is there. Articles have
 * no address of their own to collect from: an article is collected from the feed that lists it.
 */
export const rssDeclaration: SourcePluginDeclaration<RssSettings> = {
  id: 'rss',
  label: 'RSS',
  icon: 'rss',
  kinds: [{ id: 'feed', label: 'RSS', capability: 'subscription', itemNoun: '文章' }],
  requiresLogin: false,
  settings: SETTING_FIELDS,
  item: {
    noun: '文章',
    measure: '篇',
    keyPattern: ARTICLE_KEY_PATTERN,
    documentType: 'Article',
    openOriginalLabel: '開啟原始文章',
  },
  subscription: {
    targetNoun: '網站',
    defaults: DEFAULT_SETTINGS,
    isValidSettings: isRssSettings,
    parseSettingsPatch,
    describeSettings,
    checkRange: (settings, now) => ({ since: windowStart(now, settings.backfillWindow), maxItems: settings.backfillMaxItems }),
    sentence: ['收集最近', { field: 'backfillWindow' }, '內最新的', { field: 'backfillMaxItems' }],
  },
  jobKindNames: { item: 'article', check: 'feed', add: 'feed-add' },
  phaseLabels: { capture: '讀取文章' },
  failureLabels: {
    network_error: '網路錯誤', rate_limited: '網站限制連線', feed_not_found: '找不到 feed', feed_invalid: 'feed 格式錯誤',
    feed_unavailable: '無法讀取 feed', article_missing: '文章已不在 feed',
  },
  documentDetailLine: (document) => document.contentExtent === 'summary' ? '只有摘要' : null,
  prompts: {
    anyInput: '請輸入 RSS feed 或網站網址。',
    itemInput: 'RSS 文章只能透過訂閱收集。',
    subscriptionInput: '請輸入 RSS feed 或網站網址。',
    itemPlaceholder: '',
    subscriptionPlaceholder: '貼上 RSS feed 或網站網址',
    itemCard: '',
  },
  owns: (input, url) => isWebAddress(url)
    && !sourceDeclarations().some((declaration) => declaration.id !== 'rss' && declaration.owns(input, url)),
  classify(input) {
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      throw new CollectorError('invalid_url', '請輸入有效的網址。');
    }
    if (!isWebAddress(url)) throw new CollectorError('unsupported_url', '只支援 http 或 https 網址。');
    url.hash = '';
    return { kind: 'subscription', url: url.href };
  },
  parseItem() {
    throw new CollectorError('invalid_url', 'RSS 文章只能透過訂閱收集。');
  },
};
