import { describe, expect, it, vi } from 'vitest';
import { BACKFILL_LIMITS, BACKFILL_WINDOWS, DEFAULT_POLICY, INTERVAL_OPTIONS } from '../../src/channels/collection-policy.js';
import { CollectorError, type ChannelPreview } from '../../src/core/types.js';
import { createHttpApp, type ChannelCollection } from '../../src/server/app.js';
import { recognizeUrl, SOURCE_TYPES, type SourceTypeDeclaration } from '../../src/sources/source-types.js';

const own = { intervalMinutes: 60, backfillWindow: '2w' as const, backfillMaxItems: 5 };
const CHANNEL_ID = 'UCchannel-one-xxxxxxxxxx';

/** Channel previews keyed by the resolved address; anything else fails to resolve. */
function channelsWith(previews: Record<string, { enabled: boolean } | null>, failure?: CollectorError) {
  const preview = vi.fn(async (url: string): Promise<ChannelPreview> => {
    if (failure) throw failure;
    if (!(url in previews)) throw new CollectorError('invalid_channel', '無法辨認這個 YouTube 頻道。');
    return {
      channel: { id: CHANNEL_ID, title: '頻道一', url: `https://www.youtube.com/channel/${CHANNEL_ID}/videos` },
      subscription: previews[url] ? { ...previews[url]!, settings: own } : null,
      settings: previews[url] ? own : DEFAULT_POLICY,
      autoCollection: true,
    };
  });
  const channels = { preview, listSubscriptions: async () => [], channelJobs: () => [] } as unknown as ChannelCollection;
  return { channels, preview };
}

async function recognize(url: unknown, channels: ChannelCollection, sourceTypes?: SourceTypeDeclaration[]) {
  const app = await createHttpApp({ channels, ...(sourceTypes ? { sourceTypes } : {}) });
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
    expect(sourceTypes.map((type: { id: string }) => type.id)).toEqual(['youtube']);
    const [youtube] = sourceTypes;
    expect(youtube).toMatchObject({
      label: 'YouTube', icon: 'youtube', requiresLogin: false,
      kinds: [
        { id: 'video', label: 'YouTube 影片', capability: 'single' },
        { id: 'channel', label: 'YouTube 頻道', capability: 'subscription' },
      ],
    });
    const options = Object.fromEntries(youtube.settings.map((field: { key: string; options: Array<{ value: unknown }> }) =>
      [field.key, field.options.map((option) => option.value)]));
    expect(options).toEqual({
      intervalMinutes: [...INTERVAL_OPTIONS], backfillWindow: [...BACKFILL_WINDOWS], backfillMaxItems: [...BACKFILL_LIMITS],
    });
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
        request: { method: 'POST', path: '/api/youtube/collect', body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
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
        request: { method: 'POST', path: '/api/youtube/channels', body: { url: `https://www.youtube.com/channel/${CHANNEL_ID}/videos` } },
      }],
    });
  });

  it('offers to resume a paused channel and offers nothing for an active one', async () => {
    const paused = (await recognize('@channel-one', channelsWith({ 'https://www.youtube.com/@channel-one': { enabled: false } }).channels)).json().recognition;
    const active = (await recognize('@channel-one', channelsWith({ 'https://www.youtube.com/@channel-one': { enabled: true } }).channels)).json().recognition;

    expect(paused).toMatchObject({
      status: 'ready', subscription: { id: CHANNEL_ID, enabled: false, settings: own },
      actions: [{ id: 'resume', label: '恢復訂閱', request: { method: 'PATCH', path: `/api/youtube/channels/${CHANNEL_ID}`, body: { enabled: true } } }],
    });
    expect(active).toMatchObject({ status: 'ready', subscription: { id: CHANNEL_ID, enabled: true }, actions: [] });
  });

  it('reports a channel that cannot be resolved as unavailable', async () => {
    const missing = (await recognize('@nobody', channelsWith({}).channels)).json().recognition;
    const offline = (await recognize('@channel-one', channelsWith({}, new CollectorError('network_error', '連線逾時，請稍後再試。')).channels)).json().recognition;

    expect(missing).toMatchObject({ status: 'unavailable', sourceType: 'youtube', kind: 'channel', actions: [], message: '無法辨認這個 YouTube 頻道。' });
    expect(offline).toMatchObject({ status: 'unavailable', message: '連線逾時，請稍後再試。' });
  });

  it.each([
    ['https://www.youtube.com/playlist?list=PLabc', 'youtube', '播放清單'],
    ['https://www.youtube.com/feed/trending', 'youtube', '不包含可辨識'],
    ['https://example.com/article', null, '目前還不支援這個網站'],
    ['not a url', null, '請貼上完整網址'],
    ['example.com/article', null, '請貼上完整網址'],
    ['www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ', null, '請貼上完整網址'],
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
    const recognition = (await recognize('https://login.example/page', channels, [...SOURCE_TYPES, fixture])).json().recognition;

    expect(recognition).toEqual({
      status: 'login_required', sourceType: 'fixture', kind: null, kindLabel: null, url: 'https://login.example/page',
      target: null, subscription: null, settings: null, autoCollection: null, actions: [], message: null,
      login: { sourceType: 'fixture', label: '登入測試', message: '需要先登入 登入測試 才能收集這個網址的內容。' },
    });
    expect(recognizeFixture).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it('lets the first declaration that owns an address recognize it', async () => {
    const { channels } = channelsWith({});
    const recognition = await recognizeUrl(' https://youtu.be/dQw4w9WgXcQ ', SOURCE_TYPES, { previewChannel: (url) => channels.preview(url) });
    expect(recognition).toMatchObject({ status: 'ready', kind: 'video' });
  });
});
