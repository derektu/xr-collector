// Broken, a validation package's notifications and login startup act on the production App.
import { describe, expect, it } from 'vitest';
import { appIdOf, windowSize } from '../../../src/desktop/electron/desktop-environment.js';

describe('desktop environment', () => {
  it.each([
    [{ name: 'xr-collector' }, 'com.moneydj.xrcollector'],
    [{ name: 'xr-collector', xrCollectorAppId: 'com.xrcollector.verify.public' }, 'com.xrcollector.verify.public'],
  ])('reads the appId a package was built under from %o', (metadata, appId) => {
    expect(appIdOf(metadata)).toBe(appId);
  });

  it('sizes the window from XR_COLLECTOR_VALIDATION_WINDOW_SIZE and falls back to 1240x820', () => {
    expect(windowSize({})).toEqual({ width: 1240, height: 820 });
    expect(windowSize({ XR_COLLECTOR_VALIDATION_WINDOW_SIZE: '1440x900' })).toEqual({ width: 1440, height: 900 });
    expect(windowSize({ XR_COLLECTOR_VALIDATION_WINDOW_SIZE: '1440 x 900' })).toEqual({ width: 1240, height: 820 });
  });
});
