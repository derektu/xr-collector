import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { DesktopNavigationTarget } from '../desktop-navigation.js';

export function useWindowEvent<K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void): void {
  const handle = useEffectEvent((event: WindowEventMap[K]) => listener(event));
  useEffect(() => {
    const forward = (event: WindowEventMap[K]) => handle(event);
    window.addEventListener(type, forward);
    return () => window.removeEventListener(type, forward);
  }, [type]);
}

export function useDesktopNavigation(listener: (target: DesktopNavigationTarget | 'settings' | 'update') => void): void {
  const handle = useEffectEvent((target: DesktopNavigationTarget | 'settings' | 'update') => listener(target));
  const connected = useRef(false);
  useEffect(() => {
    const desktop = window.xrCollectorDesktop;
    if (connected.current || !desktop) return;
    connected.current = true;
    desktop.onNavigate((target) => handle(target));
    desktop.navigationReady();
  }, []);
}

export function useUnmountSignal(): () => AbortSignal {
  const [first] = useState(() => new AbortController());
  const mounted = useRef(first);
  useEffect(() => {
    if (mounted.current.signal.aborted) mounted.current = new AbortController();
    const own = mounted.current;
    return () => own.abort();
  }, []);
  return useCallback(() => mounted.current.signal, []);
}

export function useFocusAfterChange(key: string, target: () => HTMLElement | null | undefined): void {
  const find = useEffectEvent(() => target());
  useEffect(() => {
    const frame = requestAnimationFrame(() => find()?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [key]);
}
