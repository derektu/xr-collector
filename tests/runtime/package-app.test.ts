import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { createPackage } from '@electron/asar';
import { getConfig } from 'app-builder-lib/out/util/config/config.js';
import { assertHostTarget, assertPackagedProductMetadata, packageChildEnvironment, parsePackageArguments, readPackagingGitIdentity, stageBuildInfoSidecar, validationBuilderArguments, verifyMacBundleSignature, verifyPackagedApplication, withPackageCheckoutLock, writeArtifactHandoff } from '../../scripts/package-app.mjs';

const exec = promisify(execFile);

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('accepts only the two delivery targets and two explicit variants', () => {
  expect(parsePackageArguments(['--target', 'darwin-arm64', '--variant', 'chinese'])).toEqual({ target: 'darwin-arm64', variant: 'chinese' });
  expect(() => parsePackageArguments(['--target', 'darwin-x64', '--variant', 'official'])).toThrow(/Unsupported packaging target/u);
  expect(() => parsePackageArguments(['--target', 'win32-x64', '--variant', 'other'])).toThrow(/Unsupported packaging variant/u);
});

it('requires an explicit isolated identity for validation version overrides', () => {
  const args = ['--target', 'darwin-arm64', '--variant', 'chinese', '--validation-version', '0.1.1',
    '--validation-app-id', 'com.xrcollector.verify36', '--validation-product-name', 'XR Update Verify 36'];
  expect(() => parsePackageArguments(args)).toThrow(/XR_COLLECTOR_VALIDATION_BUILD/u);
  process.env.XR_COLLECTOR_VALIDATION_BUILD = '1';
  try {
    expect(parsePackageArguments(args)).toMatchObject({ validationVersion: '0.1.1', validationAppId: 'com.xrcollector.verify36', validationUpdateRepository: 'derektu/xr-collector' });
    expect(parsePackageArguments([...args, '--validation-update-repository', 'derektu/xr-collector-test'])).toMatchObject({ validationUpdateRepository: 'derektu/xr-collector-test' });
    expect(() => parsePackageArguments([...args, '--validation-update-repository', 'https://github.com/derektu/xr-collector-test'])).toThrow(/repository/u);
    expect(() => parsePackageArguments(['--target', 'darwin-arm64', '--variant', 'chinese', '--validation-update-repository', 'derektu/xr-collector-test'])).toThrow(/all validation options/u);
  }
  finally { delete process.env.XR_COLLECTOR_VALIDATION_BUILD; }
});

it('bakes the validation product name into package metadata so Electron derives an isolated userData folder', () => {
  const options = { validationVersion: '0.1.1', validationAppId: 'com.xrcollector.verify36', validationProductName: 'XR Update Verify Mac Chinese' };
  expect(validationBuilderArguments(options)).toEqual([
    '--config.extraMetadata.version=0.1.1',
    '--config.extraMetadata.productName=XR Update Verify Mac Chinese',
    '--config.extraMetadata.xrCollectorAppId=com.xrcollector.verify36',
    '--config.extraMetadata.xrCollectorUpdateRepository=derektu/xr-collector',
    '--config.appId=com.xrcollector.verify36',
    '--config.productName=XR Update Verify Mac Chinese',
  ]);
  expect(() => assertPackagedProductMetadata({ name: 'xr-collector' }, options.validationProductName, options.validationAppId)).toThrow(/productName/u);
  expect(() => assertPackagedProductMetadata({ name: 'xr-collector', productName: options.validationProductName,
    xrCollectorAppId: options.validationAppId, xrCollectorUpdateRepository: 'derektu/xr-collector' }, options.validationProductName, options.validationAppId)).not.toThrow();
  expect(() => assertPackagedProductMetadata({ name: 'xr-collector', xrCollectorUpdateRepository: 'derektu/xr-collector-test' }, 'XR Collector')).toThrow(/Production package/u);
  expect(validationBuilderArguments({})).toEqual([]);
});

