import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The production preparation entry point is intentionally executable JavaScript.
import { parsePrepareArguments, prepareMeilisearch } from '../../scripts/prepare-meilisearch.mjs';

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
    official: {
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
  it('keeps Chinese as the default and delegates to the existing source builder', async () => {
    const build = vi.fn(async (options) => ({ variant: 'chinese', options }));
    await expect(prepareMeilisearch({ target: 'darwin-arm64' }, { build })).resolves.toMatchObject({ variant: 'chinese' });
    expect(build).toHaveBeenCalledWith({ target: 'darwin-arm64' });
  });

  it('downloads, verifies and atomically installs the pinned official asset, then reuses its cache', async () => {
    const at = await root();
    const binary = machoArm64();
    const pins = fixturePins(binary);
    const fetch = vi.fn(async () => new Response(binary));
    const options = {
      variant: 'official', target: 'darwin-arm64', environment,
      cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'),
    };
    const dependencies = { fetch, pins, run: versionRun };
    const first = await prepareMeilisearch(options, dependencies);
    const second = await prepareMeilisearch(options, dependencies);
    expect(first).toMatchObject({ variant: 'official', cacheHit: false });
    expect(second).toMatchObject({ variant: 'official', cacheHit: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(first.binaryPath)).toEqual(binary);
    expect(JSON.parse(await readFile(first.manifestPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      distribution: 'official',
      releaseRepository: pins.releaseRepository,
      releaseTag: pins.releaseTag,
      releaseAsset: pins.official['darwin-arm64'].asset,
      releaseUrl: pins.official['darwin-arm64'].url,
      target: 'darwin-arm64',
      binary: {
        version: '1.53.2', versionOutput: 'meilisearch 1.53.2', bytes: binary.length,
        sha256: pins.official['darwin-arm64'].sha256, format: 'Mach-O 64', arch: 'arm64',
      },
    });
  });

  it('rejects unsupported official Mac x64 before downloading and preserves the installed pair', async () => {
    const at = await root();
    const runtimeRoot = path.join(at, 'runtime');
    await mkdir(runtimeRoot);
    await writeFile(path.join(runtimeRoot, 'meilisearch'), 'old-binary');
    await writeFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'old-manifest');
    const fetch = vi.fn();
    await expect(prepareMeilisearch({
      variant: 'official', target: 'darwin-x64',
      environment: { platform: 'darwin', processArch: 'x64', hostArch: 'x64' },
      cacheRoot: path.join(at, 'cache'), runtimeRoot,
    }, { fetch, pins: fixturePins(machoArm64()), run: versionRun })).rejects.toThrow(/not published.*darwin-x64/u);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(path.join(runtimeRoot, 'meilisearch'), 'utf8')).toBe('old-binary');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'utf8')).toBe('old-manifest');
  });

  it('preserves the installed pair when the official response checksum is wrong', async () => {
    const at = await root();
    const runtimeRoot = path.join(at, 'runtime');
    await mkdir(runtimeRoot);
    await writeFile(path.join(runtimeRoot, 'meilisearch'), 'old-binary');
    await writeFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'old-manifest');
    await expect(prepareMeilisearch({
      variant: 'official', target: 'darwin-arm64', environment,
      cacheRoot: path.join(at, 'cache'), runtimeRoot,
    }, {
      fetch: async () => new Response(Buffer.from('tampered')),
      pins: fixturePins(machoArm64()), run: versionRun,
    })).rejects.toThrow(/size|checksum/u);
    expect(await readFile(path.join(runtimeRoot, 'meilisearch'), 'utf8')).toBe('old-binary');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'utf8')).toBe('old-manifest');
  });

  it('rolls back an official install failure and preserves the previous runtime pair', async () => {
    const at = await root();
    const runtimeRoot = path.join(at, 'runtime');
    await mkdir(runtimeRoot);
    await writeFile(path.join(runtimeRoot, 'meilisearch'), 'old-binary');
    await writeFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'old-manifest');
    const binary = machoArm64();
    await expect(prepareMeilisearch({
      variant: 'official', target: 'darwin-arm64', environment,
      cacheRoot: path.join(at, 'cache'), runtimeRoot,
    }, {
      fetch: async () => new Response(binary), pins: fixturePins(binary), run: versionRun,
      installFault: async (phase: string) => { if (phase === 'binary-installed') throw new Error('injected install failure'); },
    })).rejects.toThrow(/injected install failure/u);
    expect(await readFile(path.join(runtimeRoot, 'meilisearch'), 'utf8')).toBe('old-binary');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'utf8')).toBe('old-manifest');
  });

  it('explains the official Windows VC runtime prerequisite when the pinned executable cannot start', async () => {
    const at = await root();
    const binary = peX64();
    const pins = fixturePins(machoArm64()) as ReturnType<typeof fixturePins> & { official: Record<string, unknown> };
    pins.official['win32-x64'] = {
      asset: 'meilisearch-windows-amd64.exe', url: 'https://example.test/meilisearch-windows-amd64.exe',
      bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), format: 'PE32+', arch: 'x64',
    };
    await expect(prepareMeilisearch({
      variant: 'official', target: 'win32-x64',
      environment: { platform: 'win32', processArch: 'x64', hostArch: 'x64' },
      cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'),
    }, {
      fetch: async () => new Response(binary), pins,
      run: async () => { throw new Error('missing dependency'); },
    })).rejects.toThrow(/Microsoft Visual C\+\+ v14 x64 runtime/u);
  });

  it('wires distinct default and official package outputs without changing the default package commands', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['package:mac']).toBe('npm run download:runtime && npm run build && electron-builder --mac --publish never');
    expect(packageJson.scripts['package:win']).toBe('npm run download:runtime:win && npm run build && electron-builder --win --x64 --publish never');
    expect(packageJson.scripts['package:mac:official']).toContain('--variant official --target darwin-arm64');
    expect(packageJson.scripts['package:win:official']).toContain('--variant official --target win32-x64');
    const { getConfig } = await import('app-builder-lib/out/util/config/config.js');
    const config = await getConfig(process.cwd(), 'electron-builder.official.yml');
    expect(config.directories?.output).toBe('release/official');
    expect(config.artifactName).toBe('XR-Collector-${version}-official-${os}-${arch}.${ext}');
    expect(config.win?.artifactName).toBe('XR-Collector-${version}-official-win-${arch}-setup.${ext}');
  });

  it('rejects unknown variants at the CLI boundary', () => {
    expect(() => parsePrepareArguments(['--variant', 'enterprise'])).toThrow(/chinese.*official/u);
  });
});
