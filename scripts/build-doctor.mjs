#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRecipe, TARGETS as MEILISEARCH_TARGETS } from './build-meilisearch.mjs';
import { loadMacSigningConfiguration } from './mac-signing.mjs';
import { probePhysicalHost } from './physical-host.mjs';
import { prepareMeilisearch } from './prepare-meilisearch.mjs';
import { findTrustedWindowsCrt, readWindowsCrtPin } from './prepare-windows-crt.mjs';
import { prepareRuntimeCommand } from './runtime-cache.mjs';
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';

const exec = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VARIANTS = ['chinese', 'official'];
const HOST_TARGETS = { darwin: 'darwin-arm64', win32: 'win32-x64' };
const VISUAL_CPP_FIX = 'Install Visual Studio 2022 Build Tools with the "Desktop development with C++" workload (MSVC x64/x86 build tools and a Windows SDK).';
const RUSTUP_FIX = {
  'darwin-arm64': "Install rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh, then open a new terminal.",
  'win32-x64': 'Install rustup with rustup-init.exe from https://rustup.rs (default host x86_64-pc-windows-msvc), then open a new terminal.',
};

const ok = (label, detail) => ({ status: 'ok', label, detail });
const missing = (label, detail, fix) => ({ status: 'missing', label, detail, fix });
const note = (label, detail, fix) => ({ status: 'note', label, detail, fix });

/**
 * Every condition a build machine needs to prepare runtimes for and package one native target.
 * `missing` items stop preparation and packaging before any work starts; `note` items are
 * information. The runtime cache and Mac signing items describe state rather than tools, so only
 * the `doctor:build` report includes them.
 */
const CHECKS = [
  { applies: () => true, check: checkHost },
  { applies: () => true, check: checkNode },
  { applies: () => true, check: checkNpm },
  { applies: () => true, check: checkGit },
  { applies: () => true, check: checkInstalledDependencies },
  { applies: ({ variants }) => variants.includes('chinese'), check: checkRust },
  { applies: ({ target }) => target === 'darwin-arm64', check: checkXcodeTools },
  { applies: ({ target, variants }) => target === 'win32-x64' && variants.includes('chinese'), check: checkMsvc },
  { applies: ({ target, variants }) => target === 'win32-x64' && variants.includes('chinese'), check: checkWindowsSdk },
  { applies: ({ target, variants }) => target === 'win32-x64' && variants.includes('official'), check: checkWindowsCrt },
  { applies: ({ report }) => report, check: checkRuntimeCache },
  { applies: ({ report, target }) => report && target === 'darwin-arm64', check: checkMacSigning },
];

export function hostBuildTarget(platform = process.platform) {
  const target = HOST_TARGETS[platform];
  if (!target) throw new Error(`Installers build on macOS (Apple Silicon) or Windows x64; ${platform} is not a build machine.`);
  return target;
}

export async function checkBuildEnvironment({ target, variants = VARIANTS, report = false }, dependencies = {}) {
  const context = {
    target, variants, report,
    run: dependencies.run ?? runCommand,
    root: dependencies.projectRoot ?? projectRoot,
    environment: dependencies.environment ?? process.env,
    nodeVersion: dependencies.nodeVersion ?? process.versions.node,
    probePhysicalHost: dependencies.probePhysicalHost ?? (() => probePhysicalHost()),
    dependencies,
    results: [],
  };
  // Later checks read earlier results (the runtime cache skips Chinese Meilisearch without Rust), so they run in order.
  for (const { applies, check } of CHECKS) {
    if (applies(context)) context.results.push(await check(context));
  }
  return context.results;
}

/** Stops preparation or packaging before any work when a required tool is missing. */
export async function assertBuildEnvironment({ target, variant }, dependencies = {}) {
  const results = await checkBuildEnvironment({ target, variants: [variant] }, dependencies);
  const absent = results.filter((result) => result.status === 'missing');
  if (absent.length > 0) {
    throw new Error(`This machine cannot build ${target} ${variant} packages yet:\n${formatResults(absent)}\nRun npm run doctor:build for the full report.`);
  }
  return results;
}

export function formatResults(results) {
  return results.map(({ status, label, detail, fix }) => [
    `  ${status.padEnd(8)}${label}${detail ? `: ${detail}` : ''}`,
    ...(fix ? [`          ${status === 'note' ? 'next' : 'fix'}: ${fix}`] : []),
  ].join('\n')).join('\n');
}

