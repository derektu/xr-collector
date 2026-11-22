export const NETWORK_WATCH_MS = 5_000;

export interface NetworkWatchOptions {
  isOnline: () => boolean;
  check: () => void;
}

export function watchNetwork({ isOnline, check }: NetworkWatchOptions): () => void {
  let online = isOnline();
  const timer = setInterval(() => {
    const now = isOnline();
    if (now === online) return;
    online = now;
    check();
  }, NETWORK_WATCH_MS);
  return () => clearInterval(timer);
}
