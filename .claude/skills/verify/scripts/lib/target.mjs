// The Desktop program a run starts, and the files it needs before it can start. Development runs the
// checkout's Electron on its build; packaged runs an app that electron-builder made: a `.app` bundle
// on macOS (npm run package:mac), the unpacked `XR Collector.exe` on Windows (npm run package:win
// writes it to release/win-unpacked/ before wrapping it in the installer). Both kinds report the
// same fields on both platforms, so results compare one to one.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { exe } from './platform.mjs';

/** The folder name under resources/bin for this platform. */
export const BIN_PLATFORM = process.platform === 'win32' ? 'win' : 'mac';

/** The runtime programs of a checkout: resources/bin/<platform>, from npm run download:runtime. */
export const runtimeBin = (checkout) => path.join(checkout, 'resources', 'bin', BIN_PLATFORM);

/** The runtime programs inside a runtime folder, as each platform names them. */
const runtimePrograms = (bin) => ({
  meilisearch: path.join(bin, exe('meilisearch')), ytdlp: path.join(bin, 'yt-dlp', exe('yt-dlp')), deno: path.join(bin, exe('deno')),
});

/** Node's process.arch for each architecture lipo reports. */
const LIPO_ARCH = { arm64: 'arm64', x86_64: 'x64' };
/** Node's process.arch for each machine type in a Windows PE header. */
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' };

/** Reads `length` bytes of a file at `position`. */
function readAt(file, position, length) {
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, position);
    return buffer;
  } finally {
    closeSync(handle);
  }
}

/**
 * The architectures an executable is built for, as Node names them: from lipo for a macOS binary,
 * from the PE header's machine type for a Windows `.exe`. Empty when it cannot be read.
 */
function executableArchs(executable) {
  try {
    if (process.platform === 'win32') {
      const header = readAt(executable, readAt(executable, 0x3c, 4).readUInt32LE(0), 6);
      if (header.toString('latin1', 0, 4) !== 'PE\0\0') return [];
      const arch = PE_MACHINE[header.readUInt16LE(4)];
      return arch ? [arch] : [];
    }
    return execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/u).map((arch) => LIPO_ARCH[arch] ?? arch);
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

// Electron fuses are a wire of bytes after this sentinel in the binary that holds Electron itself
// (the Electron Framework on macOS, the app's .exe on Windows): a version byte, a length byte, then
// one byte per fuse ('1' enabled, '0' disabled, 'r' removed).
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
// Playwright's _electron.launch drives the app through --inspect, which this fuse allows.
const NODE_CLI_INSPECT_FUSE = 3;

/** The binary that carries a packaged app's fuse wire. */
const fuseBinary = (app) => (process.platform === 'win32' ? app
  : path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'));

/** The fuse wire of a packaged Electron app, such as '101100011'; null when it cannot be read. */
export function fuseWire(app) {
  try {
    const binary = readFileSync(fuseBinary(app));
    const at = binary.indexOf(FUSE_SENTINEL);
    if (at < 0) return null;
    const start = at + FUSE_SENTINEL.length + 2;
    return binary.subarray(start, start + binary[start - 1]).toString('latin1');
  } catch {
    return null;
  }
}

/** What each platform calls its Desktop pieces: the runtime download, the package and its layout. */
const PLATFORM = {
  darwin: {
    download: 'npm run download:runtime',
    electron: ['Electron.app', 'Contents', 'MacOS', 'Electron'],
    packaged: 'npm run package:mac, then pass the .app it made under release/',
    // The executable named in the bundle's Info.plist, and the bundle's Resources folder.
    open: (app) => ({ executable: bundleExecutable(app), resources: path.join(app, 'Contents', 'Resources') }),
    noExecutable: 'the bundle has no executable named in Contents/Info.plist',
  },
  win32: {
    download: 'npm run download:runtime:win',
    electron: ['electron.exe'],
    packaged: 'npm run package:win, then pass release/win-unpacked/XR Collector.exe',
    // The app is its .exe; electron-builder puts the resources folder beside it.
    open: (app) => ({ executable: app, resources: path.join(path.dirname(app), 'resources') }),
    noExecutable: 'the app is not an .exe',
  },
};

/**
 * The Desktop target: { kind, app, executable, args, cwd, resources, requires }. Without `app` it is
 * the checkout's development Electron loading the checkout's build; with `app` it is that packaged
 * app: a `.app` bundle on macOS, the app's `.exe` on Windows. `resources` is the packaged app's
 * resources folder (null for development). `requires` lists each prerequisite as
 * { check, ok, path, fix }, which doctor reports and launchElectron enforces.
 */
export function desktopTarget({ checkout, app }) {
  const platform = PLATFORM[process.platform];
  if (!platform) throw new Error(`Desktop runs support macOS and Windows, not ${process.platform}`);
  const bin = runtimePrograms(runtimeBin(checkout));
  const need = (check, file, fix) => ({ check, ok: Boolean(file) && existsSync(file), path: file, fix });
  if (!app) {
    const executable = path.join(checkout, 'node_modules', 'electron', 'dist', ...platform.electron);
    return {
      kind: 'development', app: null, executable, args: ['.'], cwd: checkout, resources: null,
      requires: [
        // npm may skip Electron's install script, which downloads the executable.
        need('electron', executable, 'node node_modules/electron/install.js'),
        need('electronBuild', path.join(checkout, 'dist', 'node', 'electron', 'main.js'), 'npm run build'),
        need('meilisearch', bin.meilisearch, platform.download),
        need('ytdlp', bin.ytdlp, platform.download),
        need('deno', bin.deno, platform.download),
      ],
    };
  }
  app = path.resolve(app);
  const fix = platform.packaged;
  // Without the app every other check would fail too; one line says what is wrong.
  if (!existsSync(app)) {
    return { kind: 'packaged', app, executable: null, args: [], cwd: path.dirname(app), resources: null, requires: [need('app', app, `${fix}; ${app} does not exist`)] };
  }
  // The app reports its resources, and the process table its executable, by real path; a path
  // through a link (such as /tmp, which is /private/tmp) would never match them.
  app = realpathSync(app);
  const { executable, resources } = platform.open(app);
  const programs = runtimePrograms(path.join(resources, 'bin'));
  const isExecutable = Boolean(executable) && existsSync(executable) && (process.platform !== 'win32' || /\.exe$/iu.test(executable));
  const archs = isExecutable ? executableArchs(executable) : [];
  return {
    kind: 'packaged', app, executable, args: [], cwd: path.dirname(app), resources,
    requires: [
      need('app', app, fix),
      { ...need('appExecutable', executable, `${fix}; ${platform.noExecutable}`), ok: isExecutable },
      need('appAsar', path.join(resources, 'app.asar'), fix),
      need('appMeilisearch', programs.meilisearch, `${platform.download} before ${fix}`),
      need('appYtdlp', programs.ytdlp, `${platform.download} before ${fix}`),
      need('appDeno', programs.deno, `${platform.download} before ${fix}`),
      fusesCheck(app),
      // An app of another architecture runs under emulation, if at all; it is not the build under test.
      { check: 'appArch', ok: archs.includes(process.arch), path: executable, value: archs.join(' ') || null,
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
