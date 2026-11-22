import { useCallback, useEffect, useRef, useState } from 'react';
import { API_ROUTES } from '../../shared/api/api-routes.js';
import { createCatchUp, type ShownRevision } from './catch-up.js';
import { receive, replacesEverything, staleAfter, type Change, type Resource, type StreamMessage } from './change-feed.js';
import { createLatestRequest } from './latest-request.js';
import type { ChangeListener, ChangeSource } from './read-until.js';

type Pending = { since: number; done: () => void; failed: boolean };
type Flight = {
  readsRunning: number;
  changeWaiting: boolean;
  lastTickAt: number;
  gapTimer?: ReturnType<typeof setTimeout>;
  tickWhenReady: (() => void) | null;
};

const REOPEN_REFUSED_STREAM_MS = 2000;
export const READ_GAP_MS = 1000;

class ChangeHub implements ChangeSource {
  private revision: string | null = null;
  private source: EventSource | null = null;
  private reopen: ReturnType<typeof setTimeout> | undefined;
  private connections = 0;
  private readonly listeners = new Set<ChangeListener>();
  private readonly reachableAgainListeners = new Set<() => void>();
  private readonly catchUp = createCatchUp();
  private readonly reachableAgain = () => { for (const listener of [...this.reachableAgainListeners]) listener(); };

  connect(): () => void {
    this.connections += 1;
    if (this.connections === 1) { this.open(); window.addEventListener('online', this.reachableAgain); }
    return () => {
      this.connections -= 1;
      if (this.connections > 0) return;
      clearTimeout(this.reopen);
      this.source?.close();
      this.source = null;
      window.removeEventListener('online', this.reachableAgain);
    };
  }

  private open(): void {
    const source = new EventSource(this.revision ? `${API_ROUTES.events.path}?after=${encodeURIComponent(this.revision)}` : API_ROUTES.events.path);
    const handle = (type: StreamMessage['type']) => (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { revision: string };
      this.receive(type === 'change' ? { type, batch: data as never } : { type, revision: data.revision } as StreamMessage);
    };
    for (const type of ['hello', 'reset', 'change'] as const) source.addEventListener(type, handle(type));
    // EventSource reconnects by itself after a network error, but a refused response closes it for good.
    // https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model
    source.addEventListener('error', () => {
      if (source.readyState !== EventSource.CLOSED || this.source !== source) return;
      this.source = null;
      this.reopen = setTimeout(() => { if (this.connections > 0 && !this.source) this.open(); }, REOPEN_REFUSED_STREAM_MS);
    });
    this.source = source;
  }

  onReachableAgain(listener: () => void): () => void {
    this.reachableAgainListeners.add(listener);
    return () => { this.reachableAgainListeners.delete(listener); };
  }

  listen(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  fallBehind(): () => void {
    const done = this.catchUp.fallBehind();
    showRevision(null);
    return () => showRevision(done());
  }

  private receive(message: StreamMessage): void {
    const next = receive(this.revision, message);
    this.revision = next.revision;
    const refresh = next.refresh;
    if (refresh.kind !== 'none') for (const listener of [...this.listeners]) listener(refresh);
    if (message.type === 'hello') this.reachableAgain();
    showRevision(this.catchUp.receive(this.revision));
  }
}

function showRevision(revision: ShownRevision): void {
  if (revision) document.documentElement.dataset.revision = revision;
  else delete document.documentElement.dataset.revision;
}

export const changeHub = new ChangeHub();

export function useChangeStream(): void {
  useEffect(() => changeHub.connect(), []);
}

export function useChanges(resources: readonly Resource[], matches?: (change: Change) => boolean): {
  tick: number; track: (work: Promise<unknown>) => void;
} {
  const [tick, setTick] = useState(0);
  const tickRef = useRef(0);
  const pending = useRef<Pending | null>(null);
  const flight = useRef<Flight>({ readsRunning: 0, changeWaiting: false, lastTickAt: 0, tickWhenReady: null });
  const key = resources.join(',');
  const filter = useRef(matches);
  filter.current = matches;

  useEffect(() => {
    const stale = staleAfter(resources);
    const reads: Flight = { readsRunning: 0, changeWaiting: false, lastTickAt: Date.now(), tickWhenReady: null };
    flight.current = reads;
    const behind = (since: number) => {
      pending.current ??= { since, done: changeHub.fallBehind(), failed: false };
      pending.current.since = since;
      pending.current.failed = false;
    };
    reads.tickWhenReady = () => {
      if (!reads.changeWaiting || reads.readsRunning > 0 || reads.gapTimer) return;
      const wait = reads.lastTickAt + READ_GAP_MS - Date.now();
      if (wait > 0) { reads.gapTimer = setTimeout(() => { reads.gapTimer = undefined; reads.tickWhenReady?.(); }, wait); return; }
      reads.changeWaiting = false;
      reads.lastTickAt = Date.now();
      tickRef.current += 1;
      behind(tickRef.current);
      setTick(tickRef.current);
    };
    const readAgain = () => {
      reads.changeWaiting = true;
      behind(tickRef.current + 1);
      reads.tickWhenReady!();
    };
    behind(tickRef.current);
    const stop = changeHub.listen((refresh) => {
      if (refresh.kind === 'changes' && !refresh.changes.some((change) => stale(change) && (replacesEverything(change) || (filter.current?.(change) ?? true)))) return;
      readAgain();
    });
    const stopReachableAgain = changeHub.onReachableAgain(() => { if (pending.current?.failed) readAgain(); });
    return () => {
      stop();
      stopReachableAgain();
      clearTimeout(reads.gapTimer);
      reads.tickWhenReady = null;
      pending.current?.done();
      pending.current = null;
    };
  }, [key]);

  const track = useCallback((work: Promise<unknown>): void => {
    const startedAt = tickRef.current;
    const owner = pending.current;
    const reads = flight.current;
    reads.readsRunning += 1;
    const current = () => !!owner && pending.current === owner && startedAt >= owner.since;
    const ended = () => {
      reads.readsRunning -= 1;
      reads.tickWhenReady?.();
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

export function useLiveRead<T>(resources: readonly Resource[], read: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], options: {
  enabled?: boolean;
} = {}): { value: T | null; error: unknown } {
  const { tick, track } = useChanges(resources);
  const [state, setState] = useState<{ value: T | null; error: unknown }>({ value: null, error: null });
  const latest = useRef(read);
  latest.current = read;
  const [requests] = useState(createLatestRequest);
  const enabled = options.enabled ?? true;

  useEffect(() => () => requests.cancel(), [requests]);

  useEffect(() => {
    if (!enabled) { requests.cancel(); track(Promise.resolve()); return; }
    void requests.run((signal) => {
      const reading = latest.current(signal);
      track(reading);
      return reading;
    }).then(
      (answer) => { if (answer.current) setState({ value: answer.value, error: null }); },
      (error: unknown) => setState((previous) => ({ value: previous.value, error })),
    );
  }, [tick, ...deps, enabled]);

  return state;
}
