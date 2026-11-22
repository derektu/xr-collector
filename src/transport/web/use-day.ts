import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let today = new Date().toDateString();
let midnight: ReturnType<typeof setTimeout> | undefined;

function waitForMidnight(): void {
  const next = new Date();
  next.setHours(24, 0, 1, 0);
  midnight = setTimeout(() => {
    today = new Date().toDateString();
    for (const listener of [...listeners]) listener();
    waitForMidnight();
  }, next.getTime() - Date.now());
}

export function watchDay(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) { today = new Date().toDateString(); waitForMidnight(); }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearTimeout(midnight);
  };
}

export function useDay(): string {
  return useSyncExternalStore(watchDay, currentDay);
}

export function currentDay(): string {
  return today;
}
