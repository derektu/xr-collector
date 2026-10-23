import { describe, expect, it, vi } from 'vitest';
import { INTERVAL_OPTIONS } from '../../src/core/collection-settings.js';
import { DEFAULT_POLICY } from '../../src/plugins/youtube/settings.js';
import { CollectorError, type SubscriptionPreview } from '../../src/core/types.js';
import { createHttpApp, type SubscriptionCollection } from '../../src/server/app.js';
import { recognizeUrl, sourceTypeDeclarations, type SourceTypeDeclaration } from '../../src/sources/source-types.js';

const own = { intervalMinutes: 60, backfillDays: 14, backfillMaxItems: 5 };
const CHANNEL_ID = 'UCchannel-one-xxxxxxxxxx';

/** Channel previews keyed by the resolved address; anything else fails to resolve. */
function channelsWith(previews: Record<string, { enabled: boolean } | null>, failure?: CollectorError) {
  const preview = vi.fn(async (url: string): Promise<SubscriptionPreview> => {
    if (failure) throw failure;
    if (!(url in previews)) throw new CollectorError('invalid_subscription', '無法辨認這個 YouTube 頻道。');
    return {
      type: 'youtube', target: { id: CHANNEL_ID, title: '頻道一', url: `https://www.youtube.com/channel/${CHANNEL_ID}/videos` },
      subscription: previews[url] ? { ...previews[url]!, settings: own } : null,
      settings: previews[url] ? own : DEFAULT_POLICY,
      autoCollection: true,
    };
  });
  const channels = { type: 'youtube', preview, listSubscriptions: async () => [], checkJobs: () => [] } as unknown as SubscriptionCollection;
  return { channels, preview };
}

async function recognize(url: unknown, channels: SubscriptionCollection, sourceTypes?: SourceTypeDeclaration[]) {
  const app = await createHttpApp({ subscriptions: [channels], ...(sourceTypes ? { sourceTypes } : {}) });
  const response = await app.inject({ method: 'POST', url: '/api/url-recognitions', payload: url === undefined ? {} : { url } });
  await app.close();
  return response;
}

