import { CollectorError, type SubscriptionSettings } from '../../src/core/types.js';
import type { PacingGate } from '../../src/pacing/pacing-gate.js';
import type {
  CapturedItem,
  FailureClass,
  ItemRef,
  ListedItem,
  RequestContext,
  SourceDefinition,
  SourcePlugin,
  SubscriptionTarget,
} from '../../src/plugins/types.js';

/**
 * Source plugins for tests that hold the core to its contract without YouTube: two types, `fake`
 * and `fake2`, each in its own pacing group, over scripted in-memory sources. Their addresses are
 * `https://<type>.example/item/<key>` for one item and `https://<type>.example/feed/<id>` for a
 * subscription.
 */

const DAY = 24 * 60 * 60_000;

export interface FakeSettings extends SubscriptionSettings {
  intervalMinutes: number;
  windowDays: number;
  maxItems: number;
}

export const FAKE_DEFAULTS: FakeSettings = { intervalMinutes: 60, windowDays: 30, maxItems: 5 };

/** Details a fake document carries under its type's field and writes as `collector.fake_detail`. */
export interface FakeDetails {
  rating: number;
  /** Absent in the file when null. */
  note: string | null;
}

/** One item of a fake feed, newest first. */
export interface FakeItem {
  key: string;
  title: string;
  /** The exact publish time, which a capture confirms. */
  publishedAt: string | null;
  /** The publish time the listing reports, possibly approximate; defaults to `publishedAt`. */
  listedAt?: string | null;
  /** False for an item that cannot be collected yet; a check passes over it. */
  eligible?: boolean;
}

interface FakeFeed extends SubscriptionTarget {
  items: FakeItem[];
}

const FAILURES: Readonly<Record<string, FailureClass>> = {
  network_error: 'retry_now',
  rate_limited: 'rate_limited',
  no_subtitles: 'retry_next_check',
  capture_failed: 'retry_next_check',
  video_unavailable: 'skip',
  login_needed: 'login_required',
};

function isFakeSettings(value: unknown): value is FakeSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return Object.keys(settings).every((key) => key in FAKE_DEFAULTS)
    && ['intervalMinutes', 'windowDays', 'maxItems'].every((key) => Number.isInteger(settings[key]) && (settings[key] as number) > 0);
}

