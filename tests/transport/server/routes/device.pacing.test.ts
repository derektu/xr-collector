// Broken, a preview during a cooldown waits instead of saying when it can resume.
import { describe, expect, it } from 'vitest';
import { PacingGate } from '../../../../src/domain/pacing/pacing-gate.js';
import { YOUTUBE_PACING } from '../../../../src/domain/sources/youtube/server.js';
import { CollectorError } from '../../../../src/shared/lib/collector-error.js';
import type { SubscriptionPreview } from '../../../../src/shared/subscriptions/subscription-types.js';
import { createHttpApp, type SubscriptionCollection } from '../../../../src/transport/server/app.js';
import { PRODUCT_SOURCES } from '../../../support/product-sources.js';
import { stoppedTimers } from '../../../support/timers.js';

const T0 = Date.parse('2026-10-15T06:00:00.000Z');

describe('YouTube pacing over HTTP (P-T7)', () => {
  it('reports the request channel and refuses a preview during a cooldown', async () => {
    let now = T0;
    const gate = await PacingGate.open(YOUTUBE_PACING, { now: () => new Date(now), timers: stoppedTimers });
    await gate.run('background', async () => { throw new CollectorError('rate_limited', 'YouTube 暫時限制連線。'); }).catch(() => undefined);
    const until = new Date(T0 + 5 * 60_000).toISOString();
    const channels = {
      type: 'youtube',
      preview: (): Promise<SubscriptionPreview> => gate.run('interactive', async () => { throw new Error('not sent during a cooldown'); }),
    } as unknown as SubscriptionCollection;

    const ui = await createHttpApp({ sources: PRODUCT_SOURCES, pacing: [gate], subscriptions: [channels] });
    const expected = { groups: [{ group: 'youtube', label: 'YouTube', state: 'cooldown', cooldownUntil: until, level: 1, waitRangeMs: { min: 4_000, max: 12_000 } }] };
    expect((await ui.inject({ method: 'GET', url: '/api/pacing' })).json()).toEqual(expected);

    const preview = await ui.inject({
      method: 'POST', url: '/api/subscription-previews', payload: { url: 'https://www.youtube.com/@LennysPodcast' },
    });
    expect(preview.statusCode).toBe(503);
    expect(preview.json()).toMatchObject({ error: { code: 'rate_limited', retryAt: until, message: expect.stringContaining('後自動繼續') } });
    expect(Number(preview.headers['retry-after'])).toBeGreaterThan(0);

    now = T0 + 5 * 60_000 + 1;
    expect((await ui.inject({ method: 'GET', url: '/api/pacing' })).json()).toMatchObject({ groups: [{ group: 'youtube', state: 'idle', cooldownUntil: null }] });
    await ui.close();
  });

  it('reads the request channels while the Vault is not ready', async () => {
    const gate = await PacingGate.open(YOUTUBE_PACING, { now: () => new Date(T0), timers: stoppedTimers });
    const app = await createHttpApp({ sources: PRODUCT_SOURCES, pacing: [gate], notReady: () => '尚未設定知識庫。' });
    const pacing = await app.inject({ method: 'GET', url: '/api/pacing' });
    expect(pacing.statusCode).toBe(200);
    expect(pacing.json()).toMatchObject({ groups: [{ group: 'youtube', label: 'YouTube', state: 'idle' }] });
    const documents = await app.inject({ method: 'GET', url: '/api/documents' });
    expect(documents.statusCode).toBe(503);
    expect(documents.json()).toMatchObject({ error: { code: 'vault_not_ready' } });
    await app.close();
  });
});
