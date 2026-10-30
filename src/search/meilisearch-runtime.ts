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
const SIGNING_MANIFEST = 'runtime-signing.json';

export const SEARCH_INDEX_PROFILE = {
  schemaVersion: 3,
  engine: { version: runtimePins.version },
  tokenizationFeatures: ['all-tokenizations'],
  indexSchema: 'documents_v3',
  normalization: { revision: SEARCH_NORMALIZATION_REVISION, openccDataVersion: OPENCC_DATA_VERSION },
  queryStrategy: { revision: SEARCH_QUERY_STRATEGY_REVISION, chineseFragments: 'contiguous-field-substring' },
} as const;

export type SearchIndexProfile = typeof SEARCH_INDEX_PROFILE & {
  lexicon?: SearchLexiconIdentity;
};

/** The manifest beside a prepared Meilisearch: the pinned release asset and its executable identity. */
export interface MeilisearchRuntimeManifest {
  schemaVersion: number;
  releaseRepository: string;
  releaseTag: string;
  releaseAsset: string;
  releaseUrl: string;
  target: 'darwin-arm64' | 'win32-x64';
  binary: { version: string; versionOutput: string; bytes: number; sha256: string; format: string; arch: string };
}

export type ValidatedMeilisearchRuntime = MeilisearchRuntimeManifest & { searchProfile: SearchIndexProfile };

export function meilisearchBuildManifestPath(binaryPath: string): string {
  return path.join(path.dirname(path.resolve(binaryPath)), 'meilisearch-build.json');
}

export async function validateMeilisearchRuntime(
  binaryPath: string,
  environment: { platform: NodeJS.Platform; arch: string } = { platform: process.platform, arch: process.arch },
  readVersion: (executable: string) => Promise<string> = executeVersion,
  readIdentity: (filePath: string) => Promise<{ bytes: number; sha256: string }> = runtimeBinaryIdentity,
  verifySignedIdentity: typeof verifySignedMeilisearchIdentity = verifySignedMeilisearchIdentity,
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
  const target = environment.platform === 'darwin' && environment.arch === 'arm64' ? 'darwin-arm64'
    : environment.platform === 'win32' && environment.arch === 'x64' ? 'win32-x64' : null;
  const pin = target ? runtimePins.assets[target] : undefined;
  const expected = target && pin ? {
    schemaVersion: runtimePins.schemaVersion,
    releaseRepository: runtimePins.releaseRepository,
    releaseTag: runtimePins.releaseTag,
    releaseAsset: pin.asset,
    releaseUrl: pin.url,
    target,
    binary: {
      version: runtimePins.version, versionOutput: `meilisearch ${runtimePins.version}`,
      bytes: pin.bytes, sha256: pin.sha256, format: pin.format, arch: pin.arch,
    },
  } : null;
  if (!expected || JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error(`Meilisearch runtime manifest does not match the pinned ${target ?? `${environment.platform}-${environment.arch}`} release asset.`);
  }
  await validateExecutable(binaryPath, manifest.binary, readVersion, readIdentity, verifySignedIdentity);
  return { ...manifest, searchProfile: SEARCH_INDEX_PROFILE };
}

async function validateExecutable(
  binaryPath: string,
  binary: { bytes: number; sha256: string; format: string; arch: string },
  readVersion: (executable: string) => Promise<string>,
  readIdentity: (filePath: string) => Promise<{ bytes: number; sha256: string }>,
  verifySignedIdentity: typeof verifySignedMeilisearchIdentity,
): Promise<void> {
  const identity = await readIdentity(binaryPath).catch((error) => {
    throw new Error('Meilisearch binary bytes do not match its runtime manifest.', { cause: error });
  });
  if (identity.bytes !== binary.bytes || identity.sha256 !== binary.sha256) {
    await verifySignedIdentity(binaryPath, binary, identity).catch((error) => {
      throw new Error('Meilisearch binary bytes do not match its raw manifest or a sealed Developer ID runtime identity.', { cause: error });
    });
  }
  const actual = await executableIdentity(binaryPath).catch((error) => {
    throw new Error('Meilisearch binary does not match its build manifest; the runtime pair may be incomplete or interrupted.', { cause: error });
  });
  if (actual.arch !== binary.arch || actual.format !== binary.format) {
    throw new Error('Meilisearch binary does not match its build manifest; the runtime pair may be incomplete or interrupted.');
  }
  const version = (await readVersion(binaryPath)).trim();
  if (version !== `meilisearch ${runtimePins.version}`) throw new Error(`Meilisearch runtime version is ${version || 'unknown'}, expected meilisearch ${runtimePins.version}.`);
}

export async function verifySignedMeilisearchIdentity(
  binaryPath: string,
  source: { bytes: number; sha256: string },
  finalIdentity: { bytes: number; sha256: string },
  execute: typeof run = run,
): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('A signed runtime identity is supported only inside a macOS App bundle.');
  const bin = path.dirname(path.resolve(binaryPath));
  const resources = path.dirname(bin);
  const appPath = path.resolve(resources, '../..');
  if (!appPath.endsWith('.app') || path.basename(resources) !== 'Resources' || path.basename(bin) !== 'bin') throw new Error('Signed Meilisearch is not inside a macOS App Resources/bin directory.');
  const document = JSON.parse(await readFile(path.join(bin, SIGNING_MANIFEST), 'utf8')) as {
    schemaVersion?: number;
    policy?: string;
    expectedAppTeamId?: string;
    meilisearch?: { source?: { bytes?: number; sha256?: string }; final?: { bytes?: number; sha256?: string } };
  };
  const team = document.expectedAppTeamId;
  if (document.schemaVersion !== 1 || document.policy !== 'developer-id-notarized' || !/^[A-Z0-9]{10}$/u.test(team ?? '')
    || document.meilisearch?.source?.bytes !== source.bytes || document.meilisearch.source.sha256 !== source.sha256
    || document.meilisearch?.final?.bytes !== finalIdentity.bytes || document.meilisearch.final.sha256 !== finalIdentity.sha256) {
    throw new Error('Signed Meilisearch identity manifest is invalid.');
  }
  await execute('/usr/bin/codesign', ['--verify', '--strict', appPath], { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  await execute('/usr/bin/codesign', ['--verify', '--strict', binaryPath], { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const [appSignature, binarySignature] = await Promise.all([
    execute('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }),
    execute('/usr/bin/codesign', ['-dv', '--verbose=4', binaryPath], { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }),
  ]);
  for (const [label, output] of [['App', appSignature.stderr], ['Meilisearch', binarySignature.stderr]] as const) {
    if (!output.includes(`TeamIdentifier=${team}`) || !output.includes('Authority=Developer ID Application:')
      || (!output.includes('(runtime)') && !output.includes('Runtime Version=')) || !output.includes('Timestamp=')) {
      throw new Error(`${label} does not match the sealed Developer ID publisher identity.`);
    }
  }
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
