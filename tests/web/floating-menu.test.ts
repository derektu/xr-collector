import { describe, expect, it } from 'vitest';
import { menuPosition } from '../../src/web/floating-menu.js';

const viewport = { width: 1000, height: 700 };
const menu = { width: 150, height: 120 };
const button = (top: number, left: number) => ({ top, bottom: top + 30, left, right: left + 30 });

describe('menuPosition', () => {
  it('opens below the button, right edges lined up', () => {
    expect(menuPosition(button(100, 800), menu, viewport, 'end')).toEqual({ top: 134, left: 680 });
  });

  it('lines up left edges for start', () => {
    expect(menuPosition(button(100, 40), menu, viewport, 'start')).toEqual({ top: 134, left: 40 });
  });

  it('opens above when the space below cannot hold the menu', () => {
    expect(menuPosition(button(600, 800), menu, viewport, 'end')).toEqual({ top: 476, left: 680 });
  });

  it('stays below when there is even less space above', () => {
    expect(menuPosition(button(20, 800), { width: 150, height: 690 }, viewport, 'end').top).toBe(54);
  });

  it('stays inside the viewport horizontally', () => {
    expect(menuPosition(button(100, 0), menu, viewport, 'end').left).toBe(8);
    expect(menuPosition(button(100, 960), menu, viewport, 'start').left).toBe(842);
  });
});
