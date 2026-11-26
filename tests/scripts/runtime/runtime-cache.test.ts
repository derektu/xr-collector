// Where the runtime archives are cached: one cache per user outside every checkout, so a second
// checkout installs the same pins without downloading, and an override that is not an absolute path
// is refused rather than resolved against whatever directory a command runs in.
import { expect, it } from 'vitest';
// @ts-expect-error The script is executable JavaScript without type declarations.
import { runtimeCacheRoot } from '../../../scripts/runtime/runtime-cache.mjs';

it('places the shared runtime cache outside the checkout, per user, with an absolute override', () => {
  expect(runtimeCacheRoot({}, 'darwin', '/Users/dev')).toBe('/Users/dev/.cache/xr-collector/runtime');
  expect(runtimeCacheRoot({}, 'linux', '/home/dev')).toBe('/home/dev/.cache/xr-collector/runtime');
  expect(runtimeCacheRoot({ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'win32', 'C:\\Users\\dev')).toBe('C:\\Users\\dev\\AppData\\Local\\xr-collector\\runtime');
  expect(runtimeCacheRoot({ XR_COLLECTOR_RUNTIME_CACHE: '/Volumes/cache/xr' }, 'darwin', '/Users/dev')).toBe('/Volumes/cache/xr');
  expect(() => runtimeCacheRoot({ XR_COLLECTOR_RUNTIME_CACHE: 'relative/cache' }, 'darwin', '/Users/dev')).toThrow(/absolute path/u);
  expect(() => runtimeCacheRoot({}, 'win32', 'C:\\Users\\dev')).toThrow(/LOCALAPPDATA/u);
});
