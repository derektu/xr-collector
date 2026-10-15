import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileThemePreference, isStoredTheme } from '../../src/electron/theme-preference.js';

describe('Electron device theme preference', () => {
  it('follows the system for a missing or invalid config and only stores the theme', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-theme-'));
    const file = path.join(root, 'appearance.json');
    const preference = new FileThemePreference(file);

    await expect(preference.read()).resolves.toBe('system');
    await writeFile(file, '{"theme":"not-a-theme"}');
    await expect(preference.read()).resolves.toBe('system');
    await preference.write('light');
    await expect(preference.read()).resolves.toBe('light');
    await expect(readFile(file, 'utf8')).resolves.toBe('{\n  "theme": "light"\n}\n');
  });

  it('keeps an existing dark or light choice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-theme-'));
    const file = path.join(root, 'appearance.json');
    await writeFile(file, '{\n  "theme": "dark"\n}\n');

    await expect(new FileThemePreference(file).read()).resolves.toBe('dark');
    await expect(readFile(file, 'utf8')).resolves.toBe('{\n  "theme": "dark"\n}\n');
  });

  it('completes rapid writes in order and keeps the last choice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-theme-'));
    const file = path.join(root, 'appearance.json');
    const preference = new FileThemePreference(file);

    await Promise.all((['dark', 'light', 'system', 'dark', 'system'] as const).map((theme) => preference.write(theme)));
    await expect(preference.read()).resolves.toBe('system');
    await expect(readdir(root)).resolves.toEqual(['appearance.json']);
  });

  it('accepts only the three theme preferences', () => {
    for (const value of ['system', 'dark', 'light']) expect(isStoredTheme(value)).toBe(true);
    for (const value of ['auto', '', null, 1]) expect(isStoredTheme(value)).toBe(false);
  });
});
