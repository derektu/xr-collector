import { useCallback, useEffect, useRef, useState } from 'react';
import { receive, replacesEverything, staleAfter, type Change, type Refresh, type Resource, type StreamMessage } from './change-feed.js';

type Listener = (refresh: Exclude<Refresh, { kind: 'none' }>) => void;
type Pending = { since: number; done: () => void; failed: boolean };
/**
 * A screen's reads: how many it has tracked and not yet seen end, whether a change waits for them,
 * when the last tick started, and the timer that holds a tick until `READ_GAP_MS` has passed.
 */
type Flight = { count: number; queued: boolean; last: number; timer?: ReturnType<typeof setTimeout>; next: (() => void) | null };

/** How long the window waits before opening the stream again after the server refused it. */
const REOPEN_MS = 2000;
/** The shortest time between two ticks of one screen; changes meanwhile share the next tick. */
export const READ_GAP_MS = 1000;

/**
 * The window's one connection to the server's change stream. Screens register what makes their
 * data stale; each one counts as behind from the moment such a change arrives until the read it
 * started for it succeeds. A screen whose read failed stays behind and reads again once the stream
 * reconnects or the browser is back online. The root element's `data-revision` names the newest
 * revision every screen has caught up with, so tests and people can tell the screen shows that
 * revision; while any screen is behind it is absent. A stream the server refused opens again after
 * a pause, from the last revision received.
 */
class ChangeHub {
  private revision: string | null = null;
  private source: EventSource | null = null;
  private reopen: ReturnType<typeof setTimeout> | undefined;
  private connections = 0;
  private readonly listeners = new Set<Listener>();
  private readonly retries = new Set<() => void>();
  private behind = 0;
  private readonly retry = () => { for (const listener of [...this.retries]) listener(); };

  connect(): () => void {
    this.connections += 1;
    if (this.connections === 1) { this.open(); window.addEventListener('online', this.retry); }
    return () => {
      this.connections -= 1;
      if (this.connections > 0) return;
      clearTimeout(this.reopen);
      this.source?.close();
      this.source = null;
      window.removeEventListener('online', this.retry);
    };
  }

  private open(): void {
    const source = new EventSource(this.revision ? `/api/events?after=${encodeURIComponent(this.revision)}` : '/api/events');
    const handle = (type: StreamMessage['type']) => (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { revision: string };
      this.receive(type === 'change' ? { type, batch: data as never } : { type, revision: data.revision } as StreamMessage);
    };
    for (const type of ['hello', 'reset', 'change'] as const) source.addEventListener(type, handle(type));
    // The browser reconnects by itself after a dropped connection, but not after a refused one.
    source.addEventListener('error', () => {
      if (source.readyState !== EventSource.CLOSED || this.source !== source) return;
      this.source = null;
      this.reopen = setTimeout(() => { if (this.connections > 0 && !this.source) this.open(); }, REOPEN_MS);
    });
    this.source = source;
  }

  /** Calls `listener` each time reads that failed may succeed again: the stream connected again, or the browser is back online. */
  onRetry(listener: () => void): () => void {
    this.retries.add(listener);
    return () => { this.retries.delete(listener); };
  }

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Marks one screen behind; the returned function marks it caught up again. */
  fallBehind(): () => void {
    this.behind += 1;
    delete document.documentElement.dataset.revision;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.behind -= 1;
      this.publish();
    };
  }

  private receive(message: StreamMessage): void {
    const next = receive(this.revision, message);
    this.revision = next.revision;
    const refresh = next.refresh;
    if (refresh.kind !== 'none') for (const listener of [...this.listeners]) listener(refresh);
    if (message.type === 'hello') this.retry();
    this.publish();
  }

  private publish(): void {
    if (this.behind === 0 && this.revision) document.documentElement.dataset.revision = this.revision;
  }
}

export const changeHub = new ChangeHub();

/** Keeps the window's change stream open while the shell is mounted. */
export function useChangeStream(): void {
  useEffect(() => changeHub.connect(), []);
}

/**
 * Reads until `done` accepts the answer, reading again after each change that `matches` (one read
 * at a time). A failed read runs again after the next such change, or once reads may succeed again.
 * Rejects only when `signal` aborts.
 */
export function readUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, matches: (change: Change) => boolean, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let reading = false;
    let again = false;
    let failed = false;
    const look = (): void => {
      if (reading) { again = true; return; }
      reading = true;
      failed = false;
      const next = (): void => { reading = false; if (again) { again = false; look(); } };
      read().then((value) => {
        if (done(value)) { reading = false; stop(); resolve(value); } else next();
      }, () => { failed = true; next(); });
    };
    // Listening starts before the first read, so a change while it runs is not missed.
    const stopListening = changeHub.listen((refresh) => {
      if (refresh.kind === 'all' || refresh.changes.some((change) => replacesEverything(change) || matches(change))) look();
    });
    const stopRetry = changeHub.onRetry(() => { if (failed) look(); });
    const abort = (): void => { stop(); reject(signal!.reason); };
    const stop = (): void => { stopListening(); stopRetry(); signal?.removeEventListener('abort', abort); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    look();
  });
}

