import { useEffect, useEffectEvent, useState } from 'react';
import { useDepsVersion } from './deps-version.js';

export interface ReadState<T> {
  value: T | null;
  error: unknown;
  pending: boolean;
}

export function useRead<T>(request: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], options: { enabled?: boolean } = {}): ReadState<T> {
  const enabled = options.enabled ?? true;
  const version = useDepsVersion(deps);
  const [state, setState] = useState<{ value: T | null; error: unknown; settled: number | null }>({ value: null, error: null, settled: null });
  const ask = useEffectEvent((signal: AbortSignal) => request(signal));

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    ask(controller.signal).then((value) => {
      if (!controller.signal.aborted) setState({ value, error: null, settled: version });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setState((previous) => ({ value: previous.value, error, settled: version }));
    });
    return () => controller.abort();
  }, [version, enabled]);

  return { value: state.value, error: state.error, pending: enabled && state.settled !== version };
}
