import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import runtimePins from './meilisearch-runtime-pins.json' with { type: 'json' };
import { SEARCH_QUERY_STRATEGY_REVISION } from './fragment-query.js';
import { OPENCC_DATA_VERSION, SEARCH_NORMALIZATION_REVISION } from './search-normalization.js';
import type { SearchLexiconIdentity } from './search-lexicon.js';

const run = promisify(execFile);

const SOURCE_COMMIT = 'ec006cecec6f684b1dcaee093a45ab4c05707127';
const CARGO_LOCK_SHA256 = 'f884034e00ae026ecc9a3c15999b11857dff4a99ba8d7c0528626571627cefbf';
const CHARABIA_OVERRIDE = {
  version: '0.10.0',
  archiveSha256: '27d98f4c66de52108210ee491c9c991513021dfd259bf65e4bbd889687b488d7',
  patch: 'scripts/meilisearch-patches/charabia-external-dictionary.patch',
  patchSha256: '0c0c20f5b5ddc869850be40228eb7db7baad872c3b3b4b94ca86eb4455503206',
  validator: 'scripts/meilisearch-patches/dictionary.rs',
  validatorSha256: '31fdcf813e8b9668bf3306c0bfe75b0f1925438a6bd2871652c125e926a8e767',
} as const;

export const SEARCH_INDEX_PROFILE = {
  schemaVersion: 3,
  engine: { version: '1.53.2', sourceCommit: SOURCE_COMMIT },
  tokenizationFeatures: ['chinese'],
  buildRecipeRevision: 2,
  indexSchema: 'documents_v3',
  normalization: { revision: SEARCH_NORMALIZATION_REVISION, openccDataVersion: OPENCC_DATA_VERSION },
  queryStrategy: { revision: SEARCH_QUERY_STRATEGY_REVISION, chineseFragments: 'contiguous-field-substring' },
} as const;

export const OFFICIAL_SEARCH_INDEX_PROFILE = {
  schemaVersion: 3,
  engine: { version: '1.53.2', distribution: 'official' },
  tokenizationFeatures: ['all-tokenizations'],
  indexSchema: 'documents_v3',
  normalization: { revision: SEARCH_NORMALIZATION_REVISION, openccDataVersion: OPENCC_DATA_VERSION },
  queryStrategy: { revision: SEARCH_QUERY_STRATEGY_REVISION, chineseFragments: 'contiguous-field-substring' },
} as const;

export type SearchIndexProfile = (typeof SEARCH_INDEX_PROFILE | typeof OFFICIAL_SEARCH_INDEX_PROFILE) & {
  lexicon?: SearchLexiconIdentity;
};
export type MeilisearchVariant = 'chinese' | 'official';

export interface MeilisearchBuildManifest {
  distribution?: never;
  schemaVersion: number;
  recipeRevision: number;
  recipeFingerprint: string;
  sourceRepository: string;
  sourceTag: string;
  sourceCommit: string;
  cargoLockSha256: string;
  rustVersion: string;
  rustcHost: string;
  cargoVersion: string;
  target: 'darwin-arm64' | 'darwin-x64' | 'win32-x64';
  rustTarget: string;
  features: string[];
  defaultFeatures: boolean;
  charabiaOverride?: unknown;
  profile: string;
  buildCommand: string;
  buildEnvironment?: { rustflags?: unknown; cargoProfileOverrides?: unknown };
  runner: { platform: string; processArch: string; hostArch: string; emulated: boolean };
  completedAt: string;
  binary: { version: string; versionOutput: string; bytes: number; sha256: string; format: string; arch: string };
  [key: string]: unknown;
}

export interface MeilisearchOfficialManifest {
  schemaVersion: number;
  distribution: 'official';
  releaseRepository: string;
  releaseTag: string;
  releaseAsset: string;
  releaseUrl: string;
  target: 'darwin-arm64' | 'win32-x64';
  binary: { version: string; versionOutput: string; bytes: number; sha256: string; format: string; arch: string };
  [key: string]: unknown;
}

export type MeilisearchRuntimeManifest = MeilisearchBuildManifest | MeilisearchOfficialManifest;
export type ValidatedMeilisearchRuntime = MeilisearchRuntimeManifest & {
  variant: MeilisearchVariant;
  searchProfile: SearchIndexProfile;
};

export function meilisearchBuildManifestPath(binaryPath: string): string {
  return path.join(path.dirname(path.resolve(binaryPath)), 'meilisearch-build.json');
}

