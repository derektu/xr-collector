import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateMeilisearchRuntime } from '../../src/search/meilisearch-runtime.js';
import { startSearchRuntime } from '../../src/search/runtime.js';

const roots: string[] = [];
const correctVersion = async () => 'meilisearch 1.53.2\n';
const officialIdentity = async () => ({ bytes: 341683536, sha256: '7fa492746343c1dd7217ead82fc6d42e74c1304593e4604f52ca71cf44d61b28' });
const charabiaOverride = {
  version: '0.10.0', archiveSha256: '27d98f4c66de52108210ee491c9c991513021dfd259bf65e4bbd889687b488d7',
  patch: 'scripts/meilisearch-patches/charabia-external-dictionary.patch', patchSha256: '0c0c20f5b5ddc869850be40228eb7db7baad872c3b3b4b94ca86eb4455503206',
  validator: 'scripts/meilisearch-patches/dictionary.rs', validatorSha256: '31fdcf813e8b9668bf3306c0bfe75b0f1925438a6bd2871652c125e926a8e767',
};
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(target: 'darwin-arm64' | 'win32-x64' = 'darwin-arm64'): Promise<{ root: string; binary: string; manifest: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-meili-runtime-'));
  roots.push(root);
  const windows = target === 'win32-x64';
  const rustTarget = windows ? 'x86_64-pc-windows-msvc' : 'aarch64-apple-darwin';
  const rustflags = windows ? '-C target-feature=+crt-static' : '';
  const binary = path.join(root, windows ? 'meilisearch.exe' : 'meilisearch');
  const bytes = Buffer.alloc(128);
  if (windows) {
    bytes.write('MZ', 0, 'ascii');
    bytes.writeUInt32LE(64, 0x3c);
    bytes.write('PE\0\0', 64, 'ascii');
    bytes.writeUInt16LE(0x8664, 68);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
  }
  await writeFile(binary, bytes);
  const manifest = path.join(root, 'meilisearch-build.json');
  const recipeFingerprint = createHash('sha256').update(JSON.stringify({
    schemaVersion: 1, recipeRevision: 2, sourceCommit: 'ec006cecec6f684b1dcaee093a45ab4c05707127',
    cargoLockSha256: 'f884034e00ae026ecc9a3c15999b11857dff4a99ba8d7c0528626571627cefbf',
    rustVersion: '1.91.1', package: 'meilisearch', profile: 'release', features: ['chinese'], defaultFeatures: false,
    charabiaOverride, target: rustTarget, rustcHost: rustTarget, rustcRelease: '1.91.1', rustflags, cargoProfileOverrides: {},
  })).digest('hex');
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1,
    recipeRevision: 2,
    recipeFingerprint,
    sourceRepository: 'https://github.com/meilisearch/meilisearch.git',
    sourceTag: 'v1.53.2',
    sourceCommit: 'ec006cecec6f684b1dcaee093a45ab4c05707127',
    cargoLockSha256: 'f884034e00ae026ecc9a3c15999b11857dff4a99ba8d7c0528626571627cefbf',
    rustVersion: '1.91.1',
    rustcHost: rustTarget,
    cargoVersion: 'cargo 1.91.1 (fixture)',
    target,
    rustTarget,
    features: ['chinese'],
    defaultFeatures: false,
    charabiaOverride,
    profile: 'release',
    buildCommand: `cargo +1.91.1 build --release --locked -p meilisearch --no-default-features --features chinese --target ${rustTarget} --config paths=["<isolated-charabia>"]`,
    buildEnvironment: { rustflags, cargoProfileOverrides: {} },
    runner: { platform: windows ? 'win32' : 'darwin', processArch: windows ? 'x64' : 'arm64', hostArch: windows ? 'x64' : 'arm64', emulated: false },
    completedAt: '2026-10-24T00:00:00.000Z',
    binary: { version: '1.53.2', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), format: windows ? 'PE32+' : 'Mach-O 64', arch: windows ? 'x64' : 'arm64' },
  }));
  return { root, binary, manifest };
}

