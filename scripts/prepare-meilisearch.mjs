#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { arch as nodeArch, platform as nodePlatform } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { normalizeArch, probePhysicalHost } from './physical-host.mjs';
import { runtimeCacheMiss, runtimeCacheRoot } from './runtime-cache.mjs';

const exec = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinsPath = path.join(projectRoot, 'src', 'search', 'meilisearch-runtime-pins.json');

export const TARGETS = {
  'darwin-arm64': { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64', directory: 'mac', executable: 'meilisearch' },
  'win32-x64': { platform: 'win32', processArch: 'x64', hostArch: 'x64', directory: 'win', executable: 'meilisearch.exe' },
};

/**
 * Fills the per-user runtime cache with the pinned Meilisearch release asset and installs it into
 * the checkout's `resources/bin`. With `cacheOnly` it never downloads: a missing or mismatched
 * cache entry fails with the prepare command, and the cache is only read.
 */
export async function prepareMeilisearch(options = {}, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const hashFile = dependencies.fileSha256 ?? fileSha256;
  const pins = dependencies.pins ?? await readRuntimePins();
  const environmentOverride = options.environment ?? {};
  const physical = environmentOverride.hostArch
    ? { platform: nodePlatform(), processArch: nodeArch(), ...environmentOverride }
    : await probePhysicalHost(dependencies.run ? { run } : undefined);
  const environment = { ...physical, ...environmentOverride, requireNative: options.requireNative ?? false };
  const target = selectTarget(options.target, environment);
  const pin = pins.assets[target.id];

  const cacheRoot = options.cacheRoot ?? path.join(runtimeCacheRoot(), 'meilisearch');
  const entry = path.join(cacheRoot, `v${pins.version}`, target.id);
  if (!options.cacheOnly) await mkdir(entry, { recursive: true });
  // Readers validate the binary and manifest pair themselves, so cache-only packaging takes no
  // cache lock and never blocks a concurrent preparation in another checkout.
  const ownCacheEntry = options.cacheOnly ? (work) => work() : (work) => withExclusiveLock(path.join(entry, '.prepare.lock'),
    `Another Meilisearch preparation owns ${path.join(entry, '.prepare.lock')}. If no preparation is running, remove only that stale lock and retry.`, work);
  return ownCacheEntry(async () => {
    const artifactDirectory = path.join(entry, 'artifact');
    const cachedBinary = path.join(artifactDirectory, target.executable);
    const cachedManifestPath = path.join(artifactDirectory, 'meilisearch-build.json');
    const manifest = expectedManifest(pins, target.id);
    const cacheHit = await installedPairMatches(cachedBinary, cachedManifestPath, manifest, target, run, hashFile);
    if (!cacheHit && options.cacheOnly) {
      throw runtimeCacheMiss(`Meilisearch ${pins.version} for ${target.id}`, artifactDirectory, target.id);
    }
    if (!cacheHit) {
      const staging = await mkdtemp(path.join(entry, '.download-'));
      try {
        const downloaded = path.join(staging, target.executable);
        await download(pin.url, downloaded, dependencies.fetch ?? fetch);
        await chmod(downloaded, 0o755);
        await validateReleaseBinary(downloaded, target, manifest.binary, run, hashFile);
        await transactionalReplacePair({
          binarySource: downloaded,
          manifest,
          binaryDestination: cachedBinary,
          manifestDestination: cachedManifestPath,
          ...(dependencies.cacheFault ? { fault: dependencies.cacheFault } : {}),
        });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }

    const runtimeDirectory = options.runtimeRoot ?? path.join(projectRoot, 'resources', 'bin', target.directory);
    const binaryDestination = path.join(runtimeDirectory, target.executable);
    const manifestDestination = path.join(runtimeDirectory, 'meilisearch-build.json');
    await withRuntimeInstallLock(runtimeDirectory, async () => {
      if (!await installedPairMatches(binaryDestination, manifestDestination, manifest, target, run, hashFile)) {
        await transactionalReplacePair({
          binarySource: cachedBinary,
          manifest,
          binaryDestination,
          manifestDestination,
          ...(dependencies.installFault ? { fault: dependencies.installFault } : {}),
        });
      }
    });
    console.log(`${cacheHit ? 'Reused' : 'Downloaded'} pinned Meilisearch ${pins.version} for ${target.id}: ${binaryDestination}`);
    return { cacheHit, target, entry, binaryPath: binaryDestination, manifestPath: manifestDestination, manifest };
  });
}

/** The manifest written beside a prepared Meilisearch: the pinned release asset and its executable identity. */
export function expectedManifest(pins, target) {
  const pin = pins.assets[target];
  if (!pin) throw new Error(`No Meilisearch release asset pin exists for ${target}.`);
  return {
    schemaVersion: pins.schemaVersion,
    releaseRepository: pins.releaseRepository,
    releaseTag: pins.releaseTag,
    releaseAsset: pin.asset,
    releaseUrl: pin.url,
    target,
    binary: {
      version: pins.version,
      versionOutput: `meilisearch ${pins.version}`,
      bytes: pin.bytes,
      sha256: pin.sha256,
      format: pin.format,
      arch: pin.arch,
    },
  };
}

export async function readRuntimePins() {
  return JSON.parse(await readFile(pinsPath, 'utf8'));
}

export function selectTarget(requested, environment) {
  if (!environment) throw new Error('A probed physical host environment is required to select a Meilisearch target.');
  const inferred = Object.entries(TARGETS)
    .find(([, target]) => target.platform === environment.platform && target.processArch === environment.processArch)?.[0];
  const id = requested ?? inferred;
  const target = id ? TARGETS[id] : undefined;
  if (!target) throw new Error(`Unsupported Meilisearch target for ${environment.platform}/${environment.processArch}. Use darwin-arm64 or win32-x64 on a matching Node runtime.`);
  if (target.platform !== environment.platform || target.processArch !== environment.processArch) {
    throw new Error(`Target ${id} requires Node ${target.platform}/${target.processArch}, got ${environment.platform}/${environment.processArch}.`);
  }
  const emulated = normalizeArch(environment.hostArch) !== target.hostArch;
  if (environment.requireNative && emulated) throw new Error(`Target ${id} requires a native ${target.hostArch} runner, got host ${environment.hostArch}.`);
  return { id, ...target, emulated };
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
  throw new Error('Meilisearch has an unsupported or unrecognized executable format.');
}

export async function fileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/** Reads a Meilisearch executable's format, architecture and `--version` output. */
export async function validateExecutable(binaryPath, target, expectedVersion, run = runCommand) {
  const bytes = await readFile(binaryPath);
  const inspected = inspectExecutable(bytes);
  if (inspected.arch !== target.processArch) throw new Error(`Meilisearch architecture ${inspected.arch} does not match ${target.processArch}.`);
  let result;
  try {
    result = await run(binaryPath, ['--version']);
  } catch (error) {
    if (target.platform === 'win32') {
      throw new Error('Cannot execute the Windows Meilisearch runtime. It requires the Microsoft Visual C++ v14 x64 runtime (vcruntime140.dll) beside it or installed on this machine.', { cause: error });
    }
    throw error;
  }
  const versionOutput = result.stdout.trim();
  if (versionOutput !== `meilisearch ${expectedVersion}`) throw new Error(`Meilisearch version is ${versionOutput || 'unknown'}, expected meilisearch ${expectedVersion}.`);
  return { version: expectedVersion, versionOutput, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), format: inspected.format, arch: inspected.arch };
}

async function validateReleaseBinary(binaryPath, target, expected, run, hashFile) {
  const bytes = (await stat(binaryPath)).size;
  if (bytes !== expected.bytes) throw new Error(`Meilisearch release asset size is ${bytes}, expected ${expected.bytes}.`);
  const sha256 = await hashFile(binaryPath);
  if (sha256 !== expected.sha256) throw new Error(`Meilisearch release asset checksum is ${sha256}, expected ${expected.sha256}.`);
  const identity = await validateExecutable(binaryPath, target, expected.version, run);
  if (JSON.stringify(identity) !== JSON.stringify(expected)) throw new Error(`Meilisearch release asset executable identity does not match ${target.id}.`);
}

async function installedPairMatches(binaryPath, manifestPath, manifest, target, run, hashFile) {
  const installed = await readJson(manifestPath);
  if (!installed || JSON.stringify(installed) !== JSON.stringify(manifest) || !await exists(binaryPath)) return false;
  try {
    await validateReleaseBinary(binaryPath, target, manifest.binary, run, hashFile);
    return true;
  } catch { return false; }
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

export async function withRuntimeInstallLock(runtimeDirectory, work) {
  await mkdir(runtimeDirectory, { recursive: true });
  const lockPath = path.join(runtimeDirectory, '.meilisearch-install.lock');
  return withExclusiveLock(lockPath, `Another Meilisearch runtime installation owns ${lockPath}. Retry after that preparation finishes.`, work);
}

async function withExclusiveLock(lockPath, contentionMessage, work) {
  try {
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(contentionMessage);
    throw error;
  }
  try { return await work(); }
  finally { await rm(lockPath, { force: true }); }
}

async function download(url, destination, request) {
  const response = await request(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Meilisearch download failed: ${response.status} ${url}`);
  if (!response.body) throw new Error(`Meilisearch download returned no body: ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
}

export async function runCommand(command, args, options = {}) {
  const result = await exec(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function exists(target) {
  try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readJson(target) {
  try { return JSON.parse(await readFile(target, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

export function parsePrepareArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--target') options.target = argv[++index];
    else if (argv[index] === '--require-native') options.requireNative = true;
    else if (argv[index] === '--cache-only') options.cacheOnly = true;
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareMeilisearch(parsePrepareArguments(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
