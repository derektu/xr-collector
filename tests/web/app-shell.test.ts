import { describe, expect, it } from 'vitest';
import {
  createBrowserThemeStore,
  createSourceRegistry,
  defaultTheme,
  routeForPath,
  themeFromValue,
} from '../../src/web/app-shell.js';

describe('App Shell routes', () => {
  it('normalizes known routes and returns unknown routes to Sources', () => {
    expect(routeForPath('/')).toBe('sources');
    expect(routeForPath('/documents')).toBe('documents');
    expect(routeForPath('/settings/')).toBe('settings');
    expect(routeForPath('/not-a-page')).toBe('sources');
  });
});

describe('source registry', () => {
  it('keeps test-only sources out of the public Sources page', () => {
    const registry = createSourceRegistry([
      { id: 'youtube', label: 'YouTube', availability: 'available' },
      { id: 'fixture', label: 'Fixture source', availability: 'test-only' },
    ]);

    expect(registry.publicSources()).toEqual([
      { id: 'youtube', label: 'YouTube', availability: 'available' },
    ]);
    expect(registry.get('fixture')).toMatchObject({ id: 'fixture', availability: 'test-only' });
  });
});

describe('browser theme persistence', () => {
  it('uses dark for missing or invalid values and reports write failures', async () => {
    const values = new Map<string, string>([['xr-collector.theme', 'invalid']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw new Error('storage is unavailable'); },
    };
    const store = createBrowserThemeStore(storage);

    await expect(store.read()).resolves.toBe(defaultTheme);
    expect(themeFromValue('light')).toBe('light');
    expect(themeFromValue('unexpected')).toBe(defaultTheme);
    await expect(store.write('light')).rejects.toThrow('storage is unavailable');
  });
});
