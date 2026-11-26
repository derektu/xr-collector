import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { API_ROUTES } from '../../../shared/api/api-routes.js';
import { replacesEverything, staleAfter, type Change, type ChangeBatch, type Resource } from '../api/change-feed.js';
import { createChangeRead, type ChangeRead, type ReadOutcome } from '../api/change-read.js';
import type { ChangeListener, ChangeSource } from '../api/read-until.js';
import { useDepsVersion } from './deps-version.js';

const REOPEN_REFUSED_STREAM_MS = 2000;
const READ_GAP_MS = 1000;

class ChangeHub implements ChangeSource {
  private source: EventSource | null = null;
  private reopen: ReturnType<typeof setTimeout> | undefined;
  private connections = 0;
  private connectedBefore = false;
  private readonly listeners = new Set<ChangeListener>();
  private readonly readEverything = () => this.notify({ kind: 'all' });

  connect(): () => void {
    this.connections += 1;
    if (this.connections === 1) { this.open(); window.addEventListener('online', this.readEverything); }
    return () => {
      this.connections -= 1;
      if (this.connections > 0) return;
      clearTimeout(this.reopen);
      this.source?.close();
      this.source = null;
      window.removeEventListener('online', this.readEverything);
    };
  }

  private open(): void {
    const source = new EventSource(API_ROUTES.events.path);
    source.addEventListener('hello', () => {
      if (this.connectedBefore) this.readEverything();
      this.connectedBefore = true;
    });
    source.addEventListener('change', (event: MessageEvent<string>) => {
      this.notify({ kind: 'changes', changes: (JSON.parse(event.data) as ChangeBatch).changes });
    });
    // External: EventSource reconnects by itself after a network error, but a refused response closes it for good.
    // https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model
    source.addEventListener('error', () => {
      if (source.readyState !== EventSource.CLOSED || this.source !== source) return;
      this.source = null;
      this.reopen = setTimeout(() => { if (this.connections > 0 && !this.source) this.open(); }, REOPEN_REFUSED_STREAM_MS);
    });
    this.source = source;
  }

  listen(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(refresh: Parameters<ChangeListener>[0]): void {
    for (const listener of [...this.listeners]) listener(refresh);
  }
}

export const changeHub = new ChangeHub();

export function useChangeStream(): void {
  useEffect(() => changeHub.connect(), []);
}

export function useChanges(resources: readonly Resource[], matches?: (change: Change) => boolean): number {
  const [tick, setTick] = useState(0);
  const affects = useEffectEvent((change: Change) => staleAfter(resources)(change) && (replacesEverything(change) || (matches?.(change) ?? true)));

  useEffect(() => {
    let lastTickAt = Date.now();
    let gapTimer: ReturnType<typeof setTimeout> | undefined;
    const readAgain = () => {
      if (gapTimer) return;
      gapTimer = setTimeout(() => {
        gapTimer = undefined;
        lastTickAt = Date.now();
        setTick((value) => value + 1);
      }, Math.max(0, lastTickAt + READ_GAP_MS - Date.now()));
    };
    const stop = changeHub.listen((refresh) => {
      if (refresh.kind === 'changes' && !refresh.changes.some((change) => affects(change))) return;
      readAgain();
    });
    return () => {
      stop();
      clearTimeout(gapTimer);
    };
  }, []);

  return tick;
}

export function useChangeRead<T>(tick: number, deps: readonly unknown[], request: (signal: AbortSignal) => Promise<T>,
  answer: (outcome: ReadOutcome<T>) => void, enabled = true): void {
  const version = useDepsVersion([...deps, enabled]);
  const ask = useEffectEvent((signal: AbortSignal) => request(signal));
  const reply = useEffectEvent((outcome: ReadOutcome<T>) => answer(outcome));
  const reads = useRef<ChangeRead | null>(null);

  useEffect(() => {
    const own = createChangeRead<T>((signal) => ask(signal), (outcome) => reply(outcome));
    reads.current = own;
    return () => own.cancel();
  }, [version]);

  useEffect(() => {
    if (enabled) reads.current?.read();
  }, [tick, version, enabled]);
}

export function useLiveRead<T>(resources: readonly Resource[], read: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], options: {
  enabled?: boolean;
} = {}): { value: T | null; error: unknown } {
  const tick = useChanges(resources);
  const [state, setState] = useState<{ value: T | null; error: unknown }>({ value: null, error: null });
  useChangeRead(tick, deps, read, (outcome) => {
    if ('value' in outcome) setState({ value: outcome.value, error: null });
    else setState((previous) => ({ value: previous.value, error: outcome.error }));
  }, options.enabled ?? true);
  return state;
}
