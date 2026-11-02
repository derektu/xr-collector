import { describe, expect, it } from 'vitest';
import { PacingGate } from '../../src/pacing/pacing-gate.js';
import { YOUTUBE_PACING } from '../../src/plugins/youtube/server.js';
import { SubscriptionService } from '../../src/subscriptions/subscription-service.js';
import type { SubscriptionStore } from '../../src/subscriptions/subscription-store.js';

// A channel preview that times out while it waits for its YouTube turn gives that turn up, so the
// request is never sent after the user stopped waiting for it (P-T3).

describe('channel preview through the YouTube request channel', () => {
  it('drops a timed-out preview from the queue', async () => {
    const gate = await PacingGate.open(YOUTUBE_PACING, { waitRangeMs: { min: 0, max: 0 } });
    let finishRunning!: () => void;
    const running = gate.run('background', () => new Promise<void>((resolve) => { finishRunning = resolve; }));
    let previewRequests = 0;
    const store = { list: async () => [] } as unknown as SubscriptionStore;
    const collector = new SubscriptionService('youtube', store, {} as never, {
      autoCollection: async () => true,
      documents: async () => [],
      previewTimeoutMs: 50,
      resolveTarget: (url, signal) => gate.run('interactive', async () => {
        previewRequests += 1;
        return { id: 'UCabcdefghijklmnopqrstuv', title: '頻道', url };
      }, signal),
    });

    await expect(collector.preview('https://www.youtube.com/@example')).rejects.toMatchObject({ code: 'network_error' });
    expect(gate.status().state).toBe('busy');
    finishRunning();
    await running;
    // Requests run one at a time in queue order and an interactive one goes first, so a preview still
    // queued would run before this one.
    await gate.run('background', async () => undefined);
    expect(previewRequests).toBe(0);
    expect(gate.status().state).toBe('idle');
  });
});
