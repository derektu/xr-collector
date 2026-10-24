import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SOURCE_COMMIT = 'ec006cecec6f684b1dcaee093a45ab4c05707127';
const CARGO_LOCK_SHA256 = 'f884034e00ae026ecc9a3c15999b11857dff4a99ba8d7c0528626571627cefbf';

export const SEARCH_INDEX_PROFILE = {
  schemaVersion: 1,
  engine: { version: '1.53.2', sourceCommit: SOURCE_COMMIT },
  tokenizationFeatures: ['chinese'],
  buildRecipeRevision: 1,
  indexSchema: 'documents_v2',
} as const;

export interface MeilisearchBuildManifest {
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
  profile: string;
  buildCommand: string;
  buildEnvironment?: { rustflags?: unknown; cargoProfileOverrides?: unknown };
  runner: { platform: string; processArch: string; hostArch: string; emulated: boolean };
  completedAt: string;
  binary: { version: string; bytes: number; sha256: string; format: string; arch: string };
  [key: string]: unknown;
}

export function meilisearchBuildManifestPath(binaryPath: string): string {
  return path.join(path.dirname(path.resolve(binaryPath)), 'meilisearch-build.json');
}

export async function validateMeilisearchRuntime(
  binaryPath: string,
  environment: { platform: NodeJS.Platform; arch: string } = { platform: process.platform, arch: process.arch },
  readVersion: (executable: string) => Promise<string> = executeVersion,
): Promise<MeilisearchBuildManifest> {
  const manifestPath = meilisearchBuildManifestPath(binaryPath);
  let manifest: MeilisearchBuildManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as MeilisearchBuildManifest;
  } catch (error) {
    throw new Error(`Meilisearch build manifest is missing or invalid: ${manifestPath}.`, { cause: error });
  }
  const expectedTarget = environment.platform === 'darwin' && environment.arch === 'arm64' ? 'darwin-arm64'
    : environment.platform === 'darwin' && environment.arch === 'x64' ? 'darwin-x64'
      : environment.platform === 'win32' && environment.arch === 'x64' ? 'win32-x64' : null;
  const expectedRustTarget = expectedTarget === 'darwin-arm64' ? 'aarch64-apple-darwin'
    : expectedTarget === 'darwin-x64' ? 'x86_64-apple-darwin'
      : expectedTarget === 'win32-x64' ? 'x86_64-pc-windows-msvc' : null;
  const expectedRustflags = expectedTarget === 'win32-x64' ? '-C target-feature=+crt-static' : '';
  const expectedArch = environment.arch;
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
    || manifest.profile !== 'release' || manifest.buildEnvironment?.rustflags !== expectedRustflags
    || manifest.buildCommand !== `cargo +1.91.1 build --release --locked -p meilisearch --no-default-features --features chinese --target ${expectedRustTarget}`
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
  const actual = await executableIdentity(binaryPath).catch((error) => {
    throw new Error('Meilisearch binary does not match its build manifest; the runtime pair may be incomplete or interrupted.', { cause: error });
  });
  if (actual.arch !== manifest.binary.arch || actual.format !== manifest.binary.format) {
    throw new Error('Meilisearch binary does not match its build manifest; the runtime pair may be incomplete or interrupted.');
  }
  const version = (await readVersion(binaryPath)).trim();
  if (version !== 'meilisearch 1.53.2') throw new Error(`Meilisearch runtime version is ${version || 'unknown'}, expected meilisearch 1.53.2.`);
  return manifest;
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
