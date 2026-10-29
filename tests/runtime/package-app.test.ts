import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { createPackage } from '@electron/asar';
import { getConfig } from 'app-builder-lib/out/util/config/config.js';
import { assertHostTarget, assertPackagedProductMetadata, capture as captureCommandOutput, packageApplication, packageChildEnvironment, parsePackageArguments, readPackagingGitIdentity, readPackagingProcessIdentity, signedBuilderIdentityOverride, stageBuildInfoSidecar, validationBuilderArguments, verifyMacBundleSignature, verifyPackagedApplication, verifySignedMacDmgContents, verifySignedMacZip, withPackageCheckoutLock, writeArtifactHandoff } from '../../scripts/package-app.mjs';

const exec = promisify(execFile);

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporaryRoot(prefix: string) { const root = await mkdtemp(path.join(tmpdir(), prefix)); roots.push(root); return root; }

it('passes electron-builder the verified certificate hash instead of a prefixed Developer ID name', () => {
  const sha1 = 'A'.repeat(40);
  expect(signedBuilderIdentityOverride({ sha1, name: 'Developer ID Application: Example Company (ABCDE12345)' }))
    .toBe(`--config.mac.identity=${sha1}`);
  expect(() => signedBuilderIdentityOverride({ sha1: 'Developer ID Application: Example', name: 'ignored' })).toThrow(/certificate SHA-1/u);
});

it('accepts only the two delivery targets and two explicit variants', () => {
  expect(parsePackageArguments(['--target', 'darwin-arm64', '--variant', 'chinese'])).toEqual({ target: 'darwin-arm64', variant: 'chinese' });
  expect(() => parsePackageArguments(['--target', 'darwin-x64', '--variant', 'official'])).toThrow(/Unsupported packaging target/u);
  expect(() => parsePackageArguments(['--target', 'win32-x64', '--variant', 'other'])).toThrow(/Unsupported packaging variant/u);
});

it('requires an explicit complete Developer ID mode only for Mac packaging', () => {
  expect(parsePackageArguments(['--target', 'darwin-arm64', '--variant', 'chinese', '--mac-signing-mode', 'developer-id-notarized',
    '--mac-signing-env', '/protected/.env', '--mac-signing-root', '/protected'])).toMatchObject({
    macSigningMode: 'developer-id-notarized', macSigningEnv: '/protected/.env', macSigningRoot: '/protected',
  });
  expect(() => parsePackageArguments(['--target', 'darwin-arm64', '--variant', 'chinese', '--mac-signing-mode', 'developer-id-notarized']))
    .toThrow(/requires Mac target plus/u);
  expect(() => parsePackageArguments(['--target', 'win32-x64', '--variant', 'chinese', '--mac-signing-mode', 'developer-id-notarized',
    '--mac-signing-env', '/protected/.env', '--mac-signing-root', '/protected'])).toThrow(/requires Mac target plus/u);
});

