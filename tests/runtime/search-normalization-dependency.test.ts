import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OpenCC packaged dependency', () => {
  it('pins the pure-JavaScript package and includes production node_modules in app.asar', async () => {
    const appPackage = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const openCcPackage = JSON.parse(await readFile(path.resolve('node_modules/opencc-js/package.json'), 'utf8')) as {
      version: string; type: string; dependencies?: unknown; optionalDependencies?: unknown;
    };
    const builder = await readFile(path.resolve('electron-builder.yml'), 'utf8');

    expect(appPackage.dependencies['opencc-js']).toBe('1.4.2');
    expect(openCcPackage).toMatchObject({ version: '1.4.2', type: 'module' });
    expect(openCcPackage.dependencies).toBeUndefined();
    expect(openCcPackage.optionalDependencies).toBeUndefined();
    expect(existsSync(path.resolve('node_modules/opencc-js/dist/esm/full.js'))).toBe(true);
    expect(builder).toContain('- node_modules/**');
  });
});
