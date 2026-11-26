import { describe, expect, it } from 'vitest';
import { Countdown, type StartTimer } from '../../../../src/transport/web/infra/timing.js';

function heldTimers() {
  const pending: Array<{ run: () => void; ms: number; stopped: boolean }> = [];
  const start: StartTimer = (run, ms) => {
    const timer = { run, ms, stopped: false };
    pending.push(timer);
    return () => { timer.stopped = true; };
  };
  const live = () => pending.filter((timer) => !timer.stopped);
  const elapse = () => { for (const timer of live()) { timer.stopped = true; timer.run(); } };
  return { start, live, elapse };
}

describe('Countdown', () => {
  it('runs once after the delay, with the callback from the latest render', () => {
    const timers = heldTimers();
    const countdown = new Countdown(timers.start);
    const runs: string[] = [];
    countdown.sync(500, 'a', () => runs.push('first'));
    countdown.sync(500, 'a', () => runs.push('latest'));
    expect(timers.live().map((timer) => timer.ms)).toEqual([500]);
    timers.elapse();
    countdown.sync(500, 'a', () => runs.push('again'));
    expect(runs).toEqual(['latest']);
    expect(timers.live()).toEqual([]);
  });

  it('starts over when the restart key changes, so a burst of typing waits for the last key', () => {
    const timers = heldTimers();
    const countdown = new Countdown(timers.start);
    const runs: string[] = [];
    countdown.sync(500, 'a', () => runs.push('a'));
    countdown.sync(500, 'ab', () => runs.push('ab'));
    countdown.sync(500, 'abc', () => runs.push('abc'));
    expect(timers.live()).toHaveLength(1);
    timers.elapse();
    expect(runs).toEqual(['abc']);
  });

  it('starts over when the delay changes', () => {
    const timers = heldTimers();
    const countdown = new Countdown(timers.start);
    countdown.sync(500, 'a', () => undefined);
    countdown.sync(800, 'a', () => undefined);
    expect(timers.live().map((timer) => timer.ms)).toEqual([800]);
  });

  it('never runs while the delay is null or after it is disposed', () => {
    const timers = heldTimers();
    const countdown = new Countdown(timers.start);
    const runs: string[] = [];
    countdown.sync(null, 'a', () => runs.push('null'));
    countdown.sync(500, 'a', () => runs.push('cancelled'));
    countdown.sync(null, 'a', () => runs.push('null'));
    countdown.sync(500, 'b', () => runs.push('disposed'));
    countdown.dispose();
    timers.elapse();
    expect(runs).toEqual([]);
  });

  it('arms again after dispose, as a remounted screen does', () => {
    const timers = heldTimers();
    const countdown = new Countdown(timers.start);
    const runs: string[] = [];
    countdown.sync(500, 'a', () => runs.push('first'));
    countdown.dispose();
    countdown.sync(500, 'a', () => runs.push('remounted'));
    timers.elapse();
    expect(runs).toEqual(['remounted']);
  });
});
