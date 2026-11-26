import { useEffect, useEffectEvent, type RefObject } from 'react';

export interface DismissRoot {
  contains(other: EventTarget | null): boolean;
}

export type DismissEvent = { type: 'keydown'; key: string } | { type: 'pointerdown'; target: EventTarget | null };

export function dismisses(event: DismissEvent, root: DismissRoot | null): boolean {
  if (event.type === 'keydown') return event.key === 'Escape';
  return !root?.contains(event.target);
}

export function useDismiss(open: boolean, root: RefObject<DismissRoot | null>, onDismiss: () => void): void {
  const dismiss = useEffectEvent(() => onDismiss());
  useEffect(() => {
    if (!open) return undefined;
    const pointer = (event: PointerEvent) => { if (dismisses({ type: 'pointerdown', target: event.target }, root.current)) dismiss(); };
    const key = (event: KeyboardEvent) => { if (dismisses({ type: 'keydown', key: event.key }, root.current)) dismiss(); };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [open, root]);
}
