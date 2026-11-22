import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { watchSleep } from '../../../src/desktop/electron/sleep-watch.js';

it('ends the sleep pause when the person unlocks or becomes active, so a resume the OS never sends cannot hold collection back', () => {
  const power = new EventEmitter();
  const pause = { asleep: vi.fn(), awake: vi.fn() };
  watchSleep(power, pause);

  power.emit('suspend');
  expect(pause.asleep).toHaveBeenCalledTimes(1);
  power.emit('unlock-screen');
  power.emit('user-did-become-active');
  power.emit('resume');
  expect(pause.awake).toHaveBeenCalledTimes(3);
});

it('stops hearing every power event once stopped, so a quitting app no longer pauses or resumes collection', () => {
  const power = new EventEmitter();
  const pause = { asleep: vi.fn(), awake: vi.fn() };
  const stop = watchSleep(power, pause);
  stop();

  for (const event of ['suspend', 'resume', 'unlock-screen', 'user-did-become-active']) power.emit(event);
  expect(pause.asleep).not.toHaveBeenCalled();
  expect(pause.awake).not.toHaveBeenCalled();
  expect(power.eventNames()).toEqual([]);
});
