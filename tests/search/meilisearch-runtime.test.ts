import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateMeilisearchRuntime } from '../../src/search/meilisearch-runtime.js';
import { startSearchRuntime } from '../../src/search/runtime.js';

const roots: string[] = [];
const correctVersion = async () => 'meilisearch 1.53.2\n';
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
    schemaVersion: 1, recipeRevision: 1, sourceCommit: 'ec006cecec6f684b1dcaee093a45ab4c05707127',
    cargoLockSha256: 'f884034e00ae026ecc9a3c15999b11857dff4a99ba8d7c0528626571627cefbf',
    rustVersion: '1.91.1', package: 'meilisearch', profile: 'release', features: ['chinese'], defaultFeatures: false,
    target: rustTarget, rustcHost: rustTarget, rustcRelease: '1.91.1', rustflags, cargoProfileOverrides: {},
  })).digest('hex');
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1,
    recipeRevision: 1,
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
    profile: 'release',
    buildCommand: `cargo +1.91.1 build --release --locked -p meilisearch --no-default-features --features chinese --target ${rustTarget}`,
    buildEnvironment: { rustflags, cargoProfileOverrides: {} },
    runner: { platform: windows ? 'win32' : 'darwin', processArch: windows ? 'x64' : 'arm64', hostArch: windows ? 'x64' : 'arm64', emulated: false },
    completedAt: '2026-10-24T00:00:00.000Z',
    binary: { version: '1.53.2', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), format: windows ? 'PE32+' : 'Mach-O 64', arch: windows ? 'x64' : 'arm64' },
  }));
  return { root, binary, manifest };
}

describe('Meilisearch runtime identity', () => {
  it('accepts the complete matching binary and build manifest pair', async () => {
    const built = await fixture();
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).resolves.toMatchObject({ target: 'darwin-arm64', features: ['chinese'] });
  });

  it('rejects a missing manifest or interrupted binary/manifest pair', async () => {
    const built = await fixture();
    await rm(built.manifest);
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/missing or invalid/u);
    const rebuilt = await fixture();
    await writeFile(rebuilt.binary, 'changed');
    await expect(validateMeilisearchRuntime(rebuilt.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/incomplete or interrupted/u);
  });

  it('accepts a signed-byte transform with the same architecture and version, but rejects another engine version', async () => {
    const built = await fixture();
    const transformed = Buffer.alloc(96);
    transformed.writeUInt32LE(0xfeedfacf, 0);
    transformed.writeUInt32LE(0x0100000c, 4);
    transformed.fill(7, 16);
    await writeFile(built.binary, transformed);
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).resolves.toMatchObject({ target: 'darwin-arm64' });
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
