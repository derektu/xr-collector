#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { arch as nodeArch, homedir, machine as hostMachine, platform as nodePlatform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipePath = path.join(projectRoot, 'scripts', 'meilisearch-build-recipe.json');

export const TARGETS = {
  'darwin-arm64': { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64', rustTarget: 'aarch64-apple-darwin', directory: 'mac', executable: 'meilisearch' },
  'darwin-x64': { platform: 'darwin', processArch: 'x64', hostArch: 'x64', rustTarget: 'x86_64-apple-darwin', directory: 'mac', executable: 'meilisearch' },
  'win32-x64': { platform: 'win32', processArch: 'x64', hostArch: 'x64', rustTarget: 'x86_64-pc-windows-msvc', directory: 'win', executable: 'meilisearch.exe' },
};

export async function readRecipe(filePath = recipePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export function recipeFingerprint(recipe, target, rustc) {
  return sha256(Buffer.from(JSON.stringify({
    schemaVersion: recipe.schemaVersion,
    recipeRevision: recipe.recipeRevision,
    sourceCommit: recipe.sourceCommit,
    cargoLockSha256: recipe.cargoLockSha256,
    rustVersion: recipe.rustVersion,
    package: recipe.package,
    profile: recipe.profile,
    features: recipe.features,
    defaultFeatures: recipe.defaultFeatures,
    target: target.rustTarget,
    rustcHost: rustc.host,
    rustcRelease: rustc.release,
    rustflags: '',
    cargoProfileOverrides: {},
  })));
}

export function selectTarget(requested, environment = currentEnvironment()) {
  const inferred = environment.platform === 'darwin' && environment.processArch === 'arm64' ? 'darwin-arm64'
    : environment.platform === 'darwin' && environment.processArch === 'x64' ? 'darwin-x64'
      : environment.platform === 'win32' && environment.processArch === 'x64' ? 'win32-x64' : null;
  const id = requested ?? inferred;
  const target = id ? TARGETS[id] : undefined;
  if (!target) throw new Error(`Unsupported Meilisearch target for ${environment.platform}/${environment.processArch}. Use darwin-arm64, darwin-x64, or win32-x64 on a matching Node runtime.`);
  if (target.platform !== environment.platform || target.processArch !== environment.processArch) {
    throw new Error(`Target ${id} requires Node ${target.platform}/${target.processArch}, got ${environment.platform}/${environment.processArch}; cross compilation is not supported.`);
  }
  const emulated = normalizeArch(environment.hostArch) !== target.hostArch;
  if (environment.requireNative && emulated) throw new Error(`Target ${id} requires a native ${target.hostArch} runner, got host ${environment.hostArch}.`);
  return { id, ...target, emulated };
}

export function parseRustcVersion(output, expectedVersion, expectedHost) {
  const release = /^release:\s*(.+)$/mu.exec(output)?.[1]?.trim();
  const host = /^host:\s*(.+)$/mu.exec(output)?.[1]?.trim();
  if (release !== expectedVersion || host !== expectedHost) {
    throw new Error(`Rust ${expectedVersion} for ${expectedHost} is required; got release ${release ?? 'unknown'}, host ${host ?? 'unknown'}. Install it with rustup toolchain install ${expectedVersion}.`);
  }
  return { release, host, verbose: output.trim() };
}

export function inspectExecutable(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = buffer.readUInt32LE(4);
    if (cpu === 0x0100000c) return { format: 'Mach-O 64', arch: 'arm64' };
    if (cpu === 0x01000007) return { format: 'Mach-O 64', arch: 'x64' };
  }
  if (buffer.length >= 64 && buffer.subarray(0, 2).toString('ascii') === 'MZ') {
    const offset = buffer.readUInt32LE(0x3c);
    if (buffer.length >= offset + 6 && buffer.subarray(offset, offset + 4).toString('ascii') === 'PE\0\0') {
      const machine = buffer.readUInt16LE(offset + 4);
      if (machine === 0x8664) return { format: 'PE32+', arch: 'x64' };
    }
  }
  throw new Error('Built Meilisearch has an unsupported or unrecognized executable format.');
}

export async function fileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function validateBuiltBinary(binaryPath, target, expectedVersion, run = runCommand) {
  const bytes = await readFile(binaryPath);
  const inspected = inspectExecutable(bytes);
  if (inspected.arch !== target.processArch) throw new Error(`Built Meilisearch architecture ${inspected.arch} does not match ${target.processArch}.`);
  const result = await run(binaryPath, ['--version']);
  const versionOutput = result.stdout.trim();
  if (versionOutput !== `meilisearch ${expectedVersion}`) throw new Error(`Built Meilisearch version is ${versionOutput || 'unknown'}, expected meilisearch ${expectedVersion}.`);
  return { version: expectedVersion, versionOutput, bytes: bytes.length, sha256: sha256(bytes), format: inspected.format, arch: inspected.arch };
}

export function expectedManifestFields({ recipe, target, fingerprint, rustc, cargoVersion, environment, binary }) {
  return {
    schemaVersion: 1,
    recipeRevision: recipe.recipeRevision,
    recipeFingerprint: fingerprint,
    sourceRepository: recipe.repository,
    sourceTag: recipe.tag,
    sourceCommit: recipe.sourceCommit,
    cargoLockSha256: recipe.cargoLockSha256,
    rustVersion: recipe.rustVersion,
    rustcHost: rustc.host,
    cargoVersion,
    target: target.id,
    rustTarget: target.rustTarget,
    features: recipe.features,
    defaultFeatures: recipe.defaultFeatures,
    profile: recipe.profile,
    buildCommand: `cargo +${recipe.rustVersion} ${cargoArguments(recipe, target).join(' ')}`,
    buildEnvironment: { rustflags: '', cargoProfileOverrides: {} },
    runner: {
      platform: environment.platform,
      processArch: environment.processArch,
      hostArch: environment.hostArch,
      emulated: target.emulated,
    },
    binary,
  };
}

export function manifestMatches(actual, expected) {
  if (!actual || typeof actual !== 'object') return false;
  if (typeof actual.completedAt !== 'string' || Number.isNaN(Date.parse(actual.completedAt))) return false;
  if (expected.completedAt !== undefined) return JSON.stringify(actual) === JSON.stringify(expected);
  const { completedAt: _actualTime, ...actualStable } = actual;
  const { completedAt: _expectedTime, ...expectedStable } = expected;
  return JSON.stringify(actualStable) === JSON.stringify(expectedStable);
}

export async function transactionalReplacePair({
  binarySource, manifest, binaryDestination, manifestDestination,
  fault = async () => undefined,
  remove = (target, options) => rm(target, options),
  move = (source, destination) => rename(source, destination),
}) {
  const directory = path.dirname(binaryDestination);
  if (path.dirname(manifestDestination) !== directory) throw new Error('Binary and manifest must share one runtime directory.');
  await mkdir(directory, { recursive: true });
  const token = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const stagedBinary = path.join(directory, `.${path.basename(binaryDestination)}.${token}.new`);
  const stagedManifest = path.join(directory, `.${path.basename(manifestDestination)}.${token}.new`);
  const backupBinary = `${binaryDestination}.${token}.bak`;
  const backupManifest = `${manifestDestination}.${token}.bak`;
  let binaryBackedUp = false;
  let manifestBackedUp = false;
  let binaryInstalled = false;
  let manifestInstalled = false;
  let committed = false;
  try {
    await copyFile(binarySource, stagedBinary);
    await chmod(stagedBinary, 0o755);
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fault('staged');
    if (await exists(binaryDestination)) { await move(binaryDestination, backupBinary); binaryBackedUp = true; }
    if (await exists(manifestDestination)) { await move(manifestDestination, backupManifest); manifestBackedUp = true; }
    await fault('backed-up');
    await move(stagedBinary, binaryDestination);
    binaryInstalled = true;
    await fault('binary-installed');
    await move(stagedManifest, manifestDestination);
    manifestInstalled = true;
    committed = true;
    await fault('manifest-installed');
  } catch (error) {
    if (committed) throw error;
    const rollbackErrors = [];
    if (binaryInstalled) await remove(binaryDestination, { force: true }).catch((failure) => rollbackErrors.push(failure));
    if (manifestInstalled) await remove(manifestDestination, { force: true }).catch((failure) => rollbackErrors.push(failure));
    if (binaryBackedUp) {
      try { await move(backupBinary, binaryDestination); binaryBackedUp = false; }
      catch (failure) { rollbackErrors.push(failure); }
    }
    if (manifestBackedUp) {
      try { await move(backupManifest, manifestDestination); manifestBackedUp = false; }
      catch (failure) { rollbackErrors.push(failure); }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Meilisearch runtime replacement failed and rollback was incomplete. Preserve recovery backups: ${[binaryBackedUp ? backupBinary : null, manifestBackedUp ? backupManifest : null].filter(Boolean).join(', ')}`,
      );
    }
    throw error;
  } finally {
    await remove(stagedBinary, { force: true }).catch(() => undefined);
    await remove(stagedManifest, { force: true }).catch(() => undefined);
  }
  // Once both new files are installed, cleanup can never roll the committed pair back. A failed
  // cleanup deliberately leaves a recoverable .bak beside the valid runtime.
  for (const backup of [binaryBackedUp ? backupBinary : null, manifestBackedUp ? backupManifest : null]) {
    if (backup) await remove(backup, { force: true }).catch((error) => console.warn(`Unable to remove committed Meilisearch backup ${backup}`, error));
  }
}

export async function buildMeilisearch(options = {}, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const hashFile = dependencies.fileSha256 ?? fileSha256;
  const inheritedEnvironment = dependencies.inheritedEnvironment ?? process.env;
  const environment = { ...currentEnvironment(), hostArch: await detectHostArch(run), ...(options.environment ?? {}), requireNative: options.requireNative ?? false };
  const recipe = await readRecipe(options.recipePath ?? recipePath);
  const target = selectTarget(options.target, environment);
  const rustcOutput = await run('rustc', [`+${recipe.rustVersion}`, '-Vv']).catch((error) => {
    throw new Error(`Rust ${recipe.rustVersion} is unavailable. Install it with rustup toolchain install ${recipe.rustVersion}.`, { cause: error });
  });
  const rustc = parseRustcVersion(rustcOutput.stdout, recipe.rustVersion, target.rustTarget);
  const cargo = await run('cargo', [`+${recipe.rustVersion}`, '-V']);
  if (!cargo.stdout.startsWith(`cargo 1.91.1 `)) throw new Error(`Cargo from Rust ${recipe.rustVersion} is required; got ${cargo.stdout.trim()}.`);
  const fingerprint = recipeFingerprint(recipe, target, rustc);
  const recipeDirectory = `recipe-${recipe.recipeRevision}-${fingerprint.slice(0, 12)}`;
  const cacheRoot = options.cacheRoot ?? path.join(projectRoot, '.local', 'runtime-builds', 'meilisearch');
  const entry = path.join(cacheRoot, recipeDirectory, target.id);
  const sourceDir = path.join(entry, 'source');
  // cc/MSVC still limits object paths even when Git can check out long snapshot filenames.
  // The fingerprint includes recipe and Rust target, so shortening the directory keeps isolation.
  const cargoTargetDir = path.join(cacheRoot, 't', fingerprint.slice(0, 16));
  const cachedBinary = path.join(entry, 'artifact', target.executable);
  const cachedManifestPath = path.join(entry, 'artifact', 'meilisearch-build.json');
  await mkdir(entry, { recursive: true });
  return withBuildLock(path.join(entry, '.build.lock'), async () => {
    await ensureSource({ sourceDir, recipe, run });
    await verifySource({ sourceDir, recipe, run, hashFile });
    await assertControlledCargoConfiguration(sourceDir, inheritedEnvironment, run);
    const base = { recipe, target, fingerprint, rustc, cargoVersion: cargo.stdout.trim(), environment };
    let binary;
    let manifest = await readJson(cachedManifestPath);
    let cacheHit = false;
    if (manifest && await exists(cachedBinary)) {
      try {
        binary = await validateBuiltBinary(cachedBinary, target, recipe.meilisearchVersion, run);
        const expected = expectedManifestFields({ ...base, binary });
        cacheHit = manifestMatches(manifest, expected) && await hashFile(cachedBinary) === manifest.binary.sha256;
      } catch { cacheHit = false; }
    }
    if (!cacheHit) {
      await mkdir(cargoTargetDir, { recursive: true });
      await run('cargo', [`+${recipe.rustVersion}`, ...cargoArguments(recipe, target)], {
        cwd: sourceDir,
        env: cleanBuildEnvironment(cargoTargetDir, inheritedEnvironment),
        stdio: 'inherit',
      });
      await verifySource({ sourceDir, recipe, run, hashFile });
      const cargoBinary = path.join(cargoTargetDir, target.rustTarget, 'release', target.executable);
      binary = await validateBuiltBinary(cargoBinary, target, recipe.meilisearchVersion, run);
      manifest = { ...expectedManifestFields({ ...base, binary }), completedAt: new Date().toISOString() };
      await transactionalReplacePair({
        binarySource: cargoBinary,
        manifest,
        binaryDestination: cachedBinary,
        manifestDestination: cachedManifestPath,
        ...(dependencies.cacheFault ? { fault: dependencies.cacheFault } : {}),
      });
    }
    const runtimeDirectory = options.runtimeRoot ?? path.join(projectRoot, 'resources', 'bin', target.directory);
    const binaryDestination = path.join(runtimeDirectory, target.executable);
    const manifestDestination = path.join(runtimeDirectory, 'meilisearch-build.json');
    const installedManifest = await readJson(manifestDestination);
    const installedValid = installedManifest && manifestMatches(installedManifest, manifest)
      && await exists(binaryDestination) && await hashFile(binaryDestination) === manifest.binary.sha256;
    if (!installedValid) {
      await transactionalReplacePair({
        binarySource: cachedBinary,
        manifest,
        binaryDestination,
        manifestDestination,
        ...(dependencies.installFault ? { fault: dependencies.installFault } : {}),
      });
    }
    console.log(`${cacheHit ? 'Reused' : 'Built'} pinned Meilisearch ${recipe.meilisearchVersion} for ${target.id}: ${binaryDestination}`);
    return { cacheHit, target, entry, binaryPath: binaryDestination, manifestPath: manifestDestination, manifest };
  });
}

async function ensureSource({ sourceDir, recipe, run }) {
  if (await exists(sourceDir)) {
    if (!await exists(path.join(sourceDir, '.git'))) throw new Error(`Incomplete source cache at ${sourceDir}; remove this target cache directory and retry.`);
    await run('git', ['config', '--local', 'core.autocrlf', 'false'], { cwd: sourceDir });
    await run('git', ['config', '--local', 'core.longpaths', 'true'], { cwd: sourceDir });
    return;
  }
  await mkdir(sourceDir, { recursive: true });
  await run('git', ['init'], { cwd: sourceDir });
  // Windows Git commonly defaults to CRLF checkout. This cache must preserve the pinned upstream
  // bytes so Cargo.lock has the same identity on every platform; never change the user's global config.
  await run('git', ['config', '--local', 'core.autocrlf', 'false'], { cwd: sourceDir });
  // Upstream snapshot filenames can exceed Windows MAX_PATH inside a nested project cache.
  await run('git', ['config', '--local', 'core.longpaths', 'true'], { cwd: sourceDir });
  await run('git', ['remote', 'add', 'origin', recipe.repository], { cwd: sourceDir });
  await run('git', ['fetch', '--depth', '1', '--filter=blob:none', 'origin', recipe.sourceCommit], { cwd: sourceDir });
  await run('git', ['checkout', '--detach', recipe.sourceCommit], { cwd: sourceDir });
}

async function verifySource({ sourceDir, recipe, run, hashFile }) {
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: sourceDir })).stdout.trim();
  if (head !== recipe.sourceCommit) throw new Error(`Meilisearch source cache HEAD is ${head}, expected ${recipe.sourceCommit}. Remove this target cache directory and retry.`);
  const status = (await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: sourceDir })).stdout.trim();
  if (status) throw new Error(`Meilisearch source cache is dirty at ${sourceDir}. Remove this target cache directory and retry.\n${status}`);
  const lock = await hashFile(path.join(sourceDir, 'Cargo.lock'));
  if (lock !== recipe.cargoLockSha256) throw new Error(`Meilisearch Cargo.lock checksum is ${lock}, expected ${recipe.cargoLockSha256}.`);
}

function cargoArguments(recipe, target) {
  return ['build', '--release', '--locked', '-p', recipe.package, '--no-default-features', '--features', recipe.features.join(','), '--target', target.rustTarget];
}

export async function runCommand(command, args, options = {}) {
  if (options.stdio === 'inherit') {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: 'inherit',
        windowsHide: true,
      });
      let settled = false;
      child.once('error', (error) => {
        if (!settled) { settled = true; reject(error); }
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve({ stdout: '', stderr: '' });
        else reject(new Error(`${command} exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}.`));
      });
    });
  }
  const result = await exec(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function currentEnvironment() {
  return { platform: nodePlatform(), processArch: nodeArch(), hostArch: normalizeArch(hostMachine()) };
}

async function detectHostArch(run) {
  if (nodePlatform() === 'darwin') {
    const translated = await run('sysctl', ['-in', 'sysctl.proc_translated']).then(({ stdout }) => stdout.trim() === '1').catch(() => false);
    if (translated) return 'arm64';
  }
  if (nodePlatform() === 'win32') {
    const host = process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE;
    if (host) return normalizeArch(host);
  }
  return normalizeArch(hostMachine());
}

export function cleanBuildEnvironment(cargoTargetDir, inherited = process.env) {
  const environment = { ...inherited };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (normalized === 'RUSTFLAGS' || normalized === 'CARGO_ENCODED_RUSTFLAGS' || normalized === 'CARGO_TARGET_DIR'
      || normalized === 'RUSTC' || normalized === 'RUSTC_WRAPPER' || normalized === 'RUSTC_WORKSPACE_WRAPPER'
      || normalized === 'CARGO_BUILD_RUSTC' || normalized === 'CARGO_BUILD_RUSTC_WRAPPER'
      || normalized === 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER'
      || normalized.startsWith('CARGO_PROFILE_') || normalized === 'CARGO_BUILD_RUSTFLAGS'
      || /^CARGO_TARGET_.+_RUSTFLAGS$/u.test(normalized)) delete environment[key];
  }
  environment.CARGO_TARGET_DIR = cargoTargetDir;
  environment.RUSTFLAGS = '';
  return environment;
}

export async function assertControlledCargoConfiguration(sourceDir, inherited = process.env, execute = runCommand) {
  const candidates = [path.join(sourceDir, '.cargo', 'config'), path.join(sourceDir, '.cargo', 'config.toml')];
  const cargoHomeEntry = Object.entries(inherited).find(([key]) => key.toUpperCase() === 'CARGO_HOME');
  const cargoHomeValue = cargoHomeEntry?.[1] || path.join(homedir(), '.cargo');
  const cargoHome = path.isAbsolute(cargoHomeValue) ? cargoHomeValue : path.resolve(sourceDir, cargoHomeValue);
  candidates.push(path.join(cargoHome, 'config'), path.join(cargoHome, 'config.toml'));
  let ancestor = path.dirname(path.resolve(sourceDir));
  while (true) {
    candidates.push(path.join(ancestor, '.cargo', 'config'), path.join(ancestor, '.cargo', 'config.toml'));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const candidate of new Set(candidates.map((value) => path.resolve(value)))) {
    if (!await exists(candidate)) continue;
    if (isInside(sourceDir, candidate)) {
      const relative = path.relative(sourceDir, candidate);
      await execute('git', ['ls-files', '--error-unmatch', '--', relative], { cwd: sourceDir }).catch((error) => {
        throw new Error(`Cargo configuration inside the Meilisearch checkout is not tracked by the pinned source: ${candidate}.`, { cause: error });
      });
      continue;
    }
    throw new Error(`External Cargo configuration is not supported by the pinned Meilisearch builder: ${candidate}. Move it aside or use a controlled build environment; the file was not modified.`);
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function withBuildLock(lockPath, work) {
  try {
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another Meilisearch build owns ${lockPath}. If no build is running, remove only that stale lock and retry.`);
    throw error;
  }
  try { return await work(); }
  finally { await rm(lockPath, { force: true }); }
}

function normalizeArch(value) {
  const normalized = value.toLowerCase();
  if (normalized === 'x86_64' || normalized === 'amd64') return 'x64';
  if (normalized === 'aarch64') return 'arm64';
  return normalized;
}

async function exists(target) {
  try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readJson(target) {
  try { return JSON.parse(await readFile(target, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--target') options.target = argv[++index];
    else if (argv[index] === '--require-native') options.requireNative = true;
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMeilisearch(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