async function checkHost({ target, probePhysicalHost: probe }) {
  const label = 'Host';
  let host;
  try { host = await probe(); } catch (error) { return missing(label, error.message); }
  const describe = `${host.platform} ${host.processArch} process on ${host.hostArch} hardware`;
  if (target === 'darwin-arm64') {
    if (host.platform === 'darwin' && host.hostArch === 'arm64' && host.processArch === 'arm64') return ok(label, 'macOS arm64');
    return missing(label, `${describe}; darwin-arm64 packages need a native arm64 Node on an Apple Silicon Mac`, 'Install the arm64 build of Node (not under Rosetta).');
  }
  if (host.platform !== 'win32' || host.processArch !== 'x64') {
    return missing(label, `${describe}; win32-x64 packages need an x64 Node on Windows`, 'Install the x64 build of Node for Windows.');
  }
  if (host.hostArch !== 'x64') {
    return note(label, `${describe}; the build runs under x64 emulation and the artifact manifest records it`, 'Release candidates build on a native x64 Windows machine.');
  }
  return ok(label, 'Windows x64');
}

async function checkNode({ root, nodeVersion }) {
  const pinned = (await readFile(path.join(root, '.nvmrc'), 'utf8')).trim();
  const label = 'Node';
  const fix = `nvm install ${pinned} && nvm use ${pinned}`;
  if (nodeVersion === pinned) return ok(label, nodeVersion);
  if (nodeVersion.split('.')[0] !== pinned.split('.')[0]) return missing(label, `${nodeVersion}; .nvmrc pins ${pinned}`, fix);
  return note(label, `${nodeVersion}; .nvmrc pins ${pinned}, and the artifact manifest records the version used`, fix);
}

async function checkNpm({ environment }) {
  const execPath = environment.npm_execpath;
  if (!execPath || !path.isAbsolute(execPath)) return missing('npm', 'not run through an npm script', 'Run npm run doctor:build.');
  return ok('npm', /npm\/(\S+)/u.exec(environment.npm_config_user_agent ?? '')?.[1] ?? execPath);
}

async function checkGit({ run, target }) {
  try {
    return ok('Git', (await run('git', ['--version'])).stdout.trim().replace(/^git version /u, ''));
  } catch {
    return missing('Git', 'git is not on PATH', target === 'darwin-arm64' ? 'xcode-select --install' : 'Install Git for Windows from https://git-scm.com.');
  }
}

async function checkInstalledDependencies({ root }) {
  const required = ['node_modules/electron/package.json', 'node_modules/electron-builder/cli.js'];
  for (const file of required) {
    try { await access(path.join(root, file)); } catch { return missing('npm dependencies', `${file} is absent`, 'npm ci'); }
  }
  return ok('npm dependencies', 'installed');
}

async function checkRust({ target, run, environment, dependencies }) {
  const { rustVersion } = await (dependencies.readRecipe ?? readRecipe)();
  const triple = MEILISEARCH_TARGETS[target].rustTarget;
  const label = `Rust ${rustVersion} (${triple})`;
  try { await run('rustup', ['--version']); } catch { return missing(label, 'rustup is not on PATH', RUSTUP_FIX[target]); }
  // rustup on ARM64 Windows defaults to the aarch64 host, so the fix names the host before installing.
  const install = `rustup set default-host ${triple} && rustup toolchain install ${rustVersion}`;
  // `rustc +<version>` would otherwise download a missing toolchain, and the check stays read-only.
  const readOnly = { env: { ...environment, RUSTUP_AUTO_INSTALL: '0' } };
  let verbose;
  try { verbose = (await run('rustc', [`+${rustVersion}`, '-Vv'], readOnly)).stdout; } catch {
    return missing(label, `toolchain ${rustVersion} is not installed`, install);
  }
  const host = /^host:\s*(.+)$/mu.exec(verbose)?.[1]?.trim();
  if (host !== triple) return missing(label, `toolchain ${rustVersion} targets ${host ?? 'an unknown host'}`, install);
  try {
    const cargo = (await run('cargo', [`+${rustVersion}`, '-V'], readOnly)).stdout.trim();
    if (!cargo.startsWith(`cargo ${rustVersion} `)) return missing(label, `cargo reports ${cargo}`, install);
  } catch { return missing(label, 'cargo is unavailable', install); }
  return ok(label, 'installed');
}

async function checkXcodeTools({ run }) {
  const label = 'Xcode Command Line Tools';
  try {
    for (const tool of ['clang', 'swiftc']) await run('xcrun', ['--find', tool]);
  } catch { return missing(label, 'clang or swiftc is unavailable', 'xcode-select --install'); }
  return ok(label, 'clang and swiftc available');
}

