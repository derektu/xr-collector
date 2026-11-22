import { useLayoutEffect, type RefObject } from 'react';

export interface MenuRect { top: number; bottom: number; left: number; right: number }
export interface MenuSize { width: number; height: number }
export interface Viewport { width: number; height: number }
export type MenuAlign = 'start' | 'end';

const BUTTON_GAP = 4;
const VIEWPORT_MARGIN = 8;

export function menuPosition(button: MenuRect, menu: MenuSize, viewport: Viewport, align: MenuAlign): { top: number; left: number } {
  const below = viewport.height - button.bottom - BUTTON_GAP - VIEWPORT_MARGIN;
  const above = button.top - BUTTON_GAP - VIEWPORT_MARGIN;
  const top = menu.height > below && above > below
    ? Math.max(VIEWPORT_MARGIN, button.top - BUTTON_GAP - menu.height)
    : button.bottom + BUTTON_GAP;
  const preferred = align === 'end' ? button.right - menu.width : button.left;
  const left = Math.min(Math.max(VIEWPORT_MARGIN, preferred), Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - menu.width));
  return { top, left };
}

export function useFloatingMenu(open: boolean, button: RefObject<HTMLElement | null>, menu: RefObject<HTMLElement | null>, align: MenuAlign = 'end'): void {
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const anchor = button.current;
      const element = menu.current;
      if (!anchor || !element) return;
      const { top, left } = menuPosition(anchor.getBoundingClientRect(),
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }, align);
      element.style.top = `${top}px`;
      element.style.left = `${left}px`;
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, button, menu, align]);
}