export async function validateMeilisearchRuntime(
  binaryPath: string,
  environment: { platform: NodeJS.Platform; arch: string } = { platform: process.platform, arch: process.arch },
  readVersion: (executable: string) => Promise<string> = executeVersion,
  readIdentity: (filePath: string) => Promise<{ bytes: number; sha256: string }> = runtimeBinaryIdentity,
): Promise<ValidatedMeilisearchRuntime> {
  const manifestPath = meilisearchBuildManifestPath(binaryPath);
  let manifest: MeilisearchRuntimeManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as MeilisearchRuntimeManifest;
  } catch (error) {
    throw new Error(`Meilisearch build manifest is missing or invalid: ${manifestPath}.`, { cause: error });
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Meilisearch build manifest is missing or invalid: ${manifestPath}.`);
  }
  const distribution = (manifest as { distribution?: unknown }).distribution;
  if (distribution !== undefined && distribution !== 'official') {
    throw new Error(`Unsupported Meilisearch runtime distribution: ${String(distribution)}.`);
  }
  const expectedTarget = environment.platform === 'darwin' && environment.arch === 'arm64' ? 'darwin-arm64'
    : environment.platform === 'darwin' && environment.arch === 'x64' ? 'darwin-x64'
      : environment.platform === 'win32' && environment.arch === 'x64' ? 'win32-x64' : null;
  const expectedRustTarget = expectedTarget === 'darwin-arm64' ? 'aarch64-apple-darwin'
    : expectedTarget === 'darwin-x64' ? 'x86_64-apple-darwin'
      : expectedTarget === 'win32-x64' ? 'x86_64-pc-windows-msvc' : null;
  const expectedRustflags = expectedTarget === 'win32-x64' ? '-C target-feature=+crt-static' : '';
  const expectedArch = environment.arch;
  if (isOfficialManifest(manifest)) {
    const officialTarget = expectedTarget === 'darwin-arm64' || expectedTarget === 'win32-x64' ? expectedTarget : null;
    const pin = officialTarget ? runtimePins.official[officialTarget] : undefined;
    if (!officialTarget || !pin || manifest.schemaVersion !== runtimePins.schemaVersion
      || manifest.releaseRepository !== runtimePins.releaseRepository || manifest.releaseTag !== runtimePins.releaseTag
      || manifest.releaseAsset !== pin.asset || manifest.releaseUrl !== pin.url || manifest.target !== officialTarget
      || manifest.binary?.version !== runtimePins.version || manifest.binary.versionOutput !== `meilisearch ${runtimePins.version}` || manifest.binary.bytes !== pin.bytes
      || manifest.binary.sha256 !== pin.sha256 || manifest.binary.format !== pin.format || manifest.binary.arch !== pin.arch) {
      throw new Error(`Meilisearch official runtime manifest does not match the pinned ${expectedTarget ?? 'unsupported'} release asset.`);
    }
    await validateExecutable(binaryPath, manifest.binary, readVersion, readIdentity);
    return { ...manifest, variant: 'official', searchProfile: OFFICIAL_SEARCH_INDEX_PROFILE };
  }
  const expectedFingerprint = createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    recipeRevision: SEARCH_INDEX_PROFILE.buildRecipeRevision,
    sourceCommit: SOURCE_COMMIT,
    cargoLockSha256: CARGO_LOCK_SHA256,
    rustVersion: '1.91.1',
    package: 'meilisearch',
    profile: 'release',
    features: ['chinese'],
    defaultFeatures: false,
    charabiaOverride: CHARABIA_OVERRIDE,
    target: expectedRustTarget,
    rustcHost: expectedRustTarget,
    rustcRelease: '1.91.1',
    rustflags: expectedRustflags,
    cargoProfileOverrides: {},
  })).digest('hex');
  if (!expectedTarget || manifest.schemaVersion !== 1 || manifest.recipeRevision !== SEARCH_INDEX_PROFILE.buildRecipeRevision
    || manifest.sourceRepository !== 'https://github.com/meilisearch/meilisearch.git' || manifest.sourceTag !== 'v1.53.2'
    || manifest.sourceCommit !== SOURCE_COMMIT || manifest.cargoLockSha256 !== CARGO_LOCK_SHA256
    || manifest.rustVersion !== '1.91.1' || manifest.target !== expectedTarget || manifest.rustTarget !== expectedRustTarget
    || manifest.rustcHost !== expectedRustTarget || typeof manifest.cargoVersion !== 'string' || !manifest.cargoVersion.startsWith('cargo 1.91.1 ')
    || JSON.stringify(manifest.features) !== JSON.stringify(['chinese']) || manifest.defaultFeatures !== false
    || JSON.stringify(manifest.charabiaOverride) !== JSON.stringify(CHARABIA_OVERRIDE)
    || manifest.profile !== 'release' || manifest.buildEnvironment?.rustflags !== expectedRustflags
    || manifest.buildCommand !== `cargo +1.91.1 build --release --locked -p meilisearch --no-default-features --features chinese --target ${expectedRustTarget} --config paths=["<isolated-charabia>"]`
    || JSON.stringify(manifest.buildEnvironment?.cargoProfileOverrides) !== JSON.stringify({})
    || manifest.runner?.platform !== environment.platform || manifest.runner?.processArch !== expectedArch
    || !['arm64', 'x64'].includes(manifest.runner?.hostArch) || typeof manifest.runner?.emulated !== 'boolean'
    || manifest.runner.emulated !== (manifest.runner.hostArch !== expectedArch)
    || typeof manifest.completedAt !== 'string' || Number.isNaN(Date.parse(manifest.completedAt))
    || manifest.recipeFingerprint !== expectedFingerprint
    || manifest.binary?.version !== '1.53.2' || manifest.binary?.arch !== expectedArch
    || !Number.isInteger(manifest.binary?.bytes) || manifest.binary.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(manifest.binary?.sha256 ?? '')) {
    throw new Error(`Meilisearch build manifest does not match the required ${expectedTarget} Chinese runtime.`);
  }
  await validateExecutable(binaryPath, manifest.binary, readVersion, readIdentity);
  return { ...manifest, variant: 'chinese', searchProfile: SEARCH_INDEX_PROFILE };
}

function isOfficialManifest(manifest: MeilisearchRuntimeManifest): manifest is MeilisearchOfficialManifest {
  return manifest !== null && typeof manifest === 'object' && manifest.distribution === 'official';
}

async function validateExecutable(
  binaryPath: string,
  binary: { bytes: number; sha256: string; format: string; arch: string },
  readVersion: (executable: string) => Promise<string>,
  readIdentity: (filePath: string) => Promise<{ bytes: number; sha256: string }>,
): Promise<void> {
  const identity = await readIdentity(binaryPath).catch((error) => {
    throw new Error('Meilisearch binary bytes do not match its runtime manifest.', { cause: error });
  });
  if (identity.bytes !== binary.bytes || identity.sha256 !== binary.sha256) {
    throw new Error('Meilisearch binary bytes do not match its runtime manifest.');
  }
  const actual = await executableIdentity(binaryPath).catch((error) => {
    throw new Error('Meilisearch binary does not match its build manifest; the runtime pair may be incomplete or interrupted.', { cause: error });
  });
  if (actual.arch !== binary.arch || actual.format !== binary.format) {
    throw new Error('Meilisearch binary does not match its build manifest; the runtime pair may be incomplete or interrupted.');
  }
  const version = (await readVersion(binaryPath)).trim();
  if (version !== 'meilisearch 1.53.2') throw new Error(`Meilisearch runtime version is ${version || 'unknown'}, expected meilisearch 1.53.2.`);
}

async function runtimeBinaryIdentity(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const size = (await stat(filePath)).size;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { bytes: size, sha256: hash.digest('hex') };
}

async function executableIdentity(filePath: string): Promise<{ format: string; arch: string }> {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return inspectExecutableHeader(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function executeVersion(executable: string): Promise<string> {
  const result = await run(executable, ['--version'], { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return result.stdout;
}

function inspectExecutableHeader(buffer: Buffer): { format: string; arch: string } {
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = buffer.readUInt32LE(4);
    if (cpu === 0x0100000c) return { format: 'Mach-O 64', arch: 'arm64' };
    if (cpu === 0x01000007) return { format: 'Mach-O 64', arch: 'x64' };
  }
  if (buffer.length >= 64 && buffer.subarray(0, 2).toString('ascii') === 'MZ') {
    const offset = buffer.readUInt32LE(0x3c);
    if (buffer.length >= offset + 6 && buffer.subarray(offset, offset + 4).toString('ascii') === 'PE\0\0'
      && buffer.readUInt16LE(offset + 4) === 0x8664) return { format: 'PE32+', arch: 'x64' };
  }
  throw new Error('Meilisearch runtime has an unsupported executable format.');
}
