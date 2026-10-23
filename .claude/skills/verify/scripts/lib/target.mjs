// The Desktop program a run starts, and the files it needs before it can start. Development runs the
// checkout's Electron on its build; packaged runs an app that electron-builder made. Both report the
// same fields, so results from either compare one to one. Only macOS is supported so far.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The folder name under resources/bin for this platform. */
export const BIN_PLATFORM = process.platform === 'win32' ? 'win' : 'mac';

/** The runtime programs of a checkout: resources/bin/<platform>, from npm run download:runtime. */
export const runtimeBin = (checkout) => path.join(checkout, 'resources', 'bin', BIN_PLATFORM);

/** The architecture names lipo reports for a Node process.arch. */
const LIPO_ARCH = { arm64: 'arm64', x64: 'x86_64' };

/** The architectures a macOS executable is built for; empty when it cannot be read. */
function executableArchs(executable) {
  try {
    return execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/u);
  } catch {
    return [];
  }
}

/** The executable of a macOS app bundle, from its Info.plist; null when the bundle has none. */
function bundleExecutable(app) {
  try {
    const name = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
    return path.join(app, 'Contents', 'MacOS', name);
  } catch {
    return null;
  }
}

// Electron fuses are a wire of bytes after this sentinel in the Electron Framework binary: a version
// byte, a length byte, then one byte per fuse ('1' enabled, '0' disabled, 'r' removed).
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
// Playwright's _electron.launch drives the app through --inspect, which this fuse allows.
const NODE_CLI_INSPECT_FUSE = 3;

/** The fuse wire of a macOS Electron app, such as '101100011'; null when it cannot be read. */
export function fuseWire(app) {
  try {
    const binary = readFileSync(path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'));
    const at = binary.indexOf(FUSE_SENTINEL);
    if (at < 0) return null;
    const start = at + FUSE_SENTINEL.length + 2;
    return binary.subarray(start, start + binary[start - 1]).toString('latin1');
  } catch {
    return null;
  }
}

/**
 * The Desktop target: { kind, app, executable, args, cwd, requires }. Without `app` it is the
 * checkout's development Electron loading the checkout's build; with `app` it is that packaged app
 * (a `.app` on macOS). `requires` lists each prerequisite as { check, ok, path, fix }, which doctor
 * reports and launchElectron enforces.
 */
export function desktopTarget({ checkout, app }) {
  if (process.platform !== 'darwin') throw new Error(`Desktop runs support macOS only; ${process.platform} is pending`);
  const bin = runtimeBin(checkout);
  const need = (check, file, fix) => ({ check, ok: Boolean(file) && existsSync(file), path: file, fix });
  if (!app) {
    const executable = path.join(checkout, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    return {
      kind: 'development', app: null, executable, args: ['.'], cwd: checkout,
      requires: [
        // npm may skip Electron's install script, which downloads the executable.
        need('electron', executable, 'node node_modules/electron/install.js'),
        need('electronBuild', path.join(checkout, 'dist', 'node', 'electron', 'main.js'), 'npm run build'),
        need('meilisearch', path.join(bin, 'meilisearch'), 'npm run download:runtime'),
        need('ytdlp', path.join(bin, 'yt-dlp', 'yt-dlp'), 'npm run download:runtime'),
        need('deno', path.join(bin, 'deno'), 'npm run download:runtime'),
      ],
    };
  }
  app = path.resolve(app);
  const fix = 'npm run package:mac, then pass the .app it made under release/';
  // Without the bundle every other check would fail too; one line says what is wrong.
  if (!existsSync(app)) {
    return { kind: 'packaged', app, executable: null, args: [], cwd: path.dirname(app), requires: [need('app', app, `${fix}; ${app} does not exist`)] };
  }
  const executable = bundleExecutable(app);
  const resources = path.join(app, 'Contents', 'Resources');
  const archs = executable && existsSync(executable) ? executableArchs(executable) : [];
  return {
    kind: 'packaged', app, executable, args: [], cwd: path.dirname(app),
    requires: [
      need('app', app, fix),
      need('appExecutable', executable, `${fix}; the bundle has no executable named in Contents/Info.plist`),
      need('appAsar', path.join(resources, 'app.asar'), fix),
      need('appMeilisearch', path.join(resources, 'bin', 'meilisearch'), `npm run download:runtime before ${fix}`),
      need('appYtdlp', path.join(resources, 'bin', 'yt-dlp', 'yt-dlp'), `npm run download:runtime before ${fix}`),
      need('appDeno', path.join(resources, 'bin', 'deno'), `npm run download:runtime before ${fix}`),
      fusesCheck(app),
      // An app of another architecture runs under translation, if at all; it is not the build under test.
      { check: 'appArch', ok: archs.includes(LIPO_ARCH[process.arch]), path: executable, value: archs.join(' ') || null,
        fix: `the app is built for ${archs.join(' ') || 'an unknown architecture'} and Node is ${process.arch}; package the app for ${process.arch}` },
    ],
  };
}

/** Whether the app's fuses still allow Playwright's connection. */
function fusesCheck(app) {
  const wire = fuseWire(app);
  return {
    check: 'appFuses', ok: wire?.[NODE_CLI_INSPECT_FUSE] === '1', path: app, value: wire,
    fix: wire === null ? 'the Electron fuse wire cannot be read from the app' : 'the app disables the EnableNodeCliInspectArguments fuse, which Playwright needs to drive it; verify cannot drive this build',
  };
}

/** Throws with every missing prerequisite of the target and its fix. */
export function requireTarget(target) {
  const missing = target.requires.filter((item) => !item.ok);
  if (missing.length) {
    throw new Error(`Desktop ${target.kind} target is not ready:\n${missing.map((item) => `  ${item.check}: ${item.path ?? ''} — ${item.fix}`).join('\n')}`);
  }
}
