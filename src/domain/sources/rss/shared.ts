import { CollectorError } from '../../../shared/lib/collector-error.js';
import type { SourcePluginDeclaration } from '../../../shared/sources/source-contract.js';
import { RSS_SETTINGS, type RssSettings } from './settings.js';

export const ARTICLE_KEY_PATTERN = /^[0-9a-f]{16}$/u;

function isWebAddress(url: URL | null): url is URL {
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:');
}

export const rssDeclaration: SourcePluginDeclaration<RssSettings> = {
  id: 'rss',
  label: 'RSS',
  icon: 'rss',
  kinds: [{ id: 'feed', label: 'RSS', capability: 'subscription', itemNoun: '文章' }],
  requiresLogin: false,
  settings: RSS_SETTINGS.fields,
  item: {
    noun: '文章',
    measureWord: '篇',
    keyPattern: ARTICLE_KEY_PATTERN,
    documentType: 'Article',
    openOriginalLabel: '開啟原始文章',
  },
  subscription: {
    targetNoun: '網站',
    ...RSS_SETTINGS.subscription,
  },
  jobKindNames: { item: 'article', check: 'feed', add: 'feed-add' },
  failureLabels: {
    network_error: '網路錯誤', rate_limited: '網站限制連線', feed_not_found: '找不到 feed', feed_invalid: 'feed 格式錯誤',
    feed_unavailable: '無法讀取 feed', article_missing: '文章已不在 feed',
  },
  documentDetailLine: (document) => document.contentExtent === 'summary' ? '只有摘要' : null,
  prompts: {
    anyInputHint: '請輸入 RSS feed 或網站網址。',
    itemInputHint: 'RSS 文章只能透過訂閱收集。',
    subscriptionInputHint: '請輸入 RSS feed 或網站網址。',
    itemPlaceholder: '',
    subscriptionPlaceholder: '貼上 RSS feed 或網站網址',
    itemCardText: '',
  },
  owns: (_input, url) => isWebAddress(url),
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