async function checkMsvc({ run, environment }) {
  const label = 'MSVC x64 build tools';
  const vswhere = path.win32.join(environment['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  let installation = '';
  try {
    installation = (await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'])).stdout.trim();
  } catch { /* no Visual Studio installer on this machine */ }
  return installation ? ok(label, installation) : missing(label, 'no Visual Studio installation with the C++ x64 tools', VISUAL_CPP_FIX);
}

async function checkWindowsSdk({ environment, dependencies }) {
  const label = 'Windows SDK';
  const libraries = path.win32.join(environment['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'Lib');
  const listVersions = dependencies.readdir ?? readdir;
  const exists = dependencies.access ?? access;
  let versions = [];
  try { versions = (await listVersions(libraries)).sort().reverse(); } catch { /* no Windows 10/11 SDK */ }
  for (const version of versions) {
    try {
      await exists(path.win32.join(libraries, version, 'um', 'x64', 'kernel32.lib'));
      return ok(label, version);
    } catch { /* this SDK version lacks the x64 import libraries */ }
  }
  return missing(label, 'no Windows SDK with x64 libraries', VISUAL_CPP_FIX);
}

async function checkWindowsCrt({ dependencies }) {
  const pin = await (dependencies.readWindowsCrtPin ?? readWindowsCrtPin)();
  const label = `Visual C++ runtime ${pin.fileVersion}`;
  const source = await (dependencies.findTrustedWindowsCrt ?? findTrustedWindowsCrt)(pin).catch(() => null);
  if (source) return ok(label, source);
  return missing(label, `official packages ship the pinned ${pin.fileName} ${pin.fileVersion} from Visual Studio's VC\\Redist\\MSVC, and no installed copy matches it`,
    'Install a Visual Studio 2022 whose Redist ships that version, or move officialWindowsCrt in scripts/runtime-dependency-pins.json to the installed copy in its own change.');
}

async function checkRuntimeCache({ target, variants, results, dependencies }) {
  const pieces = [
    { name: 'yt-dlp and Deno', prepare: (outputDir) => (dependencies.prepareRuntimeDependencies ?? prepareRuntimeDependencies)({ target, cacheOnly: true, outputDir }) },
    ...variants.map((variant) => ({
      name: `${variant === 'chinese' ? 'Chinese' : 'official'} Meilisearch`,
      variant,
      prepare: (runtimeRoot) => (dependencies.prepareMeilisearch ?? prepareMeilisearch)({ variant, target, cacheOnly: true, runtimeRoot }),
    })),
  ];
  const rustReady = results.some((result) => result.label.startsWith('Rust ') && result.status === 'ok');
  const ready = [];
  const absent = [];
  for (const piece of pieces) {
    if (piece.variant === 'chinese' && !rustReady) { absent.push(`${piece.name} (checked once Rust is ready)`); continue; }
    // The cache-only install validates the cached entry exactly as packaging does, into a scratch directory.
    const scratch = await mkdtemp(path.join(tmpdir(), 'xr-build-doctor-'));
    try {
      await quietly(() => piece.prepare(scratch));
      ready.push(piece.name);
    } catch {
      absent.push(piece.name);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  const label = 'Runtime cache';
  if (absent.length === 0) return ok(label, `${ready.join(', ')} prepared`);
  // Every prepare command also fills yt-dlp and Deno, so they alone need only the default one.
  const absentVariants = pieces.filter((piece) => piece.variant && absent.some((name) => name.startsWith(piece.name))).map((piece) => piece.variant);
  const commands = (absentVariants.length > 0 ? absentVariants : ['chinese']).map((variant) => prepareRuntimeCommand(target, variant)).join(' && ');
  return note(label, `not prepared: ${absent.join(', ')}`, commands);
}

async function checkMacSigning({ root, dependencies }) {
  const label = 'Mac Developer ID signing';
  const signingRoot = path.join(root, 'keys', 'mac');
  const environmentFile = path.join(signingRoot, '.env');
  try { await (dependencies.access ?? access)(environmentFile); } catch {
    return note(label, 'keys/mac/.env is absent; package:mac builds ad-hoc signed packages');
  }
  try {
    const configuration = await (dependencies.loadMacSigningConfiguration ?? loadMacSigningConfiguration)({ environmentFile, pathRoot: signingRoot });
    return ok(label, `configured for team ${configuration.teamId}`);
  } catch (error) {
    return missing(label, error.message, 'Fix keys/mac/.env and its files (owner-only permissions), or remove keys/mac/.env to build ad-hoc packages only.');
  }
}

async function quietly(work) {
  const { log } = console;
  console.log = () => undefined;
  try { return await work(); } finally { console.log = log; }
}

async function runCommand(command, args, options = {}) {
  const result = await exec(command, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...options });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = hostBuildTarget();
    const results = await checkBuildEnvironment({ target, report: true });
    const absent = results.filter((result) => result.status === 'missing').length;
    console.log(`Build environment for ${target} (${VARIANTS.join(', ')} packages)\n${formatResults(results)}`);
    console.log(absent === 0 ? 'Ready to build.' : `${absent} required item${absent === 1 ? '' : 's'} missing.`);
    if (absent > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
