import { useLayoutEffect, type RefObject } from 'react';

export interface MenuRect { top: number; bottom: number; left: number; right: number }
export interface MenuSize { width: number; height: number }
export interface Viewport { width: number; height: number }
export type MenuAlign = 'start' | 'end';

/** Space kept between the menu and its button, and between the menu and the viewport edge. */
const GAP = 4;
const MARGIN = 8;

/**
 * Where a menu opened from `button` goes, in viewport coordinates. It opens below the button and
 * opens above instead when the space below cannot hold it and the space above is larger. `end`
 * lines up the right edges, `start` the left edges; the menu then stays inside the viewport.
 */
export function menuPosition(button: MenuRect, menu: MenuSize, viewport: Viewport, align: MenuAlign): { top: number; left: number } {
  const below = viewport.height - button.bottom - GAP - MARGIN;
  const above = button.top - GAP - MARGIN;
  const top = menu.height > below && above > below
    ? Math.max(MARGIN, button.top - GAP - menu.height)
    : button.bottom + GAP;
  const preferred = align === 'end' ? button.right - menu.width : button.left;
  const left = Math.min(Math.max(MARGIN, preferred), Math.max(MARGIN, viewport.width - MARGIN - menu.width));
  return { top, left };
}

/**
 * Keeps an open `.menu` fixed to the viewport next to its button, so a scrolling or clipping
 * container around the button never cuts it off. The menu follows the button while any container
 * scrolls or the window resizes.
 */
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
