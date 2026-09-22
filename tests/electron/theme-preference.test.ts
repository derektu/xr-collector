import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileThemePreference } from '../../src/electron/theme-preference.js';

describe('Electron device theme preference', () => {
  it('falls back to dark for a missing or invalid config and only stores the theme', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-theme-'));
    const file = path.join(root, 'appearance.json');
    const preference = new FileThemePreference(file);

    await expect(preference.read()).resolves.toBe('dark');
    await writeFile(file, '{"theme":"not-a-theme"}');
    await expect(preference.read()).resolves.toBe('dark');
    await preference.write('light');
    await expect(preference.read()).resolves.toBe('light');
    await expect(readFile(file, 'utf8')).resolves.toBe('{\n  "theme": "light"\n}\n');
  });
});
