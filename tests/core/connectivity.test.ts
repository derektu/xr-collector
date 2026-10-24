import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionPause, type PauseChange } from '../../src/core/collection-pause.js';
import { Connectivity, connectivityProbe, OFFLINE_RECHECK_MS, ONLINE_REUSE_MS } from '../../src/core/connectivity.js';

afterEach(() => {
  vi.useRealTimers();
});

/** A connectivity service over a probe the test answers; every probe is counted. */
function world(options: { offlineRecheckMs?: number } = {}) {
  const pause = new CollectionPause();
  const changes: PauseChange[] = [];
  pause.subscribe((change) => changes.push(change));
  const clock = { now: new Date('2026-10-24T06:00:00.000Z') };
  const probe = { online: true, calls: 0, gate: null as Promise<void> | null };
  const connectivity = new Connectivity({
    pause,
    now: () => clock.now,
    ...(options.offlineRecheckMs ? { offlineRecheckMs: options.offlineRecheckMs } : {}),
    probe: async () => {
      probe.calls += 1;
      if (probe.gate) await probe.gate;
      return probe.online;
    },
  });
  return {
    pause, changes, clock, probe, connectivity,
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); },
  };
}

describe('connectivity (#128)', () => {
  it('counts as online without probing until a confirmation fails', async () => {
    const w = world();
    expect(w.connectivity.status()).toEqual({ state: 'online', checkedAt: null });
    expect(w.probe.calls).toBe(0);

    w.probe.online = false;
    expect(await w.connectivity.confirm()).toBe('offline');
    expect(w.connectivity.status()).toEqual({ state: 'offline', checkedAt: '2026-10-24T06:00:00.000Z' });
    expect(w.pause.has('offline')).toBe(true);
    expect(w.changes).toEqual([{ reason: 'offline', inForce: true, paused: true }]);
    w.connectivity.close();
  });

  it('confirms an offline device every 30 seconds and lifts the pause on the first success', async () => {
    vi.useFakeTimers();
    const w = world();
    w.probe.online = false;
    await w.connectivity.check();
    await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS - 1);
    expect(w.probe.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.probe.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS);
    expect(w.probe.calls).toBe(3);

    w.probe.online = true;
    w.advance(OFFLINE_RECHECK_MS);
    await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS);
    expect(w.probe.calls).toBe(4);
    expect(w.connectivity.status()).toEqual({ state: 'online', checkedAt: '2026-10-24T06:00:30.000Z' });
    expect(w.changes.map(({ reason, inForce }) => [reason, inForce])).toEqual([['offline', true], ['offline', false]]);
    // Online again, nothing is probed on a timer.
    await vi.advanceTimersByTimeAsync(10 * OFFLINE_RECHECK_MS);
    expect(w.probe.calls).toBe(4);
    w.connectivity.close();
  });

  it('shares one probe between confirmations that overlap', async () => {
    const w = world();
    let open!: () => void;
    w.probe.gate = new Promise((resolve) => { open = resolve; });
    w.probe.online = false;
    const answers = Promise.all([w.connectivity.confirm(), w.connectivity.confirm(), w.connectivity.check()]);
    open();
    expect(await answers).toEqual(['offline', 'offline', 'offline']);
    expect(w.probe.calls).toBe(1);
    w.connectivity.close();
  });

  it('reuses an online answer for 30 seconds after a failed request, and probes again after', async () => {
    const w = world();
    expect(await w.connectivity.check()).toBe('online');
    w.advance(ONLINE_REUSE_MS - 1);
    expect(await w.connectivity.confirm()).toBe('online');
    expect(w.probe.calls).toBe(1);
    w.advance(1);
    expect(await w.connectivity.confirm()).toBe('online');
    expect(w.probe.calls).toBe(2);
    // A person asking to check confirms whatever the last answer was.
    expect(await w.connectivity.check()).toBe('online');
    expect(w.probe.calls).toBe(3);
    w.connectivity.close();
  });

  it('confirms nothing while the system sleeps and confirms once when it wakes', async () => {
    vi.useFakeTimers();
    const w = world();
    w.probe.online = false;
    await w.connectivity.check();
    w.pause.set('sleep', true);
    await vi.advanceTimersByTimeAsync(5 * OFFLINE_RECHECK_MS);
    expect(w.probe.calls).toBe(1);

    w.probe.online = true;
    w.pause.set('sleep', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.probe.calls).toBe(2);
    expect(w.connectivity.status().state).toBe('online');
    expect(w.pause.paused).toBe(false);
    w.connectivity.close();
  });
});

describe('the internet probe (#128)', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); });
    server = null;
  });

  it('accepts only the known answers, so a captive portal reads as offline', async () => {
    const answers: Record<string, { status: number; body: string; headers?: Record<string, string> }> = {};
    server = createServer((request, response) => {
      const answer = answers[request.url ?? ''] ?? { status: 404, body: '' };
      response.writeHead(answer.status, answer.headers).end(answer.body);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const probe = connectivityProbe([
      { url: `${origin}/generate_204`, accepts: async (response) => response.status === 204 },
      { url: `${origin}/hotspot`, accepts: async (response) => response.ok && (await response.text()).includes('Success') },
    ]);
    const signal = new AbortController().signal;

    // A portal redirects one address and answers the other with its own sign-in page.
    answers['/generate_204'] = { status: 302, body: '', headers: { location: `${origin}/login` } };
    answers['/hotspot'] = { status: 200, body: '<html>請先登入</html>' };
    expect(await probe(signal)).toBe(false);

    answers['/hotspot'] = { status: 200, body: '<HTML><BODY>Success</BODY></HTML>' };
    expect(await probe(signal)).toBe(true);

    answers['/hotspot'] = { status: 500, body: '' };
    answers['/generate_204'] = { status: 204, body: '' };
    expect(await probe(signal)).toBe(true);
  });
});
