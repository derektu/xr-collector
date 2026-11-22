import { describe, expect, it } from 'vitest';
import { createCatchUp } from '../../../src/transport/web/catch-up.js';

describe('createCatchUp', () => {
  it('hides the shown revision while any screen is behind so checks wait for every screen, and shows the newest received once all catch up', () => {
    const catchUp = createCatchUp();
    expect(catchUp.receive('ab:1')).toBe('ab:1');
    const first = catchUp.fallBehind();
    const second = catchUp.fallBehind();
    expect(catchUp.receive('ab:2')).toBeNull();
    expect(first()).toBeNull();
    expect(first()).toBeNull();
    expect(catchUp.receive('ab:3')).toBeNull();
    expect(second()).toBe('ab:3');
  });
});
