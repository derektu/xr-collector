import { createHash } from 'node:crypto';
import { CollectorError } from '../../core/types.js';
import type {
  FailureClass,
  ListedItem,
  PluginRuntime,
  RequestContext,
  SourceDefinition,
  SourcePlugin,
  SubscriptionTarget,
} from '../types.js';
import { findFeedLinks } from './discovery.js';
import { type Feed, type FeedEntry, looksLikeFeed, parseFeed } from './feed.js';
import { htmlToMarkdown } from './html.js';
import { fetchText, type FetchedText } from './http.js';
import type { RssSettings } from './settings.js';
import { rssDeclaration } from './shared.js';

// A site's limit fails the check like any refusal of that site, so a feed that keeps limiting
// counts toward its subscription's failures and other feeds go on.
const FAILURES: Readonly<Record<string, FailureClass>> = {
  network_error: 'retry_now',
  rate_limited: 'retry_next_check',
  feed_not_found: 'retry_next_check',
  feed_invalid: 'retry_next_check',
  feed_unavailable: 'retry_next_check',
  article_missing: 'retry_next_check',
};

/**
 * The server definition of RSS: the declaration, how its failures are treated, the request pacing
 * every feed shares (spacing only: each feed is a different site, so a limit cools nothing down),
 * where its subscriptions live and its documents' frontmatter, which has no RSS-specific fields. RSS
 * needs version 2 of the Vault and package formats.
 */
export const rssDefinition: SourceDefinition<RssSettings> = {
  ...rssDeclaration,
  classifyFailure: (error) => FAILURES[error.code] ?? 'skip',
  pacing: {
    group: 'rss',
    label: 'RSS',
    waitRangeMs: { min: 1_000, max: 3_000 },
    envVar: 'XR_COLLECTOR_RSS_WAIT_MS',
    cooldown: false,
  },
  storage: {
    subscriptionsFile: 'settings/rss-subscriptions.json',
    version: 2,
    listKey: 'subscriptions',
    outOfRangeKeyField: 'articleKey',
    description: 'RSS subscription',
  },
  vaultFormatVersion: 2,
  packageFormatVersion: 2,
  errorStatus: { feed_not_found: 422, feed_invalid: 422, feed_unavailable: 502, article_missing: 422 },
  frontmatter: {
    write: () => ({}),
    read: () => null,
  },
};

/** Fetches a feed or page address for the plugin, in the turn the request context asks for. */
export type FeedFetcher = (url: string, context: RequestContext) => Promise<FetchedText>;

/** How long a read feed answers captures before it is read again. */
export const FEED_CACHE_MS = 10 * 60_000;

/** The first 16 hexadecimal digits of the SHA-256 of `value`. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** The subscription ID of a feed: a hash of its address. */
export function subscriptionId(feedUrl: string): string {
  return shortHash(feedUrl);
}

/** An article's key: a hash of its subscription and its identity in the feed. */
export function articleKey(subscription: string, entry: Pick<FeedEntry, 'identity'>): string {
  return shortHash(`${subscription}\n${entry.identity}`);
}

interface ReadFeed {
  feed: Feed;
  at: number;
  entries: Map<string, FeedEntry>;
}

/**
 * The RSS plugin over a fetcher. A subscription's articles come from its feed: listing reads the
 * feed, and a capture takes the article from the feed read last, reading the feed again when that
 * read is older than `FEED_CACHE_MS` or lacks the article. An article the feed no longer lists fails
 * with `article_missing`.
 */
export function rssPlugin(fetcher: FeedFetcher, options: { now?: () => number } = {}): SourcePlugin<RssSettings> {
  const now = options.now ?? Date.now;
  const read = new Map<string, ReadFeed>();
  const reading = new Map<string, Promise<ReadFeed>>();

  const remember = (id: string, feed: Feed): ReadFeed => {
    const entries = new Map(feed.entries.map((entry) => [articleKey(id, entry), entry]));
    const value = { feed, at: now(), entries };
    // Reads past their age are dropped, so the reads kept are those of feeds in use.
    for (const [kept, earlier] of read) if (value.at - earlier.at > FEED_CACHE_MS) read.delete(kept);
    read.set(id, value);
    return value;
  };

  const readFeed = (target: SubscriptionTarget, context: RequestContext): Promise<ReadFeed> => {
    const running = reading.get(target.id);
    if (running) return running;
    const work = (async () => {
      const fetched = await fetcher(target.url, context);
      return remember(target.id, parseFeed(fetched.text, fetched.url));
    })().finally(() => reading.delete(target.id));
    reading.set(target.id, work);
    return work;
  };

  return {
    ...rssDefinition,

    async resolveTarget(url, context) {
      let fetched = await fetcher(url, context);
      if (!looksLikeFeed(fetched.text)) {
        const announced = findFeedLinks(fetched.text, fetched.url)[0];
        if (!announced) throw new CollectorError('invalid_subscription', '這個網址沒有 RSS feed。');
        fetched = await fetcher(announced, context);
        if (!looksLikeFeed(fetched.text)) throw new CollectorError('invalid_subscription', '這個網址沒有 RSS feed。');
      }
      const feed = parseFeed(fetched.text, fetched.url);
      const id = subscriptionId(fetched.url);
      remember(id, feed);
      return { id, title: feed.title, url: fetched.url };
    },

    async *listSubscriptionItems(target, context) {
      const { feed } = await readFeed(target, context);
      for (const entry of feed.entries) {
        const item: ListedItem = {
          key: articleKey(target.id, entry), url: entry.link ?? target.url, title: entry.title || null,
          publishedAt: entry.publishedAt, eligible: true,
        };
        yield item;
      }
    },

    async captureItem(ref, context) {
      const target = context.subscription;
      if (!target) throw new CollectorError('invalid_url', 'RSS 文章只能透過訂閱收集。');
      const cached = read.get(target.id);
      const current = cached && now() - cached.at < FEED_CACHE_MS && cached.entries.has(ref.key) ? cached : await readFeed(target, context);
      const entry = current.entries.get(ref.key);
      if (!entry) throw new CollectorError('article_missing', '這篇文章已不在 feed 中。');
      if (context.publishedNotBefore && entry.publishedAt && entry.publishedAt < context.publishedNotBefore) {
        throw new CollectorError('out_of_range', '這篇文章的發布時間早於收集範圍。');
      }
      return {
        key: ref.key,
        sourceUrl: entry.link ?? target.url,
        title: entry.title || '無標題',
        publisher: { id: target.id, name: current.feed.title },
        publishedAt: entry.publishedAt,
        bodyMarkdown: await htmlToMarkdown(entry.html, entry.base),
        contentExtent: entry.extent,
        details: null,
      };
    },
  };
}

/** The RSS plugin of the product: every feed and page request goes through the `rss` request channel. */
export function createRssPlugin(runtime: PluginRuntime): SourcePlugin<RssSettings> {
  const gate = runtime.gate(rssDefinition.pacing!.group);
  return rssPlugin((url, context) =>
    gate.run(context.priority ?? 'background', () => fetchText(url, context.signal), context.signal));
}