async function officialFixture(target: 'darwin-arm64' | 'win32-x64' = 'darwin-arm64'): Promise<{ root: string; binary: string; manifest: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-meili-official-runtime-'));
  roots.push(root);
  const windows = target === 'win32-x64';
  const binary = path.join(root, windows ? 'meilisearch.exe' : 'meilisearch');
  const bytes = Buffer.alloc(128);
  if (windows) {
    bytes.write('MZ', 0, 'ascii');
    bytes.writeUInt32LE(64, 0x3c);
    bytes.write('PE\0\0', 64, 'ascii');
    bytes.writeUInt16LE(0x8664, 68);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
  }
  await writeFile(binary, bytes);
  const manifest = path.join(root, 'meilisearch-build.json');
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1,
    distribution: 'official',
    releaseRepository: 'https://github.com/meilisearch/meilisearch',
    releaseTag: 'v1.53.2',
    releaseAsset: windows ? 'meilisearch-windows-amd64.exe' : 'meilisearch-macos-apple-silicon',
    releaseUrl: windows
      ? 'https://github.com/meilisearch/meilisearch/releases/download/v1.53.2/meilisearch-windows-amd64.exe'
      : 'https://github.com/meilisearch/meilisearch/releases/download/v1.53.2/meilisearch-macos-apple-silicon',
    target,
    binary: windows
      ? { version: '1.53.2', versionOutput: 'meilisearch 1.53.2', bytes: 346635776, sha256: 'edb04f8288565e413a318069600954e38574714e5a2559777f8f4e8cc16d1bf3', format: 'PE32+', arch: 'x64' }
      : { version: '1.53.2', versionOutput: 'meilisearch 1.53.2', bytes: 341683536, sha256: '7fa492746343c1dd7217ead82fc6d42e74c1304593e4604f52ca71cf44d61b28', format: 'Mach-O 64', arch: 'arm64' },
  }));
  return { root, binary, manifest };
}

