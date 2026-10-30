import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateMeilisearchRuntime, verifySignedMeilisearchIdentity } from '../../src/search/meilisearch-runtime.js';
import { startSearchRuntime } from '../../src/search/runtime.js';

const roots: string[] = [];
const correctVersion = async () => 'meilisearch 1.53.2\n';
const pinnedIdentity = async () => ({ bytes: 341683536, sha256: '7fa492746343c1dd7217ead82fc6d42e74c1304593e4604f52ca71cf44d61b28' });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(target: 'darwin-arm64' | 'win32-x64' = 'darwin-arm64'): Promise<{ root: string; binary: string; manifest: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-meili-runtime-'));
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
  it('accepts the pinned release asset and returns its search profile', async () => {
    const built = await fixture();
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion, pinnedIdentity)).resolves.toMatchObject({
      target: 'darwin-arm64', releaseTag: 'v1.53.2',
      searchProfile: { engine: { version: '1.53.2' }, tokenizationFeatures: ['all-tokenizations'] },
    });
  });

  it('rejects altered manifest metadata before the caller can prepare a projection', async () => {
    const built = await fixture();
    const manifest = JSON.parse(await readFile(built.manifest, 'utf8')) as { binary: { sha256: string } };
    manifest.binary.sha256 = '0'.repeat(64);
    await writeFile(built.manifest, JSON.stringify(manifest));
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/pinned darwin-arm64 release asset/u);
  });

  it('rejects a manifest with fields beyond the pinned identity', async () => {
    const built = await fixture();
    const manifest = JSON.parse(await readFile(built.manifest, 'utf8')) as Record<string, unknown>;
    manifest.features = ['extra'];
    await writeFile(built.manifest, JSON.stringify(manifest));
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion, pinnedIdentity)).rejects.toThrow(/does not match/u);
  });

  it('rejects the other platform\'s manifest and an unpinned platform', async () => {
    const windows = await fixture('win32-x64');
    await expect(validateMeilisearchRuntime(windows.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion, pinnedIdentity)).rejects.toThrow(/does not match/u);
    const mac = await fixture();
    await expect(validateMeilisearchRuntime(mac.binary, { platform: 'darwin', arch: 'x64' }, correctVersion, pinnedIdentity)).rejects.toThrow(/darwin-x64/u);
  });

  it('keeps invalid metadata away from projection preparation', async () => {
    const built = await fixture();
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

  it('rejects an executable whose bytes do not match the pinned asset before projection preparation', async () => {
    const built = await fixture();
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

  it('keeps artifact identity out of the semantic search profile', async () => {
    const built = await fixture();
    const runtime = await validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion, pinnedIdentity);
    expect(JSON.stringify(runtime.searchProfile)).not.toMatch(/sha256|release|sign/u);
  });

  it('rejects a missing manifest or interrupted binary/manifest pair', async () => {
    const built = await fixture();
    await rm(built.manifest);
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/missing or invalid/u);
    const rebuilt = await fixture();
    await writeFile(rebuilt.binary, 'changed');
    await expect(validateMeilisearchRuntime(rebuilt.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/binary bytes/u);
  });

  it.skipIf(process.platform !== 'darwin')('accepts a byte transform only when the final hash and sealed App publisher identity agree', async () => {
    const built = await fixture();
    const bin = path.join(built.root, 'XR Collector.app', 'Contents', 'Resources', 'bin');
    await mkdir(bin, { recursive: true });
    const binary = path.join(bin, 'meilisearch');
    const manifest = path.join(bin, 'meilisearch-build.json');
    await rename(built.binary, binary);
    await rename(built.manifest, manifest);
    const source = (JSON.parse(await readFile(manifest, 'utf8')) as { binary: { bytes: number; sha256: string } }).binary;
    const transformed = Buffer.alloc(96);
    transformed.writeUInt32LE(0xfeedfacf, 0);
    transformed.writeUInt32LE(0x0100000c, 4);
    transformed.fill(7, 16);
    await writeFile(binary, transformed);
    const finalIdentity = { bytes: transformed.length, sha256: createHash('sha256').update(transformed).digest('hex') };
    await writeFile(path.join(bin, 'runtime-signing.json'), JSON.stringify({
      schemaVersion: 1, policy: 'developer-id-notarized', expectedAppTeamId: 'ABCDE12345',
      meilisearch: { source, final: finalIdentity },
    }));
    const execute = vi.fn(async (_command: string, args: string[]) => ({
      stdout: '',
      stderr: args[0] === '-dv'
        ? 'Authority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\nflags=0x10000(runtime)\nTimestamp=Oct 28, 2026\n'
        : '',
    }));
    await expect(validateMeilisearchRuntime(
      binary, { platform: 'darwin', arch: 'arm64' }, correctVersion, async () => finalIdentity,
      (file, raw, final) => verifySignedMeilisearchIdentity(file, raw, final, execute as never),
    )).resolves.toMatchObject({ target: 'darwin-arm64' });
    expect(execute).toHaveBeenCalledWith('/usr/bin/codesign', ['--verify', '--strict', path.join(built.root, 'XR Collector.app')], expect.any(Object));
    expect(execute).toHaveBeenCalledWith('/usr/bin/codesign', ['--verify', '--strict', binary], expect.any(Object));

    const signing = JSON.parse(await readFile(path.join(bin, 'runtime-signing.json'), 'utf8')) as { meilisearch: { final: { sha256: string } } };
    signing.meilisearch.final.sha256 = '0'.repeat(64);
    await writeFile(path.join(bin, 'runtime-signing.json'), JSON.stringify(signing));
    execute.mockClear();
    await expect(validateMeilisearchRuntime(
      binary, { platform: 'darwin', arch: 'arm64' }, correctVersion, async () => finalIdentity,
      (file, raw, final) => verifySignedMeilisearchIdentity(file, raw, final, execute as never),
    )).rejects.toThrow(/sealed Developer ID runtime identity/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it('still rejects transformed bytes when no sealed signing contract exists', async () => {
    const built = await fixture();
    const transformed = Buffer.alloc(96);
    transformed.writeUInt32LE(0xfeedfacf, 0);
    transformed.writeUInt32LE(0x0100000c, 4);
    await writeFile(built.binary, transformed);
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, correctVersion)).rejects.toThrow(/sealed Developer ID runtime identity/u);
  });

  it('rejects another engine version when the bytes still match', async () => {
    const built = await fixture();
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'darwin', arch: 'arm64' }, async () => 'meilisearch 1.52.0\n', pinnedIdentity)).rejects.toThrow(/expected meilisearch 1\.53\.2/u);
  });

  it('accepts the pinned Windows release asset', async () => {
    const built = await fixture('win32-x64');
    const windowsIdentity = async () => ({ bytes: 346635776, sha256: 'edb04f8288565e413a318069600954e38574714e5a2559777f8f4e8cc16d1bf3' });
    await expect(validateMeilisearchRuntime(built.binary, { platform: 'win32', arch: 'x64' }, correctVersion, windowsIdentity)).resolves.toMatchObject({ target: 'win32-x64' });
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
