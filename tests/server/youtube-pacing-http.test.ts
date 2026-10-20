import { describe, expect, it } from 'vitest';
import { YouTubeGate } from '../../src/capture/youtube-gate.js';
import { CollectorError, type ChannelPreview } from '../../src/core/types.js';
import { createHttpApp, type ChannelCollection } from '../../src/server/app.js';

// The pacing state and a limited channel preview read the same over the UI listener and the
// Agent listener, which only differs by its token.

const T0 = Date.parse('2026-10-15T06:00:00.000Z');

describe('YouTube pacing over HTTP (P-T7)', () => {
  it('reports the request channel to the UI and to an authorized Agent', async () => {
    let now = T0;
    const gate = await YouTubeGate.open({ now: () => new Date(now), setTimer: () => () => undefined });
    await gate.run('background', async () => { throw new CollectorError('rate_limited', 'YouTube 暫時限制連線。'); }).catch(() => undefined);
    const until = new Date(T0 + 5 * 60_000).toISOString();
    const channels = {
      preview: (): Promise<ChannelPreview> => gate.run('interactive', async () => { throw new Error('not sent during a cooldown'); }),
    } as unknown as ChannelCollection;

    const ui = await createHttpApp({ pacing: gate, channels });
    const agent = await createHttpApp({ pacing: gate, channels, agentToken: 'pacing-token' });
    const expected = { state: 'cooldown', cooldownUntil: until, level: 1, waitRangeMs: { min: 4_000, max: 12_000 } };
    expect((await ui.inject({ method: 'GET', url: '/api/youtube/pacing' })).json()).toEqual(expected);
    const authorized = await agent.inject({ method: 'GET', url: '/api/youtube/pacing', headers: { authorization: 'Bearer pacing-token' } });
    expect(authorized.json()).toEqual(expected);
    expect((await agent.inject({ method: 'GET', url: '/api/youtube/pacing' })).statusCode).toBe(401);

    const preview = await ui.inject({
      method: 'POST', url: '/api/youtube/channel-previews', payload: { url: 'https://www.youtube.com/@LennysPodcast' },
    });
    expect(preview.statusCode).toBe(503);
    expect(preview.json()).toMatchObject({ error: { code: 'rate_limited', retryAt: until, message: expect.stringContaining('後自動繼續') } });
    expect(Number(preview.headers['retry-after'])).toBeGreaterThan(0);

    now = T0 + 5 * 60_000 + 1;
    expect((await ui.inject({ method: 'GET', url: '/api/youtube/pacing' })).json()).toMatchObject({ state: 'idle', cooldownUntil: null });
    await ui.close();
    await agent.close();
  });
});
