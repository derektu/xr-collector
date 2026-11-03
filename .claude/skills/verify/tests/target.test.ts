// Guards the developer, not the user.
// A Desktop run starts only on the program under test: development Electron is refused while the
// checkout's build is older than its sources, and a packaged app built for another architecture than
// Node's is refused, so neither an old build nor an emulated one passes for the code under test.
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopTarget, requireTarget } from '../scripts/lib/target.mjs';
import { cleanUp, temp } from './support.js';

afterEach(cleanUp);

const write = (file: string, text = '') => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const at = (file: string, seconds: number) => utimesSync(file, seconds, seconds);
const check = (target: { requires: Array<{ check: string; ok: boolean }> }, name: string) => target.requires.find((item) => item.check === name)?.ok;

describe('development target', () => {
  it('is refused while dist/node or dist/web is older than the sources it was built from', () => {
    const checkout = temp('checkout');
    const sources = { web: path.join(checkout, 'src', 'web', 'App.tsx'), node: path.join(checkout, 'src', 'core', 'types.ts') };
    const built = { web: path.join(checkout, 'dist', 'web', 'index.html'), node: path.join(checkout, 'dist', 'node', 'electron', 'main.js') };
    for (const file of [...Object.values(sources), ...Object.values(built)]) write(file);
    for (const file of Object.values(sources)) at(file, 1_000);
    for (const file of Object.values(built)) at(file, 2_000);
    expect([check(desktopTarget({ checkout }), 'electronBuildCurrent'), check(desktopTarget({ checkout }), 'electronWebCurrent')]).toEqual([true, true]);

    at(sources.web, 3_000);
    expect([check(desktopTarget({ checkout }), 'electronBuildCurrent'), check(desktopTarget({ checkout }), 'electronWebCurrent')]).toEqual([true, false]);
    at(sources.node, 3_000);
    const target = desktopTarget({ checkout });
    expect(check(target, 'electronBuildCurrent')).toBe(false);
    expect(() => requireTarget(target)).toThrow(/electronWebCurrent: .*npm run build; the Web build is older than src\/web/u);
  });
});

describe.runIf(process.platform === 'darwin')('packaged target', () => {
  /** A macOS app bundle whose executable is `executable`, with app.asar and no Resources/bin. */
  function fakeApp(executable: (file: string) => void) {
    const app = path.join(temp('app'), 'Fake.app');
    write(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fake</string></dict></plist>`);
    write(path.join(app, 'Contents', 'Resources', 'app.asar'));
    mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    executable(path.join(app, 'Contents', 'MacOS', 'Fake'));
    return app;
  }

  it('is refused when the app is not built for Node\'s architecture', () => {
    const native = desktopTarget({ checkout: temp('checkout'), app: fakeApp((file) => symlinkSync(process.execPath, file)) });
    const unknown = desktopTarget({ checkout: temp('checkout'), app: fakeApp((file) => write(file, '#!/bin/sh\n')) });
    expect(check(native, 'appArch')).toBe(true);
    expect(check(unknown, 'appArch')).toBe(false);
    expect(() => requireTarget(unknown)).toThrow(/appArch: .*package the app for/u);
  });
});
