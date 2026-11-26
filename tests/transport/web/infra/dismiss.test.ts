// Broken, a menu or popover stays open on Escape or an outside click, or closes when clicked inside.
import { describe, expect, it } from 'vitest';
import { dismisses, type DismissRoot } from '../../../../src/transport/web/infra/dismiss.js';

const inside = new EventTarget();
const outside = new EventTarget();
const root: DismissRoot = { contains: (other) => other === inside };

describe('dismisses', () => {
  it('closes on Escape and ignores other keys', () => {
    expect(dismisses({ type: 'keydown', key: 'Escape' }, root)).toBe(true);
    expect(dismisses({ type: 'keydown', key: 'ArrowDown' }, root)).toBe(false);
  });

  it('closes when the pointer goes down outside and stays open when it goes down inside', () => {
    expect(dismisses({ type: 'pointerdown', target: outside }, root)).toBe(true);
    expect(dismisses({ type: 'pointerdown', target: inside }, root)).toBe(false);
  });

  it('closes on any pointer down once the root is gone', () => {
    expect(dismisses({ type: 'pointerdown', target: inside }, null)).toBe(true);
  });
});