/**
 * A screen's view of the changes that make `resources` stale: `tick` grows with each one, and
 * `track` takes the read the screen starts for the current tick. The screen counts as caught up
 * once that read resolves; a read that rejects leaves it behind, and `tick` grows again when reads
 * may succeed again. The first read after mounting counts the same way. A screen that skips
 * reading for a tick passes `track` an already resolved promise. `matches` narrows the changes to
 * the ones about what the screen shows; a Vault whose data was replaced always counts. While a
 * tracked read runs, `tick` holds still: changes meanwhile grow it once, after the read ends and
 * at least `READ_GAP_MS` after the previous tick, so changes faster than a read cannot keep the
 * screen from showing an answer. The screen counts as behind while a change waits.
 */
export function useChanges(resources: readonly Resource[], matches?: (change: Change) => boolean): {
  tick: number; track: (work: Promise<unknown>) => void;
} {
  const [tick, setTick] = useState(0);
  const tickRef = useRef(0);
  const pending = useRef<Pending | null>(null);
  const flight = useRef<Flight>({ count: 0, queued: false, last: 0, next: null });
  const key = resources.join(',');
  const filter = useRef(matches);
  filter.current = matches;

  useEffect(() => {
    const stale = staleAfter(resources);
    const reads: Flight = { count: 0, queued: false, last: Date.now(), next: null };
    flight.current = reads;
    const behind = (since: number) => {
      pending.current ??= { since, done: changeHub.fallBehind(), failed: false };
      pending.current.since = since;
      pending.current.failed = false;
    };
    reads.next = () => {
      if (!reads.queued || reads.count > 0 || reads.timer) return;
      const wait = reads.last + READ_GAP_MS - Date.now();
      if (wait > 0) { reads.timer = setTimeout(() => { reads.timer = undefined; reads.next?.(); }, wait); return; }
      reads.queued = false;
      reads.last = Date.now();
      tickRef.current += 1;
      behind(tickRef.current);
      setTick(tickRef.current);
    };
    const readAgain = () => {
      reads.queued = true;
      behind(tickRef.current + 1);
      reads.next!();
    };
    behind(tickRef.current);
    const stop = changeHub.listen((refresh) => {
      if (refresh.kind === 'changes' && !refresh.changes.some((change) => stale(change) && (replacesEverything(change) || (filter.current?.(change) ?? true)))) return;
      readAgain();
    });
    const stopRetry = changeHub.onRetry(() => { if (pending.current?.failed) readAgain(); });
    return () => {
      stop();
      stopRetry();
      clearTimeout(reads.timer);
      reads.next = null;
      pending.current?.done();
      pending.current = null;
    };
  }, [key]);

  const track = useCallback((work: Promise<unknown>): void => {
    const startedAt = tickRef.current;
    // A read started before the screen remounted answers for the previous mount only.
    const owner = pending.current;
    const reads = flight.current;
    reads.count += 1;
    const current = () => !!owner && pending.current === owner && startedAt >= owner.since;
    const ended = () => {
      reads.count -= 1;
      reads.next?.();
    };
    void work.then(() => {
      if (current()) { owner!.done(); pending.current = null; }
      ended();
    }, () => {
      if (current()) owner!.failed = true;
      ended();
    });
  }, []);
  return { tick, track };
}

/**
 * Reads data that `resources` changes make stale: once on mount and when `deps` change (aborting a
 * read in flight), and again after each such change. A change during a read waits for it to end
 * (see `useChanges`), so frequent changes cannot keep the data from arriving. `enabled` false keeps
 * the last value and reads nothing.
 */
export function useLiveRead<T>(resources: readonly Resource[], read: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], options: {
  enabled?: boolean;
} = {}): { value: T | null; error: unknown } {
  const { tick, track } = useChanges(resources);
  const [state, setState] = useState<{ value: T | null; error: unknown }>({ value: null, error: null });
  const latest = useRef(read);
  latest.current = read;
  const controller = useRef<AbortController | null>(null);
  const enabled = options.enabled ?? true;
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; controller.current?.abort(); controller.current = null; };
  }, [...deps, enabled]);

  useEffect(() => {
    if (!enabled) { track(Promise.resolve()); return; }
    const owner = generation.current;
    // Aborted when the deps change or the screen unmounts, by the effect above.
    const reads = new AbortController();
    controller.current = reads;
    const reading = latest.current(reads.signal);
    track(reading);
    void reading.then(
      (value) => { if (generation.current === owner) setState({ value, error: null }); },
      (error: unknown) => { if (generation.current === owner && !reads.signal.aborted) setState((previous) => ({ value: previous.value, error })); },
    );
  }, [tick, ...deps, enabled]);

  return state;
}