describe('Meilisearch runtime identity', () => {
  it('accepts the complete matching binary and build manifest pair', async () => {
    const built = await fixture();
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).resolves.toMatchObject({
      target: 'darwin-arm64', features: ['chinese'], variant: 'chinese',
      searchProfile: { tokenizationFeatures: ['chinese'] },
    });
  });

  it('accepts the pinned official distribution and returns its distinct search profile', async () => {
    const built = await officialFixture();
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion, officialIdentity)).resolves.toMatchObject({
      distribution: 'official', target: 'darwin-arm64', variant: 'official',
      searchProfile: { engine: { version: '1.53.2', distribution: 'official' }, tokenizationFeatures: ['all-tokenizations'] },
    });
  });

  it('rejects altered official metadata before the caller can prepare a projection', async () => {
    const built = await officialFixture();
    const manifest = JSON.parse(await readFile(built.manifest, 'utf8')) as { binary: { sha256: string } };
    manifest.binary.sha256 = '0'.repeat(64);
    await writeFile(built.manifest, JSON.stringify(manifest));
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/official runtime/u);
  });

  it('keeps invalid official metadata away from projection preparation', async () => {
    const built = await officialFixture();
    const manifest = JSON.parse(await readFile(built.manifest, 'utf8')) as { releaseAsset: string };
    manifest.releaseAsset = 'wrong';
    await writeFile(built.manifest, JSON.stringify(manifest));
    const prepareProjection = vi.fn();
    await startSearchRuntime({
      vault: { list: vi.fn(), read: vi.fn() } as never,
      binaryPath: built.binary,
      databasePath: path.join(built.root, 'search'),
      prepareProjection,
    });
    expect(prepareProjection).not.toHaveBeenCalled();
  });

  it('rejects a same-version executable paired with the other variant manifest before projection preparation', async () => {
    const built = await officialFixture();
    const prepareProjection = vi.fn();
    const runtime = await startSearchRuntime({
      vault: { list: vi.fn(), read: vi.fn() } as never,
      binaryPath: built.binary,
      databasePath: path.join(built.root, 'search'),
      prepareProjection,
    });
    expect(runtime.search.status()).toMatchObject({ state: 'error' });
    expect(prepareProjection).not.toHaveBeenCalled();
  });

  it('rejects an unknown distribution before projection preparation', async () => {
    const built = await fixture();
    const manifest = JSON.parse(await readFile(built.manifest, 'utf8')) as Record<string, unknown>;
    manifest.distribution = 'enterprise';
    await writeFile(built.manifest, JSON.stringify(manifest));
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/Unsupported.*enterprise/u);
    const prepareProjection = vi.fn();
    await startSearchRuntime({
      vault: { list: vi.fn(), read: vi.fn() } as never,
      binaryPath: built.binary,
      databasePath: path.join(built.root, 'search'),
      prepareProjection,
    });
    expect(prepareProjection).not.toHaveBeenCalled();
  });

  it('keeps artifact identity out of both semantic profiles', async () => {
    const chinese = await fixture();
    const official = await officialFixture();
    for (const runtime of [
      await validateMeilisearchRuntime(chinese.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion),
      await validateMeilisearchRuntime(official.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion, officialIdentity),
    ]) {
      expect(JSON.stringify(runtime.searchProfile)).not.toMatch(/sha256|completedAt|runner|sign/u);
    }
  });

  it('rejects a missing manifest or interrupted binary/manifest pair', async () => {
    const built = await fixture();
    await rm(built.manifest);
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/missing or invalid/u);
    const rebuilt = await fixture();
    await writeFile(rebuilt.binary, 'changed');
    await expect(validateMeilisearchRuntime(rebuilt.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/binary bytes/u);
  });

  it('rejects a byte transform until the signing identity contract is implemented', async () => {
    const built = await fixture();
    const transformed = Buffer.alloc(96);
    transformed.writeUInt32LE(0xfeedfacf, 0);
    transformed.writeUInt32LE(0x0100000c, 4);
    transformed.fill(7, 16);
    await writeFile(built.binary, transformed);
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/binary bytes/u);
  });

  it('rejects another engine version when the bytes still match', async () => {
    const built = await fixture();
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, async () => 'meilisearch 1.52.0\n')).rejects.toThrow(/expected meilisearch 1\.53\.2/u);
  });

  it('requires the pinned static CRT flags for the Windows runtime', async () => {
    const built = await fixture('win32-x64');
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'win32', arch: 'x64' }, correctVersion)).resolves.toMatchObject({ target: 'win32-x64' });
    const manifest = JSON.parse(await readFile(built.manifest, 'utf8')) as { buildEnvironment: { rustflags: string } };
    manifest.buildEnvironment.rustflags = '';
    await writeFile(built.manifest, JSON.stringify(manifest));
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'win32', arch: 'x64' }, correctVersion)).rejects.toThrow(/does not match/u);
  });

  it('does not prepare or clear a projection when the manifest is missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-meili-no-manifest-'));
    roots.push(root);
    const binary = path.join(root, 'meilisearch');
    const database = path.join(root, 'search');
    await writeFile(binary, 'runtime');
    await mkdir(database);
    await writeFile(path.join(database, 'sentinel'), 'keep');
    const prepareProjection = vi.fn();
    const runtime = await startSearchRuntime({
      vault: { list: vi.fn(), read: vi.fn() } as never,
      binaryPath: binary,
      databasePath: database,
      prepareProjection,
    });
    expect(runtime.search.status()).toMatchObject({ state: 'error' });
    expect(prepareProjection).not.toHaveBeenCalled();
    expect(await readFile(path.join(database, 'sentinel'), 'utf8')).toBe('keep');
  });
});
