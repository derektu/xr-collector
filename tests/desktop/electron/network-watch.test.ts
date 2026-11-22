import { afterEach, expect, it, vi } from 'vitest';
import { NETWORK_WATCH_MS, watchNetwork } from '../../../src/desktop/electron/network-watch.js';

afterEach(() => vi.useRealTimers());

it("confirms the network as soon as the system's view changes, because the system view alone is inconclusive", async () => {
  vi.useFakeTimers();
  let online = true;
  const check = vi.fn();
  const stop = watchNetwork({ isOnline: () => online, check });

  await vi.advanceTimersByTimeAsync(NETWORK_WATCH_MS * 3);
  expect(check).not.toHaveBeenCalled();
  online = false;
  await vi.advanceTimersByTimeAsync(NETWORK_WATCH_MS);
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(NETWORK_WATCH_MS * 3);
  expect(check).toHaveBeenCalledTimes(1);
  online = true;
  await vi.advanceTimersByTimeAsync(NETWORK_WATCH_MS);
  expect(check).toHaveBeenCalledTimes(2);

  stop();
  online = false;
  await vi.advanceTimersByTimeAsync(NETWORK_WATCH_MS);
  expect(check).toHaveBeenCalledTimes(2);
});
