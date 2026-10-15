import { describe, expect, it } from 'vitest';
import {
  createBrowserThemeStore,
  radioIndexForKey,
  resolveTheme,
  routeForPath,
  themePreferenceFromValue,
} from '../../src/web/app-shell.js';

describe('App Shell routes', () => {
  it('normalizes known routes and returns unknown routes to Sources', () => {
    expect(routeForPath('/')).toBe('sources');
    expect(routeForPath('/documents')).toBe('documents');
    expect(routeForPath('/settings/')).toBe('settings');
    expect(routeForPath('/activity')).toBe('activity');
    expect(routeForPath('/documents/youtube%3Aabc')).toBe('documents');
    expect(routeForPath('/sources/youtube/UC123')).toBe('sources');
    expect(routeForPath('/not-a-page')).toBe('sources');
  });
});

describe('theme preference', () => {
  it('reads system, dark and light, and follows the system for missing or invalid values', () => {
    expect(themePreferenceFromValue('system')).toBe('system');
    expect(themePreferenceFromValue('dark')).toBe('dark');
    expect(themePreferenceFromValue('light')).toBe('light');
    expect(themePreferenceFromValue(null)).toBe('system');
    expect(themePreferenceFromValue('unexpected')).toBe('system');
  });

  it('shows the system appearance only when following the system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('radio group keys', () => {
  it('moves with wrapping arrows and jumps with Home and End', () => {
    expect(radioIndexForKey('ArrowRight', 0, 3)).toBe(1);
    expect(radioIndexForKey('ArrowDown', 2, 3)).toBe(0);
    expect(radioIndexForKey('ArrowLeft', 0, 3)).toBe(2);
    expect(radioIndexForKey('ArrowUp', 1, 3)).toBe(0);
    expect(radioIndexForKey('Home', 2, 3)).toBe(0);
    expect(radioIndexForKey('End', 0, 3)).toBe(2);
    expect(radioIndexForKey('Tab', 1, 3)).toBeNull();
    expect(radioIndexForKey(' ', 1, 3)).toBeNull();
  });
});

describe('browser theme persistence', () => {
  it('keeps stored choices, follows the system for invalid values and reports write failures', async () => {
    const values = new Map<string, string>([['xr-collector.theme', 'invalid']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw new Error('storage is unavailable'); },
    };
    const store = createBrowserThemeStore(storage);

    await expect(store.read()).resolves.toBe('system');
    values.set('xr-collector.theme', 'dark');
    await expect(store.read()).resolves.toBe('dark');
    await expect(store.write('light')).rejects.toThrow('storage is unavailable');
  });
});