it('accepts the two public update-test identities within the existing validation namespace', () => {
  process.env.XR_COLLECTOR_VALIDATION_BUILD = '1';
  try {
    for (const [variant, productName] of [['chinese', 'XR Update Verify Chinese'], ['official', 'XR Update Verify Official']]) {
      const options = parsePackageArguments(['--target', 'darwin-arm64', '--variant', variant,
        '--validation-version', '0.1.0', '--validation-app-id', `com.xrcollector.verify.public.${variant}`,
        '--validation-product-name', productName, '--validation-update-repository', 'derektu/xr-collector-test']);
      expect(validationBuilderArguments(options)).toContain('--config.extraMetadata.xrCollectorUpdateRepository=derektu/xr-collector-test');
    }
  } finally { delete process.env.XR_COLLECTOR_VALIDATION_BUILD; }
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

it('verifies the complete Mac bundle with strict deep codesign diagnostics', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  await verifyMacBundleSignature('/Applications/XR Collector.app', async (command: string, args: string[]) => {
    calls.push({ command, args });
  });
  expect(calls).toEqual([{ command: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', '/Applications/XR Collector.app'] }]);
  await expect(verifyMacBundleSignature('/Applications/Broken.app', async () => {
    throw new Error('code has no resources but signature indicates they must be present');
  })).rejects.toThrow(/invalid signature.*no resources.*signature/iu);
});

it('resolves each Windows package resource once with an exact app-local CRT filter', async () => {
  for (const configFile of ['electron-builder.official.yml', 'electron-builder.yml']) {
    const config = await getConfig(process.cwd(), path.resolve(configFile), null);
    expect(config.mac, configFile).toMatchObject({ identity: '-', hardenedRuntime: false });
    const resources = config.win?.extraResources ?? [];
    const keys = resources.map((entry) => typeof entry === 'string' ? entry : `${entry.from}:${entry.to}`);
    expect(new Set(keys).size, configFile).toBe(keys.length);
    const runtime = resources.find((entry) => typeof entry !== 'string' && entry.from === 'resources/bin/win');
    expect(runtime, configFile).toMatchObject({ to: 'bin' });
    if (typeof runtime === 'string' || runtime === undefined) throw new Error(`${configFile} lacks its Windows runtime resource.`);
    expect(runtime.filter, configFile).toContain('vcruntime140.dll');
    expect(runtime.filter, configFile).not.toContain('*.dll');
    for (const resources of [config.mac?.extraResources ?? [], config.win?.extraResources ?? []]) {
      expect(resources).toContainEqual(expect.objectContaining({ from: '.local/package-resources/build-info.json', to: 'build-info.json' }));
      expect(resources).not.toContainEqual(expect.objectContaining({ from: 'dist/node/build-info.json' }));
    }
  }
});

it('stages byte-identical BuildInfo for extraResources without consuming the ASAR source path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-package-build-info-'));
  roots.push(root);
  const source = path.join(root, 'dist/node/build-info.json');
  await mkdir(path.dirname(source), { recursive: true });
  const bytes = Buffer.from('{"buildId":"same-bytes"}\n');
  await writeFile(source, bytes);
  const staged = await stageBuildInfoSidecar(root);
  expect(staged.source).toBe(source);
  expect(staged.destination).toBe(path.join(root, '.local/package-resources/build-info.json'));
  expect(await readFile(staged.destination)).toEqual(bytes);
  expect(await readFile(source)).toEqual(bytes);
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
  const buildInfo = { schemaVersion: 1, kind: 'packaged', version: '0.1.0', builtAt: '2026-10-25T00:00:00.000Z', commit, buildId: 'id', target: 'darwin-arm64', variant: 'chinese', sourceDirty: false };
  await writeFile(path.join(asarSource, 'package.json'), JSON.stringify({ name: 'xr-collector', version: '0.1.0' }));
  await writeFile(path.join(asarSource, 'dist/node/build-info.json'), JSON.stringify(buildInfo));
  await mkdir(resources, { recursive: true });
  await createPackage(asarSource, path.join(resources, 'app.asar'));
  await writeFile(path.join(resources, 'build-info.json'), JSON.stringify(buildInfo));
  await mkdir(path.join(resources, 'skills/xr-collector-agent'), { recursive: true });
  await writeFile(path.join(resources, 'skills/xr-collector-agent/SKILL.md'), 'skill');
  await mkdir(path.join(resources, 'bin/yt-dlp'), { recursive: true });
  await writeFile(path.join(resources, 'bin/yt-dlp/yt-dlp'), 'yt');
  await writeFile(path.join(resources, 'bin/deno'), 'deno');
  await writeFile(path.join(resources, 'bin/xr-mac-update-helper'), 'helper', { mode: 0o755 });
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

  const verify = (trustedManifest: object = meiliManifest, versionOutput = 'meilisearch 1.53.2', verifyMacBundle = async () => undefined) => verifyPackagedApplication(
    { outputDir, commit, version: '0.1.0', target: 'darwin-arm64', variant: 'chinese' },
    { trustedManifest, sourceSkillPath: sourceSkill, runBinary: async () => ({ stdout: versionOutput }), verifyMacBundle },
  );
  await expect(verify()).resolves.toMatchObject({ buildInfo: { buildId: 'id' } });
  const expectedApp = path.join(outputDir, 'mac-arm64/XR Collector.app');
  await expect(verify(meiliManifest, 'meilisearch 1.53.2', async (app: string) => {
    expect(app).toBe(expectedApp);
  })).resolves.toMatchObject({ buildInfo: { buildId: 'id' } });
  await expect(verify(meiliManifest, 'meilisearch 1.53.2', async () => {
    throw new Error('code has no resources but signature indicates they must be present');
  })).rejects.toThrow(/no resources.*signature/u);
  await expect(verify(meiliManifest, 'meilisearch 1.52.0')).rejects.toThrow(/expected meilisearch 1\.53\.2/u);
  const inventedSourceDistribution = { ...meiliManifest, distribution: 'source' };
  await writeFile(path.join(resources, 'bin/meilisearch-build.json'), JSON.stringify(inventedSourceDistribution));
  await expect(verify(inventedSourceDistribution)).rejects.toThrow(/package variant/u);
  await writeFile(path.join(resources, 'bin/meilisearch-build.json'), JSON.stringify(meiliManifest));
  await writeFile(path.join(resources, 'skills/xr-collector-agent/SKILL.md'), 'stale skill');
  await expect(verify()).rejects.toThrow(/Agent Skill/u);
  await writeFile(path.join(resources, 'skills/xr-collector-agent/SKILL.md'), 'skill');
  await writeFile(path.join(resources, 'bin/meilisearch'), 'official wrong pair');
  await expect(verify()).rejects.toThrow(/Meilisearch bytes/u);

  await writeFile(path.join(resources, 'bin/meilisearch'), meiliBinary);
  const validationProductName = 'XR Update Verify Chinese';
  const validationAppId = 'com.xrcollector.verify.public.chinese';
  await writeFile(path.join(asarSource, 'package.json'), JSON.stringify({ name: 'xr-collector', version: '0.1.0',
    productName: validationProductName, xrCollectorAppId: validationAppId, xrCollectorUpdateRepository: 'derektu/xr-collector-test' }));
  await rm(path.join(resources, 'app.asar'));
  await createPackage(asarSource, path.join(resources, 'app.asar'));
  await rename(path.join(outputDir, 'mac-arm64/XR Collector.app'), path.join(outputDir, `mac-arm64/${validationProductName}.app`));
  await expect(verifyPackagedApplication({ outputDir, commit, version: '0.1.0', target: 'darwin-arm64', variant: 'chinese',
    productName: validationProductName, appId: validationAppId, updateRepository: 'derektu/xr-collector-test' },
  { trustedManifest: meiliManifest, sourceSkillPath: sourceSkill, runBinary: async () => ({ stdout: 'meilisearch 1.53.2' }), verifyMacBundle: async () => undefined }))
    .resolves.toMatchObject({ packageMetadata: { productName: validationProductName, xrCollectorUpdateRepository: 'derektu/xr-collector-test' } });
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
  expect(manifest.packageIdentity).toEqual({ productName: 'XR Collector', appId: 'com.moneydj.xrcollector', updateRepository: 'derektu/xr-collector' });
  expect(manifest.artifacts.map((entry: { path: string }) => entry.path)).toEqual([
    'XR-Collector-0.1.0-official-win-x64-setup.exe',
    'XR-Collector-0.1.0-official-win32-x64-update.yml',
  ]);
  expect(manifest.artifacts[0].sha256).toBe(createHash('sha256').update('installer').digest('hex'));
  expect(await readFile(result.updateMetadata, 'utf8')).toContain('XR-Collector-0.1.0-official-win-x64-setup.exe');
});
