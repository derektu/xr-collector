import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let today = startOfToday();
function startOfToday(): Date {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day;
}

let midnight: ReturnType<typeof setTimeout> | undefined;

function waitForMidnight(): void {
  const next = new Date();
  next.setHours(24, 0, 1, 0);
  midnight = setTimeout(() => {
    today = startOfToday();
    for (const listener of [...listeners]) listener();
    waitForMidnight();
  }, next.getTime() - Date.now());
}

export function watchDay(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) { today = startOfToday(); waitForMidnight(); }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearTimeout(midnight);
  };
}

export function useDay(): Date {
  return useSyncExternalStore(watchDay, currentDay);
}

export function currentDay(): Date {
  return today;
}
