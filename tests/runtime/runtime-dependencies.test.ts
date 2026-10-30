import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareRuntimeDependencies } from '../../scripts/runtime-dependencies.mjs';
import { runtimeCacheRoot } from '../../scripts/runtime-cache.mjs';
import { parsePrepareRuntimeArguments, prepareRuntime } from '../../scripts/prepare-runtime.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

it('keeps every production archive and CRT checksum as a full SHA-256 pin', async () => {
  const pins = JSON.parse(await readFile(path.resolve('scripts/runtime-dependency-pins.json'), 'utf8')) as {
    targets: Record<string, { ytDlp: { sha256: string }; deno: { sha256: string } }>;
    windowsCrt: { sha256: string };
  };
  for (const target of Object.values(pins.targets)) {
    expect(target.ytDlp.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(target.deno.sha256).toMatch(/^[0-9a-f]{64}$/u);
  }
  expect(pins.windowsCrt.sha256).toMatch(/^[0-9a-f]{64}$/u);
});

it('repairs a changed runtime file from the verified archive cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-runtime-dependencies-'));
  roots.push(root);
  const outputDir = path.join(root, 'resources', 'bin', 'mac');
  const cacheRoot = path.join(root, 'cache');
  const archives = { 'https://fixtures/yt-dlp.zip': 'yt-archive', 'https://fixtures/deno.zip': 'deno-archive' };
  const pins = {
    schemaVersion: 1,
    targets: {
      'darwin-arm64': {
        directory: 'mac',
        ytDlp: { url: 'https://fixtures/yt-dlp.zip', sha256: sha256('yt-archive'), version: '2026.08.19' },
        deno: { url: 'https://fixtures/deno.zip', sha256: sha256('deno-archive'), version: '2.9.6' },
      },
    },
  };
  let downloads = 0;
  const fetchArchive = async (url: string): Promise<Response> => {
    downloads += 1;
    return new Response(archives[url as keyof typeof archives]);
  };
  const extractZip = async (archive: string, destination: string): Promise<void> => {
    const body = await readFile(archive, 'utf8');
    await mkdir(destination, { recursive: true });
    if (body === 'yt-archive') {
      await writeFile(path.join(destination, 'yt-dlp_macos'), 'yt executable');
      await mkdir(path.join(destination, '_internal'));
      await writeFile(path.join(destination, '_internal', 'support'), 'support');
    } else {
      await writeFile(path.join(destination, 'deno'), 'deno executable');
    }
  };
  const dependencies = { pins, fetch: fetchArchive, extractZip, reportsVersion: async () => true };

  await prepareRuntimeDependencies({ target: 'darwin-arm64', outputDir, cacheRoot }, dependencies);
  expect(downloads).toBe(2);
  await writeFile(path.join(outputDir, 'yt-dlp', 'yt-dlp'), 'changed');

  await prepareRuntimeDependencies({ target: 'darwin-arm64', outputDir, cacheRoot }, {
    ...dependencies,
    fetch: async () => { throw new Error('the verified cache should be reused'); },
  });

  expect(downloads).toBe(2);
  expect(await readFile(path.join(outputDir, 'yt-dlp', 'yt-dlp'), 'utf8')).toBe('yt executable');
  const manifest = JSON.parse(await readFile(path.join(outputDir, 'runtime-dependencies.json'), 'utf8')) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  expect(manifest.files).toEqual([
    { path: 'deno', bytes: 15, sha256: sha256('deno executable') },
    { path: 'yt-dlp/_internal/support', bytes: 7, sha256: sha256('support') },
    { path: 'yt-dlp/yt-dlp', bytes: 13, sha256: sha256('yt executable') },
  ]);
});

it('preserves installed runtimes when a download fails checksum validation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-runtime-dependencies-failure-'));
  roots.push(root);
  const outputDir = path.join(root, 'runtime');
  await mkdir(path.join(outputDir, 'yt-dlp'), { recursive: true });
  await writeFile(path.join(outputDir, 'yt-dlp/yt-dlp'), 'old yt');
  await writeFile(path.join(outputDir, 'deno'), 'old deno');
  const pins = { schemaVersion: 1, targets: { 'darwin-arm64': { directory: 'mac', ytDlp: { url: 'https://fixtures/yt.zip', sha256: sha256('expected yt'), version: '1' }, deno: { url: 'https://fixtures/deno.zip', sha256: sha256('expected deno'), version: '2' } } } };
  await expect(prepareRuntimeDependencies({ target: 'darwin-arm64', outputDir, cacheRoot: path.join(root, 'cache') }, {
    pins, fetch: async () => new Response('wrong bytes'), reportsVersion: async () => true,
  })).rejects.toThrow(/checksum mismatch/u);
  expect(await readFile(path.join(outputDir, 'yt-dlp/yt-dlp'), 'utf8')).toBe('old yt');
  expect(await readFile(path.join(outputDir, 'deno'), 'utf8')).toBe('old deno');
});

