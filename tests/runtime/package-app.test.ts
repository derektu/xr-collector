import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { createPackage } from '@electron/asar';
import { getConfig } from 'app-builder-lib/out/util/config/config.js';
import { assertHostTarget, packageChildEnvironment, parsePackageArguments, readPackagingGitIdentity, verifyPackagedApplication, withPackageCheckoutLock, writeArtifactHandoff } from '../../scripts/package-app.mjs';

const exec = promisify(execFile);

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('accepts only the two delivery targets and two explicit variants', () => {
  expect(parsePackageArguments(['--target', 'darwin-arm64', '--variant', 'chinese'])).toEqual({ target: 'darwin-arm64', variant: 'chinese' });
  expect(() => parsePackageArguments(['--target', 'darwin-x64', '--variant', 'official'])).toThrow(/Unsupported packaging target/u);
  expect(() => parsePackageArguments(['--target', 'win32-x64', '--variant', 'other'])).toThrow(/Unsupported packaging variant/u);
});

it('allows an x64 Windows process on the authorized ARM64 builder and records emulation separately', async () => {
  await expect(assertHostTarget('win32-x64', async () => ({ platform: 'win32', processArch: 'x64', hostArch: 'arm64', emulated: true }))).resolves.toBeUndefined();
  await expect(assertHostTarget('win32-x64', async () => ({ platform: 'win32', processArch: 'arm64', hostArch: 'arm64', emulated: false }))).rejects.toThrow(/x64 Windows process/u);
});

it('removes Git routing and signing credentials from every packaging child environment', () => {
  expect(packageChildEnvironment({
    PATH: '/tools', GIT_DIR: '/other/.git', git_work_tree: '/other', CSC_LINK: 'secret', CSC_KEY_PASSWORD: 'secret',
    WIN_CSC_LINK: 'secret', APPLE_ID: 'secret', APPLE_API_KEY: 'secret', NOTARYTOOL_PROFILE: 'secret',
  })).toEqual({ PATH: '/tools', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
});

it('resolves each Windows package resource once with an exact app-local CRT filter', async () => {
  for (const configFile of ['electron-builder.official.yml', 'electron-builder.yml']) {
    const config = await getConfig(process.cwd(), path.resolve(configFile), null);
    const resources = config.win?.extraResources ?? [];
    const keys = resources.map((entry) => typeof entry === 'string' ? entry : `${entry.from}:${entry.to}`);
    expect(new Set(keys).size, configFile).toBe(keys.length);
    const runtime = resources.find((entry) => typeof entry !== 'string' && entry.from === 'resources/bin/win');
    expect(runtime, configFile).toMatchObject({ to: 'bin' });
    if (typeof runtime === 'string' || runtime === undefined) throw new Error(`${configFile} lacks its Windows runtime resource.`);
    expect(runtime.filter, configFile).toContain('vcruntime140.dll');
    expect(runtime.filter, configFile).not.toContain('*.dll');
    expect(resources, configFile).toContainEqual({ from: 'resources/search', to: 'search' });
  }
});

it('rejects the actual dirty checkout even when inherited Git routing points at another clean repository', async () => {
  const own = await mkdtemp(path.join(tmpdir(), 'xr-package-own-git-'));
  const other = await mkdtemp(path.join(tmpdir(), 'xr-package-other-git-'));
  roots.push(own, other);
  for (const root of [own, other]) {
    await exec('git', ['init'], { cwd: root });
    await writeFile(path.join(root, 'tracked'), 'clean');
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: root });
  }
  await writeFile(path.join(own, 'tracked'), 'dirty');
  await expect(readPackagingGitIdentity(own, { ...process.env, GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other }))
    .rejects.toThrow(/clean Git checkout/u);
});

it('rejects a concurrent whole-checkout package run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-package-lock-'));
  roots.push(root);
  const lock = path.join(root, 'package.lock');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withPackageCheckoutLock(lock, async () => gate);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(withPackageCheckoutLock(lock, async () => undefined)).rejects.toThrow(/whole-checkout packaging run/u);
  release();
  await first;
  await expect(withPackageCheckoutLock(lock, async () => 'ok')).resolves.toBe('ok');
});