describe('source type declarations (T-01)', () => {
  it('publishes YouTube with its kinds, login need and the setting options with their defaults', async () => {
    const app = await createHttpApp({});
    const response = await app.inject({ method: 'GET', url: '/api/source-types' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const { sourceTypes } = response.json();
    expect(sourceTypes.map((type: { id: string }) => type.id)).toEqual(['youtube', 'rss']);
    const [youtube] = sourceTypes;
    expect(youtube).toMatchObject({
      label: 'YouTube', icon: 'youtube', requiresLogin: false,
      kinds: [
        { id: 'video', label: 'YouTube 影片', capability: 'single' },
        { id: 'channel', label: 'YouTube 頻道', capability: 'subscription' },
      ],
    });
    expect(youtube.settings).toMatchObject([
      { input: 'choice', key: 'intervalMinutes', label: '檢查頻率', options: INTERVAL_OPTIONS.map((value) => ({ value })) },
      { input: 'number', key: 'backfillDays', label: '時間範圍', min: 1, max: 60, unit: '天' },
      { input: 'number', key: 'backfillMaxItems', label: '數量上限', min: 1, max: 100, unit: '支影片' },
    ]);
    expect(Object.fromEntries(youtube.settings.map((field: { key: string; default: unknown }) => [field.key, field.default]))).toEqual(DEFAULT_POLICY);
    expect(youtube.settings[0].options.map((option: { label: string }) => option.label)).toEqual(['每 15 分鐘', '每 30 分鐘', '每 1 小時', '每 3 小時', '每 6 小時', '每 12 小時', '每天']);
    expect(youtube).not.toHaveProperty('recognize');
  });
});

describe('URL recognition (T-02 to T-05)', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=12',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&index=3',
    'youtube.com/watch?v=dQw4w9WgXcQ',
    'youtu.be/dQw4w9WgXcQ',
  ])('recognizes %s as one video to collect without resolving anything', async (url) => {
    const { channels, preview } = channelsWith({});
    const response = await recognize(url, channels);

    expect(response.statusCode).toBe(200);
    expect(response.json().recognition).toEqual({
      status: 'ready', sourceType: 'youtube', kind: 'video', kindLabel: 'YouTube 影片',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      target: { id: 'dQw4w9WgXcQ', title: null, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      subscription: null, settings: null, autoCollection: null, login: null, message: null,
      actions: [{
        id: 'collect', label: '收集影片', primary: true,
        request: { method: 'POST', path: '/api/items', body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
      }],
    });
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([
    ['@channel-one', 'https://www.youtube.com/@channel-one'],
    ['www.youtube.com/@channel-one', 'https://www.youtube.com/@channel-one'],
    ['https://www.youtube.com/channel/UCabc/featured', 'https://www.youtube.com/channel/UCabc'],
    ['https://www.youtube.com/c/legacy', 'https://www.youtube.com/c/legacy'],
    ['https://www.youtube.com/user/older', 'https://www.youtube.com/user/older'],
  ])('offers to subscribe to an unsubscribed channel %s with the type defaults', async (input, resolved) => {
    const { channels, preview } = channelsWith({ [resolved]: null });
    const recognition = (await recognize(input, channels)).json().recognition;

    expect(preview).toHaveBeenCalledWith(resolved);
    expect(recognition).toMatchObject({
      status: 'ready', sourceType: 'youtube', kind: 'channel', kindLabel: 'YouTube 頻道',
      target: { id: CHANNEL_ID, title: '頻道一' }, subscription: null, settings: DEFAULT_POLICY, autoCollection: true,
      actions: [{
        id: 'subscribe', label: '訂閱頻道', primary: true,
        request: { method: 'POST', path: '/api/subscriptions', body: { url: `https://www.youtube.com/channel/${CHANNEL_ID}/videos` } },
      }],
    });
  });

  it('offers to resume a paused channel and offers nothing for an active one', async () => {
    const paused = (await recognize('@channel-one', channelsWith({ 'https://www.youtube.com/@channel-one': { enabled: false } }).channels)).json().recognition;
    const active = (await recognize('@channel-one', channelsWith({ 'https://www.youtube.com/@channel-one': { enabled: true } }).channels)).json().recognition;

    expect(paused).toMatchObject({
      status: 'ready', subscription: { id: CHANNEL_ID, enabled: false, settings: own },
      actions: [{ id: 'resume', label: '恢復訂閱', request: { method: 'PATCH', path: `/api/subscriptions/youtube/${CHANNEL_ID}`, body: { enabled: true } } }],
    });
    expect(active).toMatchObject({ status: 'ready', subscription: { id: CHANNEL_ID, enabled: true }, actions: [] });
  });

  it('reports a channel that names none as unsupported and one that cannot be read now as unavailable', async () => {
    const missing = (await recognize('@nobody', channelsWith({}).channels)).json().recognition;
    const offline = (await recognize('@channel-one', channelsWith({}, new CollectorError('network_error', '連線逾時，請稍後再試。')).channels)).json().recognition;

    expect(missing).toMatchObject({ status: 'unsupported', sourceType: 'youtube', kind: 'channel', actions: [], message: '無法辨認這個 YouTube 頻道。' });
    expect(offline).toMatchObject({ status: 'unavailable', message: '連線逾時，請稍後再試。' });
  });

  it.each([
    ['https://www.youtube.com/playlist?list=PLabc', 'youtube', '播放清單'],
    ['https://www.youtube.com/feed/trending', 'youtube', '不包含可辨識'],
    ['not a url', null, '請貼上完整網址'],
    ['ftp://example.com/feed', null, '目前還不支援這個網站'],
    ['youtube', null, '請貼上完整網址'],
  ])('answers %s as unsupported with a reason', async (url, sourceType, reason) => {
    const response = await recognize(url, channelsWith({}).channels);

    expect(response.statusCode).toBe(200);
    expect(response.json().recognition).toMatchObject({ status: 'unsupported', sourceType, actions: [], message: expect.stringContaining(reason) });
  });

  it.each([undefined, '', '   ', 42])('rejects a missing or empty address (%s) as a malformed request', async (url) => {
    const response = await recognize(url, channelsWith({}).channels);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('answers login_required for a type that needs an account, without recognizing the address', async () => {
    const recognizeFixture = vi.fn();
    const fixture = {
      id: 'fixture', label: '登入測試', icon: 'fixture', kinds: [], requiresLogin: true, settings: [],
      owns: (_input: string, url: URL | null) => url?.hostname === 'login.example',
      recognize: recognizeFixture,
    } as unknown as SourceTypeDeclaration;
    const { channels, preview } = channelsWith({});
    const recognition = (await recognize('https://login.example/page', channels, [fixture, ...sourceTypeDeclarations()])).json().recognition;

    expect(recognition).toEqual({
      status: 'login_required', sourceType: 'fixture', kind: null, kindLabel: null, url: 'https://login.example/page',
      target: null, subscription: null, settings: null, autoCollection: null, actions: [], message: null,
      login: { sourceType: 'fixture', label: '登入測試', message: '需要先登入 登入測試 才能收集這個網址的內容。' },
    });
    expect(recognizeFixture).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([
    ['https://example.com/article', 'https://example.com/article'],
    ['example.com/article', 'https://example.com/article'],
    ['www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
  ])('hands %s, a web address no other type owns, to RSS to look for a feed', async (input, resolved) => {
    const preview = vi.fn(async (): Promise<SubscriptionPreview> => {
      throw new CollectorError('invalid_subscription', '這個網址沒有 RSS feed。');
    });
    const feeds = { type: 'rss', preview, listSubscriptions: async () => [], checkJobs: () => [] } as unknown as SubscriptionCollection;
    const recognition = (await recognize(input, feeds)).json().recognition;

    expect(preview).toHaveBeenCalledWith(resolved);
    expect(recognition).toMatchObject({ status: 'unsupported', sourceType: 'rss', kind: 'feed', actions: [], message: '這個網址沒有 RSS feed。' });
  });

  it('offers to subscribe to the feed a web address leads to', async () => {
    const target = { id: '0123456789abcdef', title: '部落格', url: 'https://example.com/feed.xml' };
    const preview = vi.fn(async (): Promise<SubscriptionPreview> => ({
      type: 'rss', target, subscription: null, settings: { intervalMinutes: 60, backfillDays: 30, backfillMaxItems: 10 }, autoCollection: true,
    }));
    const feeds = { type: 'rss', preview, listSubscriptions: async () => [], checkJobs: () => [] } as unknown as SubscriptionCollection;
    const recognition = (await recognize('https://example.com/', feeds)).json().recognition;

    expect(recognition).toMatchObject({
      status: 'ready', sourceType: 'rss', kind: 'feed', kindLabel: 'RSS', target,
      actions: [{ id: 'subscribe', label: '訂閱網站', request: { method: 'POST', path: '/api/subscriptions', body: { url: target.url } } }],
    });
  });

  it('lets the first declaration that owns an address recognize it', async () => {
    const { channels } = channelsWith({});
    const recognition = await recognizeUrl(' https://youtu.be/dQw4w9WgXcQ ', sourceTypeDeclarations(), { previewSubscription: (_type, url) => channels.preview(url) });
    expect(recognition).toMatchObject({ status: 'ready', kind: 'video' });
  });
});
