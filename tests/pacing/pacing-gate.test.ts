import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectorError } from '../../src/core/types.js';
import {
  type PacingEvent,
  waitRangeFromEnv,
  PacingGate,
  type PacingGateOptions,
} from '../../src/pacing/pacing-gate.js';
import { rssDefinition } from '../../src/plugins/rss/server.js';
import { YOUTUBE_PACING } from '../../src/plugins/youtube/server.js';

// The request channel runs with a manual clock and timers, so every wait is checked exactly.

const T0 = Date.parse('2026-10-15T06:00:00.000Z');
const MINUTE = 60_000;

interface Timer { at: number; callback: () => void; cancelled: boolean }

function harness() {
  let now = T0;
  const timers: Timer[] = [];
  const options: PacingGateOptions = {
    waitRangeMs: { min: 4_000, max: 12_000 },
    now: () => new Date(now),
    // 0.5 always draws the middle of the range: 4000 + floor(0.5 × 8001) = 8000 ms.
    random: () => 0.5,
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      await settle();
      const due = timers.filter((timer) => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      due.cancelled = true;
      due.callback();
      await settle();
    }
    now = target;
    await settle();
  };
  return { options, advance, clock: () => now };
}

/** Lets resolved promises run their continuations. */
async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

/** A request that stays running until the test ends it. */
function controlled<T>() {
  let finish!: (value: T) => void;
  let fail!: (error: unknown) => void;
  let started = false;
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject; });
  return {
    request: () => { started = true; return promise; },
    get started() { return started; },
    finish: (value: T) => finish(value),
    fail: (error: unknown) => fail(error),
  };
}

const limited = () => new CollectorError('rate_limited', 'YouTube 暫時限制連線。', { detail: 'ERROR: HTTP Error 429: Too Many Requests' });

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('YouTube request channel (P-T3)', () => {
  it('runs one request at a time and spaces requests by a random wait from the end of the previous one', async () => {
    const h = harness();
    const gate = await PacingGate.open(YOUTUBE_PACING, h.options);
    const first = controlled<string>();
    const second = controlled<string>();
    const results = [gate.run('background', first.request), gate.run('background', second.request)];
    await settle();
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(gate.status().state).toBe('busy');

    await h.advance(30_000);
    expect(second.started).toBe(false);
    first.finish('a');
    await settle();
    // The wait counts from the end of the first request, not from when the second was asked for.
    await h.advance(7_999);
    expect(second.started).toBe(false);
    await h.advance(1);
    expect(second.started).toBe(true);
    second.finish('b');
    expect(await Promise.all(results)).toEqual(['a', 'b']);
    expect(gate.status()).toMatchObject({ state: 'idle', cooldownUntil: null, level: 0, waitRangeMs: { min: 4_000, max: 12_000 } });
  });

  it('draws each wait anywhere in the range', async () => {
    const h = harness();
    const draws = [0, 0.999999];
    const gate = await PacingGate.open(YOUTUBE_PACING, { ...h.options, random: () => draws.shift() ?? 0 });
    const starts: number[] = [];
    const request = async () => { starts.push(h.clock()); };
    const all = [gate.run('background', request), gate.run('background', request), gate.run('background', request)];
    await h.advance(20_000);
    await Promise.all(all);
    expect(starts.map((at) => at - T0)).toEqual([0, 4_000, 16_000]);
  });

  it('sends a request at once after the channel was idle longer than the wait', async () => {
    const h = harness();
    const gate = await PacingGate.open(YOUTUBE_PACING, h.options);
    await gate.run('background', async () => 'first');
    await h.advance(13_000);
    const next = controlled<string>();
    const result = gate.run('background', next.request);
    await settle();
    expect(next.started).toBe(true);
    next.finish('second');
    expect(await result).toBe('second');
  });

  it('puts an interactive request before queued background work', async () => {
    const h = harness();
    const gate = await PacingGate.open(YOUTUBE_PACING, h.options);
    const order: string[] = [];
    const running = controlled<void>();
    const all = [
      gate.run('background', running.request),
      gate.run('background', async () => { order.push('background-1'); }),
      gate.run('background', async () => { order.push('background-2'); }),
    ];
    await settle();
    all.push(gate.run('interactive', async () => { order.push('preview'); }));
    running.finish();
    await h.advance(60_000);
    await Promise.all(all);
    expect(order).toEqual(['preview', 'background-1', 'background-2']);
  });

  it('removes a request whose signal aborts while it waits, and keeps the running one', async () => {
    const h = harness();
    const gate = await PacingGate.open(YOUTUBE_PACING, h.options);
    const running = controlled<string>();
    const abort = new AbortController();
    const reason = new Error('hold');
    const first = gate.run('background', running.request, abort.signal);
    const waiting = gate.run('background', async () => 'never', abort.signal);
    await settle();
    abort.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    running.finish('done');
    expect(await first).toBe('done');
    await expect(gate.run('background', async () => 'x', abort.signal)).rejects.toBe(reason);
  });
});