/** The server definition of a fake type; `group` names its pacing group, `formats` the Vault and package format versions it needs (1 by default). */
export function fakeDefinition(type: string, group: string, formats: { vault?: number; package?: number } = {}): SourceDefinition<FakeSettings> {
  const host = `${type}.example`;
  const itemUrl = (key: string) => `https://${host}/item/${key}`;
  const parse = (input: string): URL | null => {
    try { return new URL(input.trim()); } catch { return null; }
  };
  return {
    id: type,
    label: `Fake ${type}`,
    icon: 'file',
    kinds: [
      { id: 'item', label: `${type} 項目`, capability: 'single', itemNoun: '篇' },
      { id: 'feed', label: `${type} 動態`, capability: 'subscription', itemNoun: '篇' },
    ],
    requiresLogin: false,
    settings: [
      { key: 'intervalMinutes', label: '檢查頻率', default: FAKE_DEFAULTS.intervalMinutes, options: [{ value: 15, label: '15 分鐘' }, { value: 60, label: '1 小時' }] },
      { key: 'windowDays', label: '天數', default: FAKE_DEFAULTS.windowDays, options: [{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }] },
      { key: 'maxItems', label: '數量', default: FAKE_DEFAULTS.maxItems, options: [{ value: 3, label: '3 篇' }, { value: 5, label: '5 篇' }] },
    ],
    item: {
      noun: '文章', measure: '篇', keyPattern: /^[a-z0-9-]{3,40}$/u, documentType: 'Article',
      urlForKey: itemUrl, openOriginalLabel: '開啟原始文章',
    },
    subscription: {
      targetNoun: '動態',
      defaults: FAKE_DEFAULTS,
      isValidSettings: isFakeSettings,
      parseSettingsPatch(value, options = {}) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollectorError('invalid_request', '設定格式不正確。');
        const patch = value as Record<string, unknown>;
        const keys = Object.keys(patch);
        if (!keys.length && !options.allowEmpty) throw new CollectorError('invalid_request', '沒有要變更的設定。');
        if (!isFakeSettings({ ...FAKE_DEFAULTS, ...patch })) throw new CollectorError('invalid_request', '設定值不正確。');
        return patch as Partial<FakeSettings>;
      },
      describeSettings: (settings) => `最近 ${settings.windowDays} 天內最新的 ${settings.maxItems} 篇`,
      checkRange: (settings, now) => ({ since: new Date(now.getTime() - settings.windowDays * DAY), maxItems: settings.maxItems }),
    },
    jobKindNames: { item: 'item', check: 'feed', add: 'feed-add' },
    failureLabels: { no_subtitles: '沒有內文', video_unavailable: '文章不存在' },
    prompts: {
      anyInput: `請輸入 ${type} 網址。`, itemInput: `請輸入 ${type} 文章網址。`, subscriptionInput: `請輸入 ${type} 動態網址。`,
      itemPlaceholder: `貼上 ${type} 文章網址`, subscriptionPlaceholder: `貼上 ${type} 動態網址`, itemCard: '收集這篇文章。',
    },
    owns: (_input, url) => url?.hostname === host,
    classify(input) {
      const url = parse(input);
      const [kind, id] = url?.pathname.split('/').filter(Boolean) ?? [];
      if (kind === 'item' && id) return { kind: 'item', ref: { key: id, url: itemUrl(id), title: null } };
      if (kind === 'feed' && id) return { kind: 'subscription', url: `https://${host}/feed/${id}` };
      throw new CollectorError('unsupported_url', `不支援這種 ${type} 網址。`);
    },
    parseItem(input) {
      const url = parse(input);
      const [kind, key] = url?.pathname.split('/').filter(Boolean) ?? [];
      if (url?.hostname !== host || kind !== 'item' || !key) throw new CollectorError('invalid_url', `請輸入 ${type} 文章網址。`);
      return { key, url: itemUrl(key), title: null };
    },
    classifyFailure: (error) => FAILURES[error.code] ?? 'skip',
    vaultFormatVersion: formats.vault ?? 1,
    packageFormatVersion: formats.package ?? 1,
    errorStatus: { feed_gone: 410 },
    pacing: { group, label: `Fake ${group}`, waitRangeMs: { min: 0, max: 0 } },
    storage: {
      subscriptionsFile: `settings/${type}-feeds.json`, version: 1, listKey: 'feeds', outOfRangeKeyField: 'itemKey',
      description: `${type} feed`,
    },
    frontmatter: {
      write(details) {
        const fake = details as unknown as FakeDetails;
        return { fake_detail: fake.note === null ? { rating: fake.rating } : { rating: fake.rating, note: fake.note } };
      },
      read(collector) {
        const stored = collector.fake_detail as { rating?: unknown; note?: unknown } | undefined;
        if (!stored || typeof stored.rating !== 'number') throw new Error('fake_detail is missing');
        const details: FakeDetails = { rating: stored.rating, note: typeof stored.note === 'string' ? stored.note : null };
        return details as unknown as Record<string, unknown>;
      },
    },
  };
}

/** A scripted source of one fake type: feeds, failures to inject, captures to hold and a sign-in switch. */
export class FakeSource {
  readonly feeds = new Map<string, FakeFeed>();
  /** Item keys in the order their captures started. */
  readonly captures: string[] = [];
  /** Errors the next captures of an item throw, one per capture. */
  readonly captureFailures = new Map<string, CollectorError[]>();
  /** Errors the next listings throw, one per listing. */
  readonly listFailures: CollectorError[] = [];
  /** Captures of these keys wait until the test releases them. */
  readonly held = new Set<string>();
  private readonly waiting = new Map<string, () => void>();
  signedIn = true;
  listings = 0;

  constructor(readonly type: string) {}

  /** Adds a feed whose items are published `ageDays` before `now`, newest first; returns their keys. */
  addFeed(id: string, now: Date, ageDays: number[], title = `${this.type} 動態 ${id}`): string[] {
    const items = ageDays.map((age, index) => ({
      key: `${id}-${String(index).padStart(2, '0')}`, title: `${id} 第 ${index} 篇`,
      publishedAt: new Date(now.getTime() - age * DAY).toISOString(),
    }));
    this.feeds.set(id, { id, title, url: `https://${this.type}.example/feed/${id}`, items });
    return items.map((item) => item.key);
  }

