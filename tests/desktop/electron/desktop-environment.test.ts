import { describe, expect, it } from 'vitest';
import { updateSourceFor, windowsAppId, windowSize } from '../../../src/desktop/electron/desktop-environment.js';

const validationMetadata = { name: 'xr-collector', xrCollectorUpdateRepository: 'derektu/xr-collector-test', xrCollectorAppId: 'com.xrcollector.verify.public' };

describe('desktop environment', () => {
  it('uses the Windows app id baked into a validation package', () => {
    expect(windowsAppId(validationMetadata)).toBe('com.xrcollector.verify.public');
  });

  it('checks the update repository baked into a validation package without inherited environment', async () => {
    const requested: string[] = [];
    const request: typeof fetch = async (input) => { requested.push(String(input)); throw new Error('offline'); };
    await expect(updateSourceFor({}, validationMetadata, request).check({ version: '0.1.0', target: 'mac-arm64' } as never)).rejects.toThrow();
    expect(requested).toEqual(['https://api.github.com/repos/derektu/xr-collector-test/releases/latest']);
    expect(updateSourceFor({ XR_COLLECTOR_UPDATE_BASE_URL: 'http://127.0.0.1:9/releases/' }, validationMetadata, fetch).id).toBe('generic-index');
  });

  it('rejects a malformed package repository even when XR_COLLECTOR_UPDATE_BASE_URL overrides the source', () => {
    const malformed = { xrCollectorUpdateRepository: 'not a repository' };
    expect(() => updateSourceFor({ XR_COLLECTOR_UPDATE_BASE_URL: 'http://127.0.0.1:9/releases/' }, malformed, fetch)).toThrow(/owner\/name/u);
  });

  it('sizes the window from XR_COLLECTOR_VALIDATION_WINDOW_SIZE and falls back to 1240x820', () => {
    expect(windowSize({})).toEqual({ width: 1240, height: 820 });
    expect(windowSize({ XR_COLLECTOR_VALIDATION_WINDOW_SIZE: '1440x900' })).toEqual({ width: 1440, height: 900 });
    expect(windowSize({ XR_COLLECTOR_VALIDATION_WINDOW_SIZE: '1440 x 900' })).toEqual({ width: 1240, height: 820 });
  });
});