it('places the shared runtime cache outside the checkout, per user, with an absolute override', () => {
  expect(runtimeCacheRoot({}, 'darwin', '/Users/dev')).toBe('/Users/dev/.cache/xr-collector/runtime');
  expect(runtimeCacheRoot({}, 'linux', '/home/dev')).toBe('/home/dev/.cache/xr-collector/runtime');
  expect(runtimeCacheRoot({ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'win32', 'C:\\Users\\dev')).toBe('C:\\Users\\dev\\AppData\\Local\\xr-collector\\runtime');
  expect(runtimeCacheRoot({ XR_COLLECTOR_RUNTIME_CACHE: '/Volumes/cache/xr' }, 'darwin', '/Users/dev')).toBe('/Volumes/cache/xr');
  expect(() => runtimeCacheRoot({ XR_COLLECTOR_RUNTIME_CACHE: 'relative/cache' }, 'darwin', '/Users/dev')).toThrow(/absolute path/u);
  expect(() => runtimeCacheRoot({}, 'win32', 'C:\\Users\\dev')).toThrow(/LOCALAPPDATA/u);
});

it('parses the prepare command and fills the cache before installing both runtimes', async () => {
  expect(parsePrepareRuntimeArguments(['mac'])).toEqual({ target: 'darwin-arm64', cacheOnly: false });
  expect(parsePrepareRuntimeArguments(['win', '--cache-only'])).toEqual({ target: 'win32-x64', cacheOnly: true });
  expect(() => parsePrepareRuntimeArguments(['linux'])).toThrow(/prepare:runtime -- <mac\|win>/u);
  expect(() => parsePrepareRuntimeArguments(['mac', '--verbose'])).toThrow(/Unknown argument --verbose/u);
  const calls: unknown[] = [];
  await prepareRuntime({ target: 'darwin-arm64', cacheOnly: true }, {
    prepareRuntimeDependencies: async (options: unknown) => { calls.push(['dependencies', options]); },
    prepareMeilisearch: async (options: unknown) => { calls.push(['meilisearch', options]); },
  });
  expect(calls).toEqual([
    ['dependencies', { target: 'darwin-arm64', cacheOnly: true }],
    ['meilisearch', { target: 'darwin-arm64', cacheOnly: true }],
  ]);
  const scripts = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')).scripts as Record<string, string>;
  expect(scripts['prepare:runtime']).toBe('node scripts/prepare-runtime.mjs');
  expect(scripts['download:runtime']).toBe('node scripts/prepare-runtime.mjs mac');
  expect(scripts['download:runtime:win']).toBe('node scripts/prepare-runtime.mjs win');
});

it('installs from the cache without downloading in cache-only mode and names the prepare command on a miss', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-runtime-cache-only-'));
  roots.push(root);
  const cacheRoot = path.join(root, 'cache');
  const pins = {
    schemaVersion: 1,
    targets: {
      'darwin-arm64': {
        directory: 'mac',
        ytDlp: { url: 'https://fixtures/yt-dlp.zip', sha256: sha256('yt-archive'), version: '2026.08.19' },
        deno: { url: 'https://fixtures/deno.zip', sha256: sha256('deno-archive'), version: '2.9.6' },
      },
    },
  };
  const archives: Record<string, string> = { 'https://fixtures/yt-dlp.zip': 'yt-archive', 'https://fixtures/deno.zip': 'deno-archive' };
  const extractZip = async (archive: string, destination: string): Promise<void> => {
    const body = await readFile(archive, 'utf8');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, body === 'yt-archive' ? 'yt-dlp_macos' : 'deno'), body);
  };
  const noDownload = async (): Promise<Response> => { throw new Error('cache-only mode must not download'); };
  const cacheOnly = (outputDir: string) => prepareRuntimeDependencies({ target: 'darwin-arm64', outputDir, cacheRoot, cacheOnly: true },
    { pins, fetch: noDownload, extractZip, reportsVersion: async () => true });

  await expect(cacheOnly(path.join(root, 'checkout-a'))).rejects.toThrow(/missing from the runtime cache.*npm run prepare:runtime -- mac first/u);
  await prepareRuntimeDependencies({ target: 'darwin-arm64', outputDir: path.join(root, 'checkout-a'), cacheRoot }, {
    pins, fetch: async (url: string) => new Response(archives[url]), extractZip, reportsVersion: async () => true,
  });
  // A second checkout installs the same pins from the shared cache.
  await expect(cacheOnly(path.join(root, 'checkout-b'))).resolves.toMatchObject({ cacheHit: false });
  expect(await readFile(path.join(root, 'checkout-b', 'yt-dlp', 'yt-dlp'), 'utf8')).toBe('yt-archive');
  await expect(cacheOnly(path.join(root, 'checkout-b'))).resolves.toMatchObject({ cacheHit: true });

  await writeFile(path.join(cacheRoot, `deno-${sha256('deno-archive')}.zip`), 'tampered');
  await expect(cacheOnly(path.join(root, 'checkout-b'))).rejects.toThrow(/Pinned deno 2\.9\.6 archive for darwin-arm64 is missing from the runtime cache or does not match/u);
});
