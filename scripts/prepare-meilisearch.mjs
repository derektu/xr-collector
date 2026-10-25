#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { arch as nodeArch, platform as nodePlatform } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  buildMeilisearch, fileSha256, selectTarget, transactionalReplacePair, validateBuiltBinary, withRuntimeInstallLock,
} from './build-meilisearch.mjs';
import { probePhysicalHost } from './physical-host.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinsPath = path.join(projectRoot, 'src', 'search', 'meilisearch-runtime-pins.json');

export async function prepareMeilisearch(options = {}, dependencies = {}) {
  const variant = options.variant ?? 'chinese';
  if (variant !== 'chinese' && variant !== 'official') {
    throw new Error(`Unsupported Meilisearch variant ${variant}; use chinese or official.`);
  }
  if (variant === 'chinese') {
    const { variant: _variant, ...buildOptions } = options;
    return { variant, ...await (dependencies.build ?? buildMeilisearch)(buildOptions) };
  }

  const run = dependencies.run;
  const hashFile = dependencies.fileSha256 ?? fileSha256;
  const pins = dependencies.pins ?? await readRuntimePins();
  const environmentOverride = options.environment ?? {};
  const physical = environmentOverride.hostArch
    ? { platform: nodePlatform(), processArch: nodeArch(), ...environmentOverride }
    : await probePhysicalHost(run ? { run } : undefined);
  const environment = { ...physical, ...environmentOverride, requireNative: options.requireNative ?? false };
  const target = selectTarget(options.target, environment);
  const pin = pins.official?.[target.id];
  if (!pin) {
    throw new Error(`A supported official Meilisearch v${pins.version} asset is not published for ${target.id}; no download or runtime replacement was attempted.`);
  }

  const cacheRoot = options.cacheRoot ?? path.join(projectRoot, '.local', 'runtime-builds', 'meilisearch');
  const entry = path.join(cacheRoot, `official-v${pins.version}`, target.id);
  await mkdir(entry, { recursive: true });
  return withPrepareLock(path.join(entry, '.prepare.lock'), async () => {
    const artifactDirectory = path.join(entry, 'artifact');
    const cachedBinary = path.join(artifactDirectory, target.executable);
    const cachedManifestPath = path.join(artifactDirectory, 'meilisearch-build.json');
    const expectedManifest = expectedOfficialManifest(pins, target.id, pin);
    let manifest = await readJson(cachedManifestPath);
    let cacheHit = false;
    if (manifest && exactJson(manifest, expectedManifest) && await exists(cachedBinary)) {
      try {
        const binary = await validateOfficialBinary(cachedBinary, target, pin, pins.version, run, hashFile);
        cacheHit = exactJson(binary, expectedManifest.binary);
      } catch { cacheHit = false; }
    }
    if (!cacheHit) {
      const staging = await mkdtemp(path.join(entry, '.download-'));
      try {
        const downloaded = path.join(staging, target.executable);
        await download(pin.url, downloaded, dependencies.fetch ?? fetch);
        await chmod(downloaded, 0o755);
        const binary = await validateOfficialBinary(downloaded, target, pin, pins.version, run, hashFile);
        manifest = { ...expectedManifest, binary };
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
    } else {
      manifest = expectedManifest;
    }

    const runtimeDirectory = options.runtimeRoot ?? path.join(projectRoot, 'resources', 'bin', target.directory);
    const binaryDestination = path.join(runtimeDirectory, target.executable);
    const manifestDestination = path.join(runtimeDirectory, 'meilisearch-build.json');
    await withRuntimeInstallLock(runtimeDirectory, async () => {
      let installed = false;
      const installedManifest = await readJson(manifestDestination);
      if (installedManifest && exactJson(installedManifest, manifest) && await exists(binaryDestination)) {
        try {
          installed = exactJson(
            await validateOfficialBinary(binaryDestination, target, pin, pins.version, run, hashFile),
            manifest.binary,
          );
        } catch { installed = false; }
      }
      if (!installed) {
        await transactionalReplacePair({
          binarySource: cachedBinary,
          manifest,
          binaryDestination,
          manifestDestination,
          ...(dependencies.installFault ? { fault: dependencies.installFault } : {}),
        });
      }
    });
    console.log(`${cacheHit ? 'Reused' : 'Downloaded'} pinned official Meilisearch ${pins.version} for ${target.id}: ${binaryDestination}`);
    return { variant, cacheHit, target, entry, binaryPath: binaryDestination, manifestPath: manifestDestination, manifest };
  });
}

export function expectedOfficialManifest(pins, target, pin = pins.official?.[target]) {
  if (!pin) throw new Error(`No official Meilisearch asset pin exists for ${target}.`);
  return {
    schemaVersion: pins.schemaVersion,
    distribution: 'official',
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

async function validateOfficialBinary(binaryPath, target, pin, version, run, hashFile) {
  const bytes = (await stat(binaryPath)).size;
  if (bytes !== pin.bytes) throw new Error(`Official Meilisearch asset size is ${bytes}, expected ${pin.bytes}.`);
  const sha256 = await hashFile(binaryPath);
  if (sha256 !== pin.sha256) throw new Error(`Official Meilisearch asset checksum is ${sha256}, expected ${pin.sha256}.`);
  let identity;
  try {
    identity = await validateBuiltBinary(binaryPath, target, version, run);
  } catch (error) {
    if (target.id === 'win32-x64') {
      throw new Error('Cannot execute the official Windows Meilisearch runtime. It requires a supported Microsoft Visual C++ v14 x64 runtime; automatic redistributable installation is tracked by #34.', { cause: error });
    }
    throw error;
  }
  if (identity.format !== pin.format || identity.arch !== pin.arch) {
    throw new Error(`Official Meilisearch asset executable identity does not match ${target.id}.`);
  }
  return identity;
}

async function download(url, destination, request) {
  const response = await request(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Official Meilisearch download failed: ${response.status} ${url}`);
  if (!response.body) throw new Error(`Official Meilisearch download returned no body: ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
}

async function withPrepareLock(lockPath, work) {
  try {
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another Meilisearch preparation owns ${lockPath}. If no preparation is running, remove only that stale lock and retry.`);
    throw error;
  }
  try { return await work(); }
  finally { await rm(lockPath, { force: true }); }
}

async function exists(target) {
  try { await stat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readJson(target) {
  try { return JSON.parse(await readFile(target, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

function exactJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function parsePrepareArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--variant') {
      const variant = argv[++index];
      if (variant !== 'chinese' && variant !== 'official') throw new Error(`Unsupported Meilisearch variant ${variant ?? 'missing'}; use chinese or official.`);
      options.variant = variant;
    } else if (argv[index] === '--target') options.target = argv[++index];
    else if (argv[index] === '--require-native') options.requireNative = true;
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
