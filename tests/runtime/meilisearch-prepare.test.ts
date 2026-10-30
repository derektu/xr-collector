import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The production preparation entry point is intentionally executable JavaScript.
import { inspectExecutable, parsePrepareArguments, prepareMeilisearch, selectTarget, transactionalReplacePair, withRuntimeInstallLock } from '../../scripts/prepare-meilisearch.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'xr-meili-prepare-'));
  roots.push(value);
  return value;
}

function machoArm64(): Buffer {
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x0100000c, 4);
  return binary;
}

function peX64(): Buffer {
  const binary = Buffer.alloc(128);
  binary.write('MZ', 0, 'ascii');
  binary.writeUInt32LE(64, 0x3c);
  binary.write('PE\0\0', 64, 'ascii');
  binary.writeUInt16LE(0x8664, 68);
  return binary;
}

function fixturePins(binary: Buffer) {
  return {
    schemaVersion: 1,
    version: '1.53.2',
    releaseRepository: 'https://github.com/meilisearch/meilisearch',
    releaseTag: 'v1.53.2',
    assets: {
      'darwin-arm64': {
        asset: 'meilisearch-macos-apple-silicon',
        url: 'https://example.test/v1.53.2/meilisearch-macos-apple-silicon',
        bytes: binary.length,
        sha256: createHash('sha256').update(binary).digest('hex'),
        format: 'Mach-O 64',
        arch: 'arm64',
      },
    },
  };
}