it('passes both checkout and signing-session trackers to the real signed package builder and verifier path', async () => {
  const outerTracker = { name: 'checkout' };
  const sessionTracker = { name: 'signing-session' };
  const processTrackers = [outerTracker, sessionTracker];
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  const previousNpmExecPath = process.env.npm_execpath;
  process.env.npm_execpath = process.execPath;
  try {
    const stopped = new Error('stop after signed verifier wiring proof');
    await expect(packageApplication({
      target: 'darwin-arm64', variant: 'chinese', macSigningMode: 'developer-id-notarized',
      macSigningEnv: '/protected/.env', macSigningRoot: '/protected',
    }, {
      withPackageCheckoutLock: async (_lock: string, work: any) => work({ signal: new AbortController().signal, processTracker: outerTracker }),
      readPackagingGitIdentity: async () => ({ commit: 'a'.repeat(40) }),
      loadMacSigningConfiguration: async () => ({
        teamId: 'ABCDE12345', notary: { teamId: 'ABCDE12345' }, certificatePath: '/protected/certificate.p12',
      }),
      withTemporarySigningKeychain: async (_configuration: any, work: any, dependencies: any) => {
        expect(dependencies.processTracker).toBe(outerTracker);
        return work({ keychain: '/tmp/signing.keychain-db', identity: {
          sha1: 'A'.repeat(40), name: 'Developer ID Application: Example (ABCDE12345)', teamId: 'ABCDE12345',
        }, signal: dependencies.signal, processTracker: sessionTracker, processTrackers });
      },
      probePhysicalHost: async () => ({ platform: 'darwin', processArch: 'arm64', hostArch: 'arm64', emulated: false }),
      stageBuildInfoSidecar: async () => undefined,
      clearPreviousArtifactSet: async () => undefined,
      run: async (command: string, args: string[], options: any) => {
        calls.push({ command, args, options });
        return { stdout: '', stderr: '' };
      },
      verifyDeveloperIdApplication: async (_app: string, _team: string, dependencies: any) => {
        await dependencies.run('fixture-signed-verifier', []);
        throw stopped;
      },
      timingReportDirectory: await temporaryRoot('xr-package-timings-'),
      timingLog: () => undefined,
    } as any)).rejects.toBe(stopped);
    const builder = calls.find((call) => call.args.some((argument) => argument.endsWith('electron-builder/cli.js')) && call.args.includes('--dir'));
    const verifier = calls.find((call) => call.command === 'fixture-signed-verifier');
    expect(builder?.options.processTrackers).toEqual(processTrackers);
    expect(verifier?.options.processTrackers).toEqual(processTrackers);
  } finally {
    if (previousNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpmExecPath;
  }
});

it('writes the package timing table and JSON up to a failing electron-builder run, including its hook events', async () => {
  const reportDirectory = await temporaryRoot('xr-package-timings-');
  const previousNpmExecPath = process.env.npm_execpath;
  process.env.npm_execpath = process.execPath;
  const builderCalls: Array<{ args: string[]; environment: Record<string, string> }> = [];
  const output: string[] = [];
  const failure = new Error('electron-builder exited with status 1');
  try {
    await expect(packageApplication({ target: 'darwin-arm64', variant: 'official' }, {
      withPackageCheckoutLock: async (_lock: string, work: any) => work({ signal: new AbortController().signal, processTracker: {} }),
      readPackagingGitIdentity: async () => ({ commit: 'c'.repeat(40) }),
      probePhysicalHost: async () => ({ platform: 'darwin', processArch: 'arm64', hostArch: 'arm64', emulated: false }),
      stageBuildInfoSidecar: async () => undefined,
      clearPreviousArtifactSet: async () => undefined,
      run: async (_command: string, args: string[], options: any) => {
        if (!args.some((argument) => argument.endsWith('electron-builder/cli.js'))) return;
        builderCalls.push({ args, environment: options.environment });
        const events = options.environment.XR_PACKAGE_TIMINGS_FILE;
        const now = Date.now();
        await writeFile(events, [
          { event: 'mark', name: 'beforePack', at: now + 1 },
          { event: 'mark', name: 'afterPack:start', at: now + 10 },
          { event: 'mark', name: 'afterPack:end', at: now + 10 },
          { event: 'artifact:start', file: '/release/official/XR-Collector-0.1.0-official-mac-arm64.zip', at: now + 20 },
          { event: 'artifact:end', file: '/release/official/XR-Collector-0.1.0-official-mac-arm64.zip', at: now + 35, bytes: 9 },
        ].map((event) => `${JSON.stringify(event)}\n`).join(''));
        throw failure;
      },
      timingReportDirectory: reportDirectory,
      timingLog: (text: string) => output.push(text),
    } as any)).rejects.toBe(failure);
  } finally {
    if (previousNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpmExecPath;
  }

  expect(builderCalls).toHaveLength(1);
  const hookArgs = builderCalls[0]!.args.filter((argument) => argument.startsWith('--config.') && argument.endsWith('package-timing-hook.mjs'));
  expect(hookArgs).toEqual(['beforePack', 'afterPack', 'afterSign', 'artifactBuildStarted', 'artifactBuildCompleted']
    .map((hook) => `--config.${hook}=./scripts/package-timing-hook.mjs`));
  expect(builderCalls[0]!.environment.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
  const report = JSON.parse(await readFile(path.join(reportDirectory, 'XR-Collector-0.1.0-official-darwin-arm64-timings.json'), 'utf8'));
  expect(report).toMatchObject({
    kind: 'xr-collector-stage-timings', command: 'package', status: 'failed', error: failure.message,
    version: '0.1.0', commit: 'c'.repeat(40), target: 'darwin-arm64', variant: 'official', signingPolicy: 'ad-hoc',
  });
  const builderStage = 'electron-builder --mac (pack, ad-hoc codesign, ZIP, DMG)';
  expect(report.stages.map((stage: any) => [stage.name, stage.status])).toEqual([
    ['read commit and require a clean checkout', 'ok'],
    ['check host target', 'ok'],
    ['runtime: download yt-dlp/Deno', 'ok'],
    ['runtime: prepare Meilisearch official', 'ok'],
    ['build: npm run build', 'ok'],
    ['build: write BuildInfo', 'ok'],
    ['build: stage BuildInfo sidecar', 'ok'],
    ['build: macOS update helper', 'ok'],
    ['clear previous artifacts', 'ok'],
    [builderStage, 'failed'],
    [`${builderStage} / pack App (beforePack to afterPack)`, 'ok'],
    [`${builderStage} / artifact XR-Collector-0.1.0-official-mac-arm64.zip`, 'ok'],
  ]);
  expect(report.stages.at(-1)).toMatchObject({ ms: 15, bytes: 9, depth: 1 });
  expect(output[0]).toMatch(/Stage timings: package failed/u);
  expect(output[0]).toContain(`${builderStage}`);
  expect(output[1]).toContain('XR-Collector-0.1.0-official-darwin-arm64-timings.json');
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

it('keeps stdout written after the direct child exits but before its pipe closes', async () => {
  const descendant = `setTimeout(() => process.stdout.write('complete output'), 50)`;
  const directChild = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.unref();
  `;
  await expect(captureCommandOutput(process.execPath, ['-e', directChild])).resolves.toBe('complete output');
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

it('opens both final Mac containers and rechecks their only App with Developer ID and notarization gates', async () => {
  const zipCalls: string[] = [];
  await verifySignedMacZip('/candidate/update.zip', 'XR Collector', 'ABCDE12345', {
    run: async (_command: string, args: string[]) => { await mkdir(path.join(args[3]!, 'XR Collector.app')); },
    verifyDeveloperIdApplication: async (_app: string, team: string) => { zipCalls.push(`identity:${team}`); },
    validateNotarizedArtifact: async (_app: string, kind: string) => { zipCalls.push(`notary:${kind}`); },
  });
  expect(zipCalls).toEqual(['identity:ABCDE12345', 'notary:app']);

  const dmgCalls: string[] = [];
  await verifySignedMacDmgContents('/candidate/installer.dmg', 'XR Collector', 'ABCDE12345', {
    run: async (_command: string, args: string[]) => {
      if (args[0] === 'attach') { await mkdir(path.join(args[4]!, 'XR Collector.app')); dmgCalls.push('attach'); }
      if (args[0] === 'detach') dmgCalls.push('detach');
    },
    verifyDeveloperIdApplication: async (_app: string, team: string) => { dmgCalls.push(`identity:${team}`); },
    validateNotarizedArtifact: async (_app: string, kind: string) => { dmgCalls.push(`notary:${kind}`); },
  });
  expect(dmgCalls).toEqual(['attach', 'identity:ABCDE12345', 'notary:app', 'detach']);
});

it('resolves each Windows package resource once with an exact app-local CRT filter', async () => {
  for (const configFile of ['electron-builder.official.yml', 'electron-builder.yml']) {
    const config = await getConfig(process.cwd(), path.resolve(configFile), null);
    expect(config.mac, configFile).toMatchObject({ identity: '-', hardenedRuntime: false });
    expect(config.mac?.signIgnore, configFile).toEqual(['/Contents/Resources/bin(?:/|$)']);
    const signIgnore = (config.mac?.signIgnore ?? []).map((pattern) => new RegExp(pattern));
    const macApp = '/private/tmp/XR Collector.app';
    for (const resource of config.mac?.extraResources ?? []) {
      if (typeof resource === 'string' || !resource.to?.startsWith('bin/')) continue;
      expect(signIgnore.some((pattern) => pattern.test(path.join(macApp, 'Contents/Resources', resource.to))), `${configFile}: ${resource.to}`).toBe(true);
    }
    for (const runtimeCode of [
      'Contents/Resources/bin/meilisearch',
      'Contents/Resources/bin/deno',
      'Contents/Resources/bin/xr-mac-update-helper',
      'Contents/Resources/bin/yt-dlp/_internal/Python.framework/Python',
    ]) expect(signIgnore.some((pattern) => pattern.test(path.join(macApp, runtimeCode))), `${configFile}: ${runtimeCode}`).toBe(true);
    for (const signedCode of [
      path.join(macApp, 'Contents/MacOS/XR Collector'),
      path.join(macApp, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'),
      path.join(macApp, 'Contents/Resources/bin-adjacent/tool'),
    ]) expect(signIgnore.some((pattern) => pattern.test(signedCode)), `${configFile}: ${signedCode}`).toBe(false);
    const resources = config.win?.extraResources ?? [];
    const keys = resources.map((entry) => typeof entry === 'string' ? entry : `${entry.from}:${entry.to}`);
    expect(new Set(keys).size, configFile).toBe(keys.length);
    const runtime = resources.find((entry) => typeof entry !== 'string' && entry.from === 'resources/bin/win');
    expect(runtime, configFile).toMatchObject({ to: 'bin' });
    if (typeof runtime === 'string' || runtime === undefined) throw new Error(`${configFile} lacks its Windows runtime resource.`);
    expect(runtime.filter, configFile).toContain('vcruntime140.dll');
    expect(runtime.filter, configFile).not.toContain('*.dll');
    expect(resources, configFile).toContainEqual({ from: 'resources/search', to: 'search' });
    for (const resources of [config.mac?.extraResources ?? [], config.win?.extraResources ?? []]) {
      expect(resources).toContainEqual(expect.objectContaining({ from: '.local/package-resources/build-info.json', to: 'build-info.json' }));
      expect(resources).not.toContainEqual(expect.objectContaining({ from: 'dist/node/build-info.json' }));
    }
  }
});

it('inherits the runtime resources but switches signed Mac packages to hardened, explicit hook ownership', async () => {
  for (const configFile of ['electron-builder.signed.yml', 'electron-builder.official.signed.yml']) {
    const config = await getConfig(process.cwd(), path.resolve(configFile), null);
    expect(config, configFile).toMatchObject({ forceCodeSigning: true, afterPack: './scripts/mac-signing-hook.mjs' });
    expect(config.mac, configFile).toMatchObject({
      identity: null, hardenedRuntime: true, notarize: false, strictVerify: true,
      entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    });
    expect(config.dmg, configFile).toMatchObject({ sign: true, writeUpdateInfo: false });
    expect(config.mac?.extraResources).toContainEqual(expect.objectContaining({ from: 'resources/bin/mac/meilisearch', to: 'bin/meilisearch' }));
  }
  expect(await readFile('build/entitlements.mac.plist', 'utf8')).toContain('com.apple.security.cs.allow-jit');
  expect(await readFile('build/entitlements.mac.plist', 'utf8')).not.toMatch(/get-task-allow|allow-unsigned-executable-memory|disable-library-validation/u);
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

it('reclaims only a dead packaging owner and removes its lock on terminal signals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-package-stale-lock-'));
  roots.push(root);
  const lock = path.join(root, 'package.lock');
  const uid = process.getuid?.() ?? 501;
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), JSON.stringify({ pid: 41, uid, startedAt: 'old', token: 'a1' }), { mode: 0o600 });
  const signalTarget = new EventEmitter();
  const terminated: string[] = [];
  const identities = async (pid: number) => pid === 41 ? null : { pid, uid, startedAt: 'current' };
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  const running = withPackageCheckoutLock(lock, async ({ signal }) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    announceStarted();
  }), { processIdentity: identities, signalTarget, terminateAfterSignal: (signal: string) => terminated.push(signal) });
  const interrupted = expect(running).rejects.toThrow(/SIGHUP/u);
  await started;
  signalTarget.emit('SIGHUP');
  await interrupted;
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(terminated).toEqual(['SIGHUP']);

  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-b2.json'), JSON.stringify({ pid: 42, uid, startedAt: 'live', token: 'b2' }), { mode: 0o600 });
  await expect(withPackageCheckoutLock(lock, async () => undefined, {
    processIdentity: async (pid: number) => pid === 42 ? { pid, uid, startedAt: 'live' } : { pid, uid, startedAt: 'current' },
  })).rejects.toThrow(/another whole-checkout packaging run/iu);
});

it('queries Windows packaging owners through PowerShell and fails closed when the query is unavailable', async () => {
  const calls: any[] = [];
  await expect(readPackagingProcessIdentity(4242, { platform: 'win32', capture: async (...args: any[]) => {
    calls.push(args);
    return '4242|638972345678900000|S-1-5-21-1234';
  } })).resolves.toEqual({ pid: 4242, uid: 'S-1-5-21-1234', startedAt: '638972345678900000' });
  expect(calls[0][0]).toBe('powershell.exe');
  expect(calls[0][1]).toContain('-NonInteractive');
  const script = calls[0][1].at(-1);
  expect(script).not.toContain('\\"');
  expect(script).toContain("'{0}|{1}|{2}' -f");
  expect(script).toContain('Get-CimInstance');
  expect(script).toContain('GetOwnerSid');
  expect(script).not.toContain('[Environment]::UserName');
  expect(calls[0][2].environment).toBe(process.env);

  await expect(readPackagingProcessIdentity(4242, { platform: 'win32', capture: async () => { throw new Error('powershell.exe exited with status 44'); } })).resolves.toBeNull();
  await expect(readPackagingProcessIdentity(4242, { platform: 'win32', capture: async () => { throw new Error('powershell.exe exited with status 1'); } })).rejects.toThrow(/Unable to inspect packaging process/u);
  await expect(readPackagingProcessIdentity(4242, { platform: 'win32', capture: async () => '4242||S-1-5-21-1234' })).rejects.toThrow(/malformed process identity/u);
  await expect(readPackagingProcessIdentity(4242, { platform: 'win32', capture: async () => { throw new Error('PowerShell unavailable'); } })).rejects.toThrow(/Unable to inspect packaging process/u);
  await expect(readPackagingProcessIdentity(4242, { platform: 'darwin', capture: async () => 'unexpected ps output' })).rejects.toThrow(/malformed packaging process identity/u);
  await expect(readPackagingProcessIdentity(4242, { platform: 'darwin', capture: async () => { throw new Error('ps exited with status 1'); } })).resolves.toBeNull();
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
  await mkdir(path.join(resources, 'search'), { recursive: true });
  await writeFile(path.join(resources, 'search/coct-main.txt'), '測試 1 n\n');
  const lexiconBytes = await readFile(path.join(resources, 'search/coct-main.txt'));
  const lexiconManifest = {
    schemaVersion: 1,
    output: { file: 'coct-main.txt', bytes: lexiconBytes.byteLength, sha256: createHash('sha256').update(lexiconBytes).digest('hex') },
  };
  await writeFile(path.join(resources, 'search/coct-main.json'), JSON.stringify(lexiconManifest));

  const verify = (trustedManifest: object = meiliManifest, versionOutput = 'meilisearch 1.53.2', verifyMacBundle = async () => undefined) => verifyPackagedApplication(
    { outputDir, commit, version: '0.1.0', target: 'darwin-arm64', variant: 'chinese' },
    { trustedManifest, trustedLexiconManifest: lexiconManifest, sourceSkillPath: sourceSkill, runBinary: async () => ({ stdout: versionOutput }), verifyMacBundle },
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
  await writeFile(path.join(resources, 'search/coct-main.txt'), 'wrong lexicon');
  await expect(verify()).rejects.toThrow(/search lexicon bytes/u);
  await writeFile(path.join(resources, 'search/coct-main.txt'), lexiconBytes);
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
  { trustedManifest: meiliManifest, trustedLexiconManifest: lexiconManifest, sourceSkillPath: sourceSkill,
    runBinary: async () => ({ stdout: 'meilisearch 1.53.2' }), verifyMacBundle: async () => undefined }))
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