describe('cooldown after YouTube limits requests (P-T4)', () => {
  it('pauses every request, doubles the cooldown with each consecutive limit up to 60 minutes', async () => {
    const h = harness();
    const gate = await PacingGate.open(YOUTUBE_PACING, h.options);
    const events: PacingEvent[] = [];
    gate.subscribe((event) => events.push(event));
    const durations: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const started = h.clock();
      const error = await gate.run('background', async () => { throw limited(); }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'rate_limited' });
      const until = (error as CollectorError).retryAt!;
      durations.push((Date.parse(until) - started) / MINUTE);
      expect(gate.status()).toMatchObject({ state: 'cooldown', cooldownUntil: until, level: index + 1 });
      // Requests asked for during the cooldown fail at once with the same end time, whatever their priority.
      await expect(gate.run('interactive', async () => 'preview')).rejects.toMatchObject({ code: 'rate_limited', retryAt: until });
      await h.advance(Date.parse(until) - h.clock());
      expect(gate.status().state).toBe('idle');
    }
    expect(durations).toEqual([5, 10, 20, 40, 60, 60]);
    expect(events.filter((event) => event.type === 'rate_limited').map((event) => event.type === 'rate_limited' && event.level))
      .toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.filter((event) => event.type === 'cooldown_ended')).toHaveLength(6);
    expect(events[0]).toMatchObject({ type: 'rate_limited', detail: 'ERROR: HTTP Error 429: Too Many Requests' });
  });

  it('starts over at 5 minutes after a successful request', async () => {
    const h = harness();
    const gate = await PacingGate.open(YOUTUBE_PACING, h.options);
    await gate.run('background', async () => { throw limited(); }).catch(() => undefined);
    await h.advance(5 * MINUTE);
    await gate.run('background', async () => { throw limited(); }).catch(() => undefined);
    expect(gate.status().level).toBe(2);
    await h.advance(10 * MINUTE);
    await gate.run('background', async () => 'ok');
    expect(gate.status().level).toBe(0);
    await h.advance(20_000);
    const error = await gate.run('background', async () => { throw limited(); }).catch((caught: unknown) => caught as CollectorError);
    expect(Date.parse(error.retryAt!) - h.clock()).toBe(5 * MINUTE);
  });

  it('starts over at 5 minutes when the previous limit was more than 2 hours ago', async () => {
    const h = harness();
    const gate = await PacingGate.open(YOUTUBE_PACING, h.options);
    await gate.run('background', async () => { throw limited(); }).catch(() => undefined);
    await h.advance(2 * 60 * MINUTE + 1);
    const error = await gate.run('background', async () => { throw limited(); }).catch((caught: unknown) => caught as CollectorError);
    expect(gate.status().level).toBe(1);
    expect(Date.parse(error.retryAt!) - h.clock()).toBe(5 * MINUTE);
  });

  it('rejects requests already waiting for their turn when a cooldown starts', async () => {
    const h = harness();
    const gate = await PacingGate.open(YOUTUBE_PACING, h.options);
    const running = controlled<string>();
    const first = gate.run('background', running.request);
    const waiting = gate.run('background', async () => 'later');
    await settle();
    running.fail(limited());
    await expect(first).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(waiting).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('keeps the cooldown across restarts in its state file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xr-youtube-gate-'));
    directories.push(directory);
    const statePath = path.join(directory, 'youtube-pacing.json');
    const h = harness();
    const first = await PacingGate.open(YOUTUBE_PACING, { ...h.options, statePath });
    const error = await first.run('background', async () => { throw limited(); }).catch((caught: unknown) => caught as CollectorError);
    await first.flush();
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ cooldownUntil: error.retryAt, level: 1 });

    const reopened = await PacingGate.open(YOUTUBE_PACING, { ...h.options, statePath });
    expect(reopened.status()).toMatchObject({ state: 'cooldown', cooldownUntil: error.retryAt, level: 1 });
    await h.advance(5 * MINUTE);
    expect(reopened.status().state).toBe('idle');

    // A cooldown that ended while the service was stopped is over at the next start.
    // Advancing the clock also ended the first gate's cooldown; both gates finish writing first.
    await Promise.all([first.flush(), reopened.flush()]);
    await writeFile(statePath, JSON.stringify({ cooldownUntil: new Date(h.clock() - 1).toISOString(), level: 3, lastLimitedAt: null }));
    const later = await PacingGate.open(YOUTUBE_PACING, { ...h.options, statePath });
    expect(later.status()).toMatchObject({ state: 'idle', cooldownUntil: null, level: 3 });

    await Promise.all([reopened.flush(), later.flush()]);
    await writeFile(statePath, '{');
    expect((await PacingGate.open(YOUTUBE_PACING, { ...h.options, statePath })).status()).toMatchObject({ state: 'idle', level: 0 });
  });

  it('reads the acceptance override of the wait range', () => {
    expect(waitRangeFromEnv('100,300')).toEqual({ min: 100, max: 300 });
    expect(waitRangeFromEnv(' 0 , 0 ')).toEqual({ min: 0, max: 0 });
    expect(waitRangeFromEnv('300,100')).toBeUndefined();
    expect(waitRangeFromEnv('fast')).toBeUndefined();
    expect(waitRangeFromEnv(undefined)).toBeUndefined();
  });
});

describe('a group without cooldowns (RSS)', () => {
  it('fails only the limited request: no cooldown, no event, no state file, and the next request goes out after the usual wait', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xr-rss-gate-'));
    directories.push(directory);
    const statePath = path.join(directory, 'rss-pacing.json');
    const h = harness();
    const gate = await PacingGate.open(rssDefinition.pacing!, { ...h.options, statePath });
    const events: PacingEvent[] = [];
    gate.subscribe((event) => events.push(event));

    const siteLimit = new CollectorError('rate_limited', '這個網站暫時限制連線。');
    const running = controlled<string>();
    const first = gate.run('background', running.request);
    const waiting = gate.run('background', async () => 'other feed');
    await settle();
    running.fail(siteLimit);
    await expect(first).rejects.toBe(siteLimit);
    expect(siteLimit.retryAt).toBeUndefined();
    expect(gate.status()).toMatchObject({ state: 'waiting', cooldownUntil: null, level: 0 });
    await h.advance(8_000);
    await expect(waiting).resolves.toBe('other feed');
    expect(events).toEqual([]);
    await gate.flush();
    expect(existsSync(statePath)).toBe(false);
  });
});
