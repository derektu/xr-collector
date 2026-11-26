import { useEffectEvent, useLayoutEffect, type RefObject } from 'react';

export interface AnchorRect { top: number; bottom: number; left: number; right: number }
export interface Size { width: number; height: number }
export interface Position { top: number; left: number }
export type MenuAlign = 'start' | 'end';
export type Place = (anchor: AnchorRect, floating: Size, viewport: Size) => Position;

const BUTTON_GAP = 4;
const VIEWPORT_MARGIN = 8;

export function menuPosition(button: AnchorRect, menu: Size, viewport: Size, align: MenuAlign): Position {
  const below = viewport.height - button.bottom - BUTTON_GAP - VIEWPORT_MARGIN;
  const above = button.top - BUTTON_GAP - VIEWPORT_MARGIN;
  const top = menu.height > below && above > below
    ? Math.max(VIEWPORT_MARGIN, button.top - BUTTON_GAP - menu.height)
    : button.bottom + BUTTON_GAP;
  const preferred = align === 'end' ? button.right - menu.width : button.left;
  const left = Math.min(Math.max(VIEWPORT_MARGIN, preferred), Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - menu.width));
  return { top, left };
}

export function menuPlace(align: MenuAlign = 'end'): Place {
  return (button, menu, viewport) => menuPosition(button, menu, viewport, align);
}

export function useFloatingPosition(open: boolean, anchor: RefObject<HTMLElement | null>, floating: RefObject<HTMLElement | null>, place: Place): void {
  const position = useEffectEvent(() => {
    const element = floating.current;
    if (!anchor.current || !element) return;
    const { top, left } = place(anchor.current.getBoundingClientRect(),
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight });
    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
  });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const reposition = () => position();
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);
}