  feed(id: string): FakeFeed {
    const feed = this.feeds.get(id);
    if (!feed) throw new Error(`no feed ${id}`);
    return feed;
  }

  item(key: string): FakeItem | undefined {
    for (const feed of this.feeds.values()) {
      const found = feed.items.find((item) => item.key === key);
      if (found) return found;
    }
    return undefined;
  }

  fail(key: string, ...errors: CollectorError[]): void {
    this.captureFailures.set(key, [...(this.captureFailures.get(key) ?? []), ...errors]);
  }

  running(): string[] {
    return [...this.waiting.keys()];
  }

  release(key: string): void {
    const resolve = this.waiting.get(key);
    if (!resolve) throw new Error(`capture ${key} is not waiting`);
    this.waiting.delete(key);
    this.held.delete(key);
    resolve();
  }

  async resolve(url: string): Promise<SubscriptionTarget> {
    const id = new URL(url).pathname.split('/').filter(Boolean)[1] ?? '';
    const feed = this.feeds.get(id);
    if (!feed) throw new CollectorError('invalid_subscription', `找不到這個 ${this.type} 動態。`);
    return { id: feed.id, title: feed.title, url: feed.url };
  }

  async *list(target: SubscriptionTarget): AsyncGenerator<ListedItem> {
    this.listings += 1;
    const failure = this.listFailures.shift();
    if (failure) throw failure;
    for (const item of this.feed(target.id).items) {
      yield {
        key: item.key, url: `https://${this.type}.example/item/${item.key}`, title: item.title,
        publishedAt: item.listedAt === undefined ? item.publishedAt : item.listedAt, eligible: item.eligible ?? true,
      };
    }
  }

  async capture(ref: ItemRef, context: RequestContext): Promise<CapturedItem> {
    this.captures.push(ref.key);
    const failure = this.captureFailures.get(ref.key)?.shift();
    if (failure) throw failure;
    const item = this.item(ref.key) ?? { key: ref.key, title: `單篇 ${ref.key}`, publishedAt: null };
    if (context.publishedNotBefore && item.publishedAt && item.publishedAt < context.publishedNotBefore) {
      throw new CollectorError('out_of_range', '這篇文章的發布時間早於收集範圍。');
    }
    if (this.held.has(ref.key)) await new Promise<void>((resolve) => this.waiting.set(ref.key, resolve));
    const feed = [...this.feeds.values()].find((candidate) => candidate.items.some((entry) => entry.key === ref.key));
    const details: FakeDetails = { rating: ref.key.length, note: feed ? `來自 ${feed.title}` : null };
    return {
      key: ref.key, sourceUrl: ref.url, title: item.title,
      publisher: feed ? { id: feed.id, name: feed.title } : { id: null, name: `${this.type} 作者` },
      publishedAt: item.publishedAt, bodyMarkdown: `${item.title} 的內容。`,
      details: details as unknown as Record<string, unknown>,
    };
  }
}

/**
 * A fake plugin over a scripted source. Every request goes through the pacing group's gate when one
 * is given, as a real plugin's requests do.
 */
export function createFakePlugin(definition: SourceDefinition<FakeSettings>, source: FakeSource, gate?: PacingGate): SourcePlugin {
  const run = <T>(context: RequestContext, request: () => Promise<T>): Promise<T> =>
    gate ? gate.run(context.priority ?? 'background', request, context.signal) : request();
  const plugin: SourcePlugin<FakeSettings> = {
    ...definition,
    captureItem: (ref, context) => run(context, () => source.capture(ref, context)),
    resolveTarget: (url, context) => run(context, () => source.resolve(url)),
    async *listSubscriptionItems(target, context) {
      const listed: ListedItem[] = await run(context, async () => {
        const items: ListedItem[] = [];
        for await (const item of source.list(target)) items.push(item);
        return items;
      });
      yield* listed;
    },
    login: {
      status: () => source.signedIn ? 'signed_in' : 'required',
      describe: () => `登入 ${definition.label}`,
    },
  };
  return plugin;
}

export const FAKE = fakeDefinition('fake', 'fake-net');
export const FAKE2 = fakeDefinition('fake2', 'fake2-net');