it('verifies BuildInfo and every packaged runtime before accepting an app', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-packaged-app-'));
  roots.push(root);
  const outputDir = path.join(root, 'release');
  const resources = path.join(outputDir, 'mac-arm64', 'XR Collector.app', 'Contents', 'Resources');
  const asarSource = path.join(root, 'asar');
  const sourceSkill = path.join(root, 'source-SKILL.md');
  await writeFile(sourceSkill, 'skill');
  await mkdir(path.join(asarSource, 'dist/node'), { recursive: true });
  const commit = 'b'.repeat(40);
  await writeFile(path.join(asarSource, 'dist/node/build-info.json'), JSON.stringify({ schemaVersion: 1, kind: 'packaged', version: '0.1.0', builtAt: '2026-10-25T00:00:00.000Z', commit, buildId: 'id', target: 'darwin-arm64', variant: 'chinese', sourceDirty: false }));
  await mkdir(resources, { recursive: true });
  await createPackage(asarSource, path.join(resources, 'app.asar'));
  await mkdir(path.join(resources, 'skills/xr-collector-agent'), { recursive: true });
  await writeFile(path.join(resources, 'skills/xr-collector-agent/SKILL.md'), 'skill');
  await mkdir(path.join(resources, 'bin/yt-dlp'), { recursive: true });
  await writeFile(path.join(resources, 'bin/yt-dlp/yt-dlp'), 'yt');
  await writeFile(path.join(resources, 'bin/deno'), 'deno');
  const fileEntry = async (file: string, relative: string) => ({ path: relative, bytes: (await readFile(file)).byteLength, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
  const dependencyPins = JSON.parse(await readFile(path.resolve('scripts/runtime-dependency-pins.json'), 'utf8'));
  const dependency = (pin: { version: string; url: string; sha256: string }) => ({ version: pin.version, url: pin.url, archiveSha256: pin.sha256 });
  await writeFile(path.join(resources, 'bin/runtime-dependencies.json'), JSON.stringify({
    schemaVersion: 1, target: 'darwin-arm64',
    dependencies: { ytDlp: dependency(dependencyPins.targets['darwin-arm64'].ytDlp), deno: dependency(dependencyPins.targets['darwin-arm64'].deno) },
    executables: { ytDlp: 'yt-dlp/yt-dlp', deno: 'deno' },
    files: [await fileEntry(path.join(resources, 'bin/deno'), 'deno'), await fileEntry(path.join(resources, 'bin/yt-dlp/yt-dlp'), 'yt-dlp/yt-dlp')],
  }));
  const meiliBinary = Buffer.alloc(32);
  meiliBinary.writeUInt32LE(0xfeedfacf, 0);
  meiliBinary.writeUInt32LE(0x0100000c, 4);
  await writeFile(path.join(resources, 'bin/meilisearch'), meiliBinary);
  const meiliFile = await fileEntry(path.join(resources, 'bin/meilisearch'), 'meilisearch');
  const meiliManifest = {
    schemaVersion: 1, recipeRevision: 1, recipeFingerprint: 'fixture', sourceRepository: 'https://github.com/meilisearch/meilisearch.git',
    sourceTag: 'v1.53.2', sourceCommit: 'ec006cecec6f684b1dcaee093a45ab4c05707127', target: 'darwin-arm64',
    features: ['chinese'], defaultFeatures: false,
    binary: { version: '1.53.2', versionOutput: 'meilisearch 1.53.2', bytes: meiliFile.bytes, sha256: meiliFile.sha256, format: 'Mach-O 64', arch: 'arm64' },
  };
  await writeFile(path.join(resources, 'bin/meilisearch-build.json'), JSON.stringify(meiliManifest));
  await mkdir(path.join(resources, 'search'), { recursive: true });
  await writeFile(path.join(resources, 'search/coct-main.txt'), '測試 1 n\n');
  const lexiconBytes = await readFile(path.join(resources, 'search/coct-main.txt'));
  const lexiconManifest = {
    schemaVersion: 1,
    output: { file: 'coct-main.txt', bytes: lexiconBytes.byteLength, sha256: createHash('sha256').update(lexiconBytes).digest('hex') },
  };
  await writeFile(path.join(resources, 'search/coct-main.json'), JSON.stringify(lexiconManifest));

  const verify = (trustedManifest: object = meiliManifest, versionOutput = 'meilisearch 1.53.2') => verifyPackagedApplication(
    { outputDir, commit, version: '0.1.0', target: 'darwin-arm64', variant: 'chinese' },
    { trustedManifest, trustedLexiconManifest: lexiconManifest, sourceSkillPath: sourceSkill, runBinary: async () => ({ stdout: versionOutput }) },
  );
  await expect(verify()).resolves.toMatchObject({ buildInfo: { buildId: 'id' } });
  await expect(verify(meiliManifest, 'meilisearch 1.52.0')).rejects.toThrow(/expected meilisearch 1\.53\.2/u);
  const inventedSourceDistribution = { ...meiliManifest, distribution: 'source' };
  await writeFile(path.join(resources, 'bin/meilisearch-build.json'), JSON.stringify(inventedSourceDistribution));
  await expect(verify(inventedSourceDistribution)).rejects.toThrow(/package variant/u);
  await writeFile(path.join(resources, 'bin/meilisearch-build.json'), JSON.stringify(meiliManifest));
  await writeFile(path.join(resources, 'skills/xr-collector-agent/SKILL.md'), 'stale skill');
  await expect(verify()).rejects.toThrow(/Agent Skill/u);
  await writeFile(path.join(resources, 'skills/xr-collector-agent/SKILL.md'), 'skill');
  await writeFile(path.join(resources, 'search/coct-main.txt'), 'wrong lexicon');
  await expect(verify()).rejects.toThrow(/search lexicon bytes/u);
  await writeFile(path.join(resources, 'search/coct-main.txt'), lexiconBytes);
  await writeFile(path.join(resources, 'bin/meilisearch'), 'official wrong pair');
  await expect(verify()).rejects.toThrow(/Meilisearch bytes/u);
});

it('writes unique update metadata and an exact artifact inventory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-package-artifacts-'));
  roots.push(root);
  const installer = path.join(root, 'XR-Collector-0.1.0-official-win-x64-setup.exe');
  await writeFile(installer, 'installer');
  const result = await writeArtifactHandoff({
    outputDir: root, target: 'win32-x64', variant: 'official', version: '0.1.0', commit: 'a'.repeat(40),
    buildInfo: { schemaVersion: 1, kind: 'packaged', version: '0.1.0', builtAt: '2026-10-25T00:00:00.000Z', commit: 'a'.repeat(40), buildId: 'build', target: 'win32-x64', variant: 'official', sourceDirty: false },
    artifacts: [installer], host: { platform: 'win32', processArch: 'x64', hostArch: 'arm64', emulated: true },
    toolVersions: { node: 'v22' }, signing: { status: 'unsigned' },
  });
  expect(path.basename(result.updateMetadata)).toBe('XR-Collector-0.1.0-official-win32-x64-update.yml');
  expect(path.basename(result.artifactManifest)).toBe('XR-Collector-0.1.0-official-win32-x64-artifacts.json');
  const manifest = JSON.parse(await readFile(result.artifactManifest, 'utf8'));
  expect(manifest.artifacts.map((entry: { path: string }) => entry.path)).toEqual([
    'XR-Collector-0.1.0-official-win-x64-setup.exe',
    'XR-Collector-0.1.0-official-win32-x64-update.yml',
  ]);
  expect(manifest.artifacts[0].sha256).toBe(createHash('sha256').update('installer').digest('hex'));
  expect(await readFile(result.updateMetadata, 'utf8')).toContain('XR-Collector-0.1.0-official-win-x64-setup.exe');
});
