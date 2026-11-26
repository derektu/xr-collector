import { useEffect, useEffectEvent, useState } from 'react';

export type StartTimer = (run: () => void, ms: number) => () => void;

const startBrowserTimer: StartTimer = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

const UNARMED = Symbol('unarmed');

export class Countdown {
  private stop: (() => void) | null = null;
  private armed: { ms: number; key: unknown } | typeof UNARMED = UNARMED;
  private run: () => void = () => undefined;

  constructor(private readonly start: StartTimer = startBrowserTimer) {}

  sync(ms: number | null, key: unknown, run: () => void): void {
    this.run = run;
    if (ms === null) { this.dispose(); return; }
    if (this.armed !== UNARMED && this.armed.ms === ms && Object.is(this.armed.key, key)) return;
    this.stop?.();
    this.armed = { ms, key };
    this.stop = this.start(() => {
      this.stop = null;
      this.run();
    }, ms);
  }

  dispose(): void {
    this.stop?.();
    this.stop = null;
    this.armed = UNARMED;
  }
}

export function useTimeout(callback: () => void, ms: number | null, restartKey?: unknown): void {
  const [countdown] = useState(() => new Countdown());
  const fire = useEffectEvent(() => callback());
  useEffect(() => {
    countdown.sync(ms, restartKey, () => fire());
  });
  useEffect(() => () => countdown.dispose(), [countdown]);
}

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useTimeout(() => setSettled(value), Object.is(value, settled) ? null : ms, value);
  return settled;
}