const environment = { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' };
const versionRun = vi.fn(async () => ({ stdout: 'meilisearch 1.53.2\n', stderr: '' }));

describe('Meilisearch runtime preparation', () => {
  it('selects only a pinned target on a matching Node runtime', () => {
    expect(() => selectTarget()).toThrow(/probed physical host/u);
    expect(() => selectTarget('win32-x64', { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' })).toThrow(/requires Node win32\/x64/u);
    expect(() => selectTarget(undefined, { platform: 'darwin', processArch: 'x64', hostArch: 'x64' })).toThrow(/Unsupported Meilisearch target/u);
    expect(() => selectTarget('win32-x64', { platform: 'win32', processArch: 'x64', hostArch: 'arm64', requireNative: true })).toThrow(/native x64 runner/u);
    expect(selectTarget('win32-x64', { platform: 'win32', processArch: 'x64', hostArch: 'arm64' }).emulated).toBe(true);
  });

  it('recognizes only the expected native executable architecture', () => {
    expect(inspectExecutable(machoArm64())).toEqual({ format: 'Mach-O 64', arch: 'arm64' });
    expect(inspectExecutable(peX64())).toEqual({ format: 'PE32+', arch: 'x64' });
    expect(() => inspectExecutable(Buffer.from('not executable'))).toThrow(/unrecognized/u);
  });

  it('downloads, verifies and atomically installs the pinned asset, then reuses its cache', async () => {
    const at = await root();
    const binary = machoArm64();
    const pins = fixturePins(binary);
    const fetch = vi.fn(async () => new Response(binary));
    const options = {
      target: 'darwin-arm64', environment,
      cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'),
    };
    const dependencies = { fetch, pins, run: versionRun };
    const first = await prepareMeilisearch(options, dependencies);
    const second = await prepareMeilisearch(options, dependencies);
    expect(first).toMatchObject({ cacheHit: false });
    expect(second).toMatchObject({ cacheHit: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(first.binaryPath)).toEqual(binary);
    expect(JSON.parse(await readFile(first.manifestPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      releaseRepository: pins.releaseRepository,
      releaseTag: pins.releaseTag,
      releaseAsset: pins.assets['darwin-arm64'].asset,
      releaseUrl: pins.assets['darwin-arm64'].url,
      target: 'darwin-arm64',
      binary: {
        version: '1.53.2', versionOutput: 'meilisearch 1.53.2', bytes: binary.length,
        sha256: pins.assets['darwin-arm64'].sha256, format: 'Mach-O 64', arch: 'arm64',
      },
    });
  });

  it('installs the asset from the cache in cache-only mode and never downloads', async () => {
    const at = await root();
    const binary = machoArm64();
    const pins = fixturePins(binary);
    const cacheRoot = path.join(at, 'cache');
    const noDownload = vi.fn(async () => { throw new Error('cache-only mode must not download'); });
    const cacheOnly = (runtimeRoot: string) => prepareMeilisearch({ target: 'darwin-arm64', environment, cacheRoot, runtimeRoot, cacheOnly: true },
      { fetch: noDownload, pins, run: versionRun });
    await expect(cacheOnly(path.join(at, 'checkout-a'))).rejects.toThrow(/Meilisearch 1\.53\.2 for darwin-arm64 is missing from the runtime cache.*npm run prepare:runtime -- mac first/u);
    await prepareMeilisearch({ target: 'darwin-arm64', environment, cacheRoot, runtimeRoot: path.join(at, 'checkout-a') },
      { fetch: vi.fn(async () => new Response(binary)), pins, run: versionRun });
    const installed = await cacheOnly(path.join(at, 'checkout-b'));
    expect(installed).toMatchObject({ cacheHit: true });
    expect(await readFile(installed.binaryPath)).toEqual(binary);
    expect(noDownload).not.toHaveBeenCalled();
    expect(parsePrepareArguments(['--target', 'darwin-arm64', '--cache-only'])).toEqual({ target: 'darwin-arm64', cacheOnly: true });
  });

  it('preserves the installed pair when the downloaded checksum is wrong', async () => {
    const at = await root();
    const runtimeRoot = path.join(at, 'runtime');
    await mkdir(runtimeRoot);
    await writeFile(path.join(runtimeRoot, 'meilisearch'), 'old-binary');
    await writeFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'old-manifest');
    await expect(prepareMeilisearch({
      target: 'darwin-arm64', environment,
      cacheRoot: path.join(at, 'cache'), runtimeRoot,
    }, {
      fetch: async () => new Response(Buffer.from('tampered')),
      pins: fixturePins(machoArm64()), run: versionRun,
    })).rejects.toThrow(/size|checksum/u);
    expect(await readFile(path.join(runtimeRoot, 'meilisearch'), 'utf8')).toBe('old-binary');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'utf8')).toBe('old-manifest');
  });

  it('rolls back an install failure and preserves the previous runtime pair', async () => {
    const at = await root();
    const runtimeRoot = path.join(at, 'runtime');
    await mkdir(runtimeRoot);
    await writeFile(path.join(runtimeRoot, 'meilisearch'), 'old-binary');
    await writeFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'old-manifest');
    const binary = machoArm64();
    await expect(prepareMeilisearch({
      target: 'darwin-arm64', environment,
      cacheRoot: path.join(at, 'cache'), runtimeRoot,
    }, {
      fetch: async () => new Response(binary), pins: fixturePins(binary), run: versionRun,
      installFault: async (phase: string) => { if (phase === 'binary-installed') throw new Error('injected install failure'); },
    })).rejects.toThrow(/injected install failure/u);
    expect(await readFile(path.join(runtimeRoot, 'meilisearch'), 'utf8')).toBe('old-binary');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'utf8')).toBe('old-manifest');
  });

  it('explains the Windows VC runtime prerequisite when the pinned executable cannot start', async () => {
    const at = await root();
    const binary = peX64();
    const pins = fixturePins(machoArm64()) as ReturnType<typeof fixturePins> & { assets: Record<string, unknown> };
    pins.assets['win32-x64'] = {
      asset: 'meilisearch-windows-amd64.exe', url: 'https://example.test/meilisearch-windows-amd64.exe',
      bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), format: 'PE32+', arch: 'x64',
    };
    await expect(prepareMeilisearch({
      target: 'win32-x64',
      environment: { platform: 'win32', processArch: 'x64', hostArch: 'x64' },
      cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'),
    }, {
      fetch: async () => new Response(binary), pins,
      run: async () => { throw new Error('missing dependency'); },
    })).rejects.toThrow(/Microsoft Visual C\+\+ v14 x64 runtime/u);
  });

  it('wires both package commands through the guarded wrapper with one artifact name per platform', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['package:mac']).toBe('node scripts/package-app.mjs --target darwin-arm64');
    expect(packageJson.scripts['package:win']).toBe('node scripts/package-app.mjs --target win32-x64');
    const { getConfig } = await import('app-builder-lib/out/util/config/config.js');
    const config = await getConfig(process.cwd(), 'electron-builder.yml');
    expect(config.directories?.output).toBe('release');
    expect(config.mac?.artifactName).toBe('XR-Collector-${version}-mac-${arch}.${ext}');
    expect(config.win?.artifactName).toBe('XR-Collector-${version}-win-${arch}-setup.${ext}');
    expect(config.win?.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'resources/bin/win', filter: expect.arrayContaining(['vcruntime140.dll', 'runtime-dependencies.json']) }),
    ]));
  });

  it('rejects unknown arguments at the CLI boundary', () => {
    expect(() => parsePrepareArguments(['--verbose'])).toThrow(/Unknown argument --verbose/u);
  });

  it('serializes concurrent installs into one runtime directory', async () => {
    const at = await root();
    const runtime = path.join(at, 'runtime');
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withRuntimeInstallLock(runtime, async () => { entered(); await gate; });
    await inside;
    await expect(withRuntimeInstallLock(runtime, async () => undefined)).rejects.toThrow(/runtime installation owns/u);
    release();
    await first;
    await expect(withRuntimeInstallLock(runtime, async () => 'installed')).resolves.toBe('installed');
  });
  it('rolls both runtime files back when replacement fails between the pair', async () => {
    const at = await root();
    const binary = path.join(at, 'source');
    const destination = path.join(at, 'runtime', 'meilisearch');
    const manifest = path.join(at, 'runtime', 'meilisearch-build.json');
    await mkdir(path.dirname(destination));
    await writeFile(binary, 'new');
    await writeFile(destination, 'old');
    await writeFile(manifest, '{"old":true}\n');
    await expect(transactionalReplacePair({
      binarySource: binary,
      manifest: { next: true },
      binaryDestination: destination,
      manifestDestination: manifest,
      fault: async (phase: string) => { if (phase === 'binary-installed') throw new Error('injected rename failure'); },
    })).rejects.toThrow(/injected/u);
    expect(await readFile(destination, 'utf8')).toBe('old');
    expect(await readFile(manifest, 'utf8')).toBe('{"old":true}\n');
  });

  it('preserves backup files and reports their paths when rollback cannot restore them', async () => {
    const at = await root();
    const binary = path.join(at, 'source');
    const runtime = path.join(at, 'runtime');
    const destination = path.join(runtime, 'meilisearch');
    const manifest = path.join(runtime, 'meilisearch-build.json');
    await mkdir(runtime);
    await writeFile(binary, 'new');
    await writeFile(destination, 'old-binary');
    await writeFile(manifest, 'old-manifest');
    const move = async (source: string, target: string) => {
      if (source.endsWith('.bak')) throw new Error('injected restore failure');
      await rename(source, target);
    };
    await expect(transactionalReplacePair({
      binarySource: binary, manifest: { next: true }, binaryDestination: destination, manifestDestination: manifest,
      fault: async (phase: string) => { if (phase === 'binary-installed') throw new Error('injected install failure'); },
      move,
    })).rejects.toThrow(/rollback was incomplete.*\.bak/u);
    const backups = (await readdir(runtime)).filter((name) => name.endsWith('.bak'));
    expect(backups).toHaveLength(2);
    expect(await Promise.all(backups.map((name) => readFile(path.join(runtime, name), 'utf8')))).toEqual(expect.arrayContaining(['old-binary', 'old-manifest']));
  });

  it('keeps a fully committed pair when deleting its old backups fails', async () => {
    const at = await root();
    const binary = path.join(at, 'source');
    const runtime = path.join(at, 'runtime');
    const destination = path.join(runtime, 'meilisearch');
    const manifest = path.join(runtime, 'meilisearch-build.json');
    await mkdir(runtime);
    await writeFile(binary, 'new');
    await writeFile(destination, 'old-binary');
    await writeFile(manifest, 'old-manifest');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const remove = async (target: string, options: { force?: boolean }) => {
      if (target.endsWith('.bak')) throw new Error('injected cleanup failure');
      await rm(target, options);
    };
    await expect(transactionalReplacePair({ binarySource: binary, manifest: { next: true }, binaryDestination: destination, manifestDestination: manifest, remove })).resolves.toBeUndefined();
    expect(await readFile(destination, 'utf8')).toBe('new');
    expect(JSON.parse(await readFile(manifest, 'utf8'))).toEqual({ next: true });
    expect((await readdir(runtime)).filter((name) => name.endsWith('.bak'))).toHaveLength(2);
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});
