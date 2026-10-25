import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareRuntimeDependencies } from '../../scripts/runtime-dependencies.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

it('keeps every production archive and CRT checksum as a full SHA-256 pin', async () => {
  const pins = JSON.parse(await readFile(path.resolve('scripts/runtime-dependency-pins.json'), 'utf8')) as {
    targets: Record<string, { ytDlp: { sha256: string }; deno: { sha256: string } }>;
    officialWindowsCrt: { sha256: string };
  };
  for (const target of Object.values(pins.targets)) {
    expect(target.ytDlp.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(target.deno.sha256).toMatch(/^[0-9a-f]{64}$/u);
  }
  expect(pins.officialWindowsCrt.sha256).toMatch(/^[0-9a-f]{64}$/u);
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
