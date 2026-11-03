// Guards the developer, not the user.
// A Desktop flow judges whether the window is shown from the app's own record while the window stays
// hidden, and with the window on screen only when the two agree, so a check that the window hid
// fails when the app showed it, in either mode.
import { describe, expect, it } from 'vitest';
import { shownIn } from '../scripts/lib/electron.mjs';

describe('window shown', () => {
  it('reads the app record while the window stays hidden', () => {
    expect(shownIn({ shown: true, visible: false }, false)).toBe(true);
    expect(shownIn({ shown: false, visible: false }, false)).toBe(false);
  });

  it('needs the window on screen to agree with the app record', () => {
    expect(shownIn({ shown: true, visible: true }, true)).toBe(true);
    expect(shownIn({ shown: false, visible: false }, true)).toBe(false);
    expect(shownIn({ shown: true, visible: false }, true)).toBeNull();
    expect(shownIn({ shown: false, visible: true }, true)).toBeNull();
  });
});
