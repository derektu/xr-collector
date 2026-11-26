import { replacesEverything, type Change, type Refresh } from './change-feed.js';

export type ChangeListener = (refresh: Refresh) => void;

export interface ChangeSource {
  listen(listener: ChangeListener): () => void;
}

export function readUntil<T>(hub: ChangeSource, read: () => Promise<T>, done: (value: T) => boolean, matches: (change: Change) => boolean, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let reading = false;
    let again = false;
    const look = (): void => {
      if (reading) { again = true; return; }
      reading = true;
      const next = (): void => { reading = false; if (again) { again = false; look(); } };
      read().then((value) => {
        if (done(value)) { reading = false; stop(); resolve(value); } else next();
      }, next);
    };
    const stopListening = hub.listen((refresh) => {
      if (refresh.kind === 'all' || refresh.changes.some((change) => replacesEverything(change) || matches(change))) look();
    });
    const abort = (): void => { stop(); reject(signal!.reason); };
    const stop = (): void => { stopListening(); signal?.removeEventListener('abort', abort); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    look();
  });
}
