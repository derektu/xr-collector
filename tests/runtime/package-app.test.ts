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
import { assertPackagedProductMetadata, capture as captureCommandOutput, packageApplication, packageChildEnvironment, parsePackageArguments, readPackagingGitIdentity, readPackagingProcessIdentity, signedBuilderIdentityOverride, stageBuildInfoSidecar, validationBuilderArguments, verifyMacBundleSignature, verifyPackagedApplication, verifySignedMacDmgContents, verifySignedMacZip, withPackageCheckoutLock, writeArtifactHandoff } from '../../scripts/package-app.mjs';

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

it('accepts only the two delivery targets', () => {
  expect(parsePackageArguments(['--target', 'darwin-arm64'])).toEqual({ target: 'darwin-arm64' });
  expect(() => parsePackageArguments(['--target', 'darwin-x64'])).toThrow(/Unsupported packaging target/u);
  expect(() => parsePackageArguments(['--target', 'win32-x64', '--verbose'])).toThrow(/Unknown packaging argument --verbose/u);
});

it('requires an explicit complete Developer ID mode only for Mac packaging', () => {
  expect(parsePackageArguments(['--target', 'darwin-arm64', '--mac-signing-mode', 'developer-id-notarized',
    '--mac-signing-env', '/protected/.env', '--mac-signing-root', '/protected'])).toMatchObject({
    macSigningMode: 'developer-id-notarized', macSigningEnv: '/protected/.env', macSigningRoot: '/protected',
  });
  expect(() => parsePackageArguments(['--target', 'darwin-arm64', '--mac-signing-mode', 'developer-id-notarized']))
    .toThrow(/requires Mac target plus/u);
  expect(() => parsePackageArguments(['--target', 'win32-x64', '--mac-signing-mode', 'developer-id-notarized',
    '--mac-signing-env', '/protected/.env', '--mac-signing-root', '/protected'])).toThrow(/requires Mac target plus/u);
});

it('gives the signed verifier a runner that captures output and carries both checkout and signing-session trackers', async () => {
  const outerTracker = { name: 'checkout' };
  const sessionTracker = { name: 'signing-session' };
  const processTrackers = [outerTracker, sessionTracker];
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  let verifierOutput: unknown;
  const previousNpmExecPath = process.env.npm_execpath;
  process.env.npm_execpath = process.execPath;
  try {
    const stopped = new Error('stop after signed verifier wiring proof');
    await expect(packageApplication({
      target: 'darwin-arm64', macSigningMode: 'developer-id-notarized',
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
      assertBuildEnvironment: async () => [],
      probePhysicalHost: async () => ({ platform: 'darwin', processArch: 'arm64', hostArch: 'arm64', emulated: false }),
      stageBuildInfoSidecar: async () => undefined,
      clearPreviousArtifactSet: async () => undefined,
      // Like the real runner, the build runner streams output and resolves without it.
      run: async (command: string, args: string[], options: any) => { calls.push({ command, args, options }); },
      runCaptured: async (command: string, args: string[], options: any) => {
        calls.push({ command, args, options });
        return { stdout: '', stderr: 'Authority=Developer ID Application' };
      },
      verifyDeveloperIdApplication: async (_app: string, _team: string, dependencies: any) => {
        verifierOutput = await dependencies.run('fixture-signed-verifier', []);
        throw stopped;
      },
      timingReportDirectory: await temporaryRoot('xr-package-timings-'),
      timingLog: () => undefined,
    } as any)).rejects.toBe(stopped);
    const builder = calls.find((call) => call.args.some((argument) => argument.endsWith('electron-builder/cli.js')) && call.args.includes('--dir'));
    const verifier = calls.find((call) => call.command === 'fixture-signed-verifier');
    expect(builder?.options.processTrackers).toEqual(processTrackers);
    expect(verifier?.options.processTrackers).toEqual(processTrackers);
    expect(verifierOutput).toEqual({ stdout: '', stderr: 'Authority=Developer ID Application' });
  } finally {
    if (previousNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpmExecPath;
  }
});

function signedPackageDependencies(outputDir: string, overrides: Record<string, unknown>) {
  return {
    outputDir,
    withPackageCheckoutLock: async (_lock: string, work: any) => work({ signal: new AbortController().signal, processTracker: {} }),
    readPackagingGitIdentity: async () => ({ commit: 'a'.repeat(40) }),
    loadMacSigningConfiguration: async () => ({ teamId: 'ABCDE12345', notary: { teamId: 'ABCDE12345' } }),
    withTemporarySigningKeychain: async (_configuration: any, work: any, dependencies: any) => work({
      keychain: '/tmp/signing.keychain-db', identity: { sha1: 'A'.repeat(40), name: 'Developer ID Application: Example (ABCDE12345)' },
      signal: dependencies.signal, processTracker: {}, processTrackers: [],
    }),
    assertBuildEnvironment: async () => [],
      probePhysicalHost: async () => ({ platform: 'darwin', processArch: 'arm64', hostArch: 'arm64', emulated: false }),
    stageBuildInfoSidecar: async () => undefined,
    clearPreviousArtifactSet: async () => undefined,
    timingReportDirectory: outputDir,
    timingLog: () => undefined,
    log: () => undefined,
    ...overrides,
  };
}

async function withNpmExecPath<T>(work: () => Promise<T>): Promise<T> {
  const previousNpmExecPath = process.env.npm_execpath;
  process.env.npm_execpath = process.execPath;
  try { return await work(); } finally {
    if (previousNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpmExecPath;
  }
}

it('notarizes the App once, gates the stapled App, builds the DMG and ZIP from it, notarizes the DMG once and checks each artifact once', async () => {
  const outputDir = await temporaryRoot('xr-signed-flow-');
  const stapledApp = { bytes: 16, sha256: 'b'.repeat(64) };
  const appReceipt = { kind: 'app', submissionId: '12345678-1234-1234-1234-123456789abc', status: 'Accepted', issues: 0, stapled: stapledApp, stapleValidated: true };
  const dmgReceipt = { kind: 'dmg', submissionId: '87654321-4321-4321-4321-cba987654321', status: 'Accepted', issues: 0, stapled: { bytes: 3, sha256: 'c'.repeat(64) }, stapleValidated: true };
  const events: string[] = [];
  const logged: string[] = [];
  const finished = new Error('stop after the final ZIP check');
  await withNpmExecPath(() => expect(packageApplication({
    target: 'darwin-arm64', macSigningMode: 'developer-id-notarized',
    macSigningEnv: '/protected/.env', macSigningRoot: '/protected',
  }, signedPackageDependencies(outputDir, {
    run: async (_command: string, args: string[]) => {
      if (!args.some((argument) => argument.endsWith('electron-builder/cli.js'))) return;
      const targets = args.includes('--prepackaged') ? args.slice(args.indexOf('--mac') + 1, args.indexOf('--prepackaged')) : [];
      events.push(`build ${args.includes('--dir') ? 'App' : targets.join('+')}`);
      if (targets.includes('dmg')) await writeFile(path.join(outputDir, 'XR-Collector-0.1.0-mac-arm64.dmg'), 'dmg');
      if (targets.includes('zip')) await writeFile(path.join(outputDir, 'XR-Collector-0.1.0-mac-arm64.zip'), 'zip');
    },
    verifyDeveloperIdApplication: async (app: string) => { events.push(`verify App Developer ID ${path.relative(outputDir, app)}`); },
    notarizeAndStaple: async ({ kind, artifactPath }: any) => {
      events.push(`notarize ${kind} ${path.relative(outputDir, artifactPath)}`);
      return kind === 'app' ? appReceipt : dmgReceipt;
    },
    validateNotarizedApplication: async (_app: string, options: any) => { events.push(`Gatekeeper App${options.stapleValidated ? ' (staple already validated)' : ''}`); },
    verifyDeveloperIdDiskImage: async (_dmg: string, _team: string, options: any) => {
      events.push(`verify DMG Developer ID and Gatekeeper${options.stapleValidated ? ' (staple already validated)' : ''}`);
      return { signature: {}, gatekeeper: { source: 'Notarized Developer ID', output: 'XR.dmg: accepted\nsource=Notarized Developer ID' } };
    },
    verifySignedMacDmgContents: async (_dmg: string, _product: string, _team: string, options: any) => {
      expect(options).toMatchObject({ expectedAppIdentity: stapledApp, verifyDeveloperId: false });
      events.push('verify DMG contents');
      return { appIdentity: stapledApp };
    },
    verifySignedMacZip: async (zip: string, _product: string, _team: string, options: any) => {
      expect(options).toMatchObject({ expectedAppIdentity: stapledApp, verifyDeveloperId: false });
      expect((await stat(zip)).isFile()).toBe(true);
      events.push('verify ZIP contents');
      throw finished;
    },
    log: (line: string) => { logged.push(line); },
  }) as any)).rejects.toBe(finished));
  expect(events).toEqual([
    'build App',
    'verify App Developer ID mac-arm64/XR Collector.app',
    'notarize app mac-arm64/XR Collector.app',
    'verify App Developer ID mac-arm64/XR Collector.app',
    'Gatekeeper App (staple already validated)',
    'build dmg+zip',
    'notarize dmg XR-Collector-0.1.0-mac-arm64.dmg',
    'verify DMG Developer ID and Gatekeeper (staple already validated)',
    'verify DMG contents',
    'verify ZIP contents',
  ]);
  expect(logged).toEqual(['DMG Gatekeeper assessment (spctl --type open): source=Notarized Developer ID']);
});

it('builds no installer when the stapled App fails its Gatekeeper gate', async () => {
  const outputDir = await temporaryRoot('xr-signed-flow-');
  const built: string[] = [];
  await withNpmExecPath(() => expect(packageApplication({
    target: 'darwin-arm64', macSigningMode: 'developer-id-notarized',
    macSigningEnv: '/protected/.env', macSigningRoot: '/protected',
  }, signedPackageDependencies(outputDir, {
    run: async (_command: string, args: string[]) => {
      if (args.some((argument) => argument.endsWith('electron-builder/cli.js'))) built.push(args.includes('--dir') ? 'App' : 'installers');
    },
    verifyDeveloperIdApplication: async () => undefined,
    notarizeAndStaple: async () => ({ stapled: { bytes: 16, sha256: 'b'.repeat(64) }, stapleValidated: true }),
    validateNotarizedApplication: async () => { throw new Error('syspolicy_check distribution failed'); },
  }) as any)).rejects.toThrow(/syspolicy_check distribution failed/u));
  expect(built).toEqual(['App']);
});

it('writes the package timing table and JSON up to a failing electron-builder run, including its hook events', async () => {
  const reportDirectory = await temporaryRoot('xr-package-timings-');
  const previousNpmExecPath = process.env.npm_execpath;
  process.env.npm_execpath = process.execPath;
  const builderCalls: Array<{ args: string[]; environment: Record<string, string> }> = [];
  const runtimeCalls: string[][] = [];
  const output: string[] = [];
  const failure = new Error('electron-builder exited with status 1');
  try {
    await expect(packageApplication({ target: 'darwin-arm64' }, {
      withPackageCheckoutLock: async (_lock: string, work: any) => work({ signal: new AbortController().signal, processTracker: {} }),
      readPackagingGitIdentity: async () => ({ commit: 'c'.repeat(40) }),
      assertBuildEnvironment: async () => [],
      probePhysicalHost: async () => ({ platform: 'darwin', processArch: 'arm64', hostArch: 'arm64', emulated: false }),
      stageBuildInfoSidecar: async () => undefined,
      clearPreviousArtifactSet: async () => undefined,
      run: async (_command: string, args: string[], options: any) => {
        if (args[0]?.endsWith('prepare-runtime.mjs')) runtimeCalls.push(args);
        if (!args.some((argument) => argument.endsWith('electron-builder/cli.js'))) return;
        builderCalls.push({ args, environment: options.environment });
        const events = options.environment.XR_PACKAGE_TIMINGS_FILE;
        const now = Date.now();
        await writeFile(events, [
          { event: 'mark', name: 'beforePack', at: now + 1 },
          { event: 'mark', name: 'afterPack:start', at: now + 10 },
          { event: 'mark', name: 'afterPack:end', at: now + 10 },
          { event: 'artifact:start', file: '/release/XR-Collector-0.1.0-mac-arm64.zip', at: now + 20 },
          { event: 'artifact:end', file: '/release/XR-Collector-0.1.0-mac-arm64.zip', at: now + 35, bytes: 9 },
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

  expect(runtimeCalls).toEqual([[path.resolve('scripts/prepare-runtime.mjs'), 'mac', '--cache-only']]);
  expect(builderCalls).toHaveLength(1);
  const hookArgs = builderCalls[0]!.args.filter((argument) => argument.startsWith('--config.') && argument.endsWith('package-timing-hook.mjs'));
  expect(hookArgs).toEqual(['beforePack', 'afterPack', 'afterSign', 'artifactBuildStarted', 'artifactBuildCompleted']
    .map((hook) => `--config.${hook}=./scripts/package-timing-hook.mjs`));
  expect(builderCalls[0]!.environment.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
  const report = JSON.parse(await readFile(path.join(reportDirectory, 'XR-Collector-0.1.0-darwin-arm64-timings.json'), 'utf8'));
  expect(report).toMatchObject({
    kind: 'xr-collector-stage-timings', command: 'package', status: 'failed', error: failure.message,
    version: '0.1.0', commit: 'c'.repeat(40), target: 'darwin-arm64', signingPolicy: 'ad-hoc',
  });
  const builderStage = 'electron-builder --mac (pack, ad-hoc codesign, ZIP, DMG)';
  expect(report.stages.map((stage: any) => [stage.name, stage.status])).toEqual([
    ['read commit and require a clean checkout', 'ok'],
    ['check build environment', 'ok'],
    ['runtime: install yt-dlp/Deno and Meilisearch from cache', 'ok'],
    ['build: npm run build', 'ok'],
    ['build: write BuildInfo', 'ok'],
    ['build: stage BuildInfo sidecar', 'ok'],
    ['build: macOS update helper', 'ok'],
    ['clear previous artifacts', 'ok'],
    [builderStage, 'failed'],
    [`${builderStage} / pack App (beforePack to afterPack)`, 'ok'],
    [`${builderStage} / artifact XR-Collector-0.1.0-mac-arm64.zip`, 'ok'],
  ]);
  expect(report.stages.at(-1)).toMatchObject({ ms: 15, bytes: 9, depth: 1 });
  expect(output[0]).toMatch(/Stage timings: package failed/u);
  expect(output[0]).toContain(`${builderStage}`);
  expect(output[1]).toContain('XR-Collector-0.1.0-darwin-arm64-timings.json');
});

it('requires an explicit isolated identity for validation version overrides', () => {
  const args = ['--target', 'darwin-arm64', '--validation-version', '0.1.1',
    '--validation-app-id', 'com.xrcollector.verify36', '--validation-product-name', 'XR Update Verify 36'];
  expect(() => parsePackageArguments(args)).toThrow(/XR_COLLECTOR_VALIDATION_BUILD/u);
  process.env.XR_COLLECTOR_VALIDATION_BUILD = '1';
  try {
    expect(parsePackageArguments(args)).toMatchObject({ validationVersion: '0.1.1', validationAppId: 'com.xrcollector.verify36', validationUpdateRepository: 'derektu/xr-collector' });
    expect(parsePackageArguments([...args, '--validation-update-repository', 'derektu/xr-collector-test'])).toMatchObject({ validationUpdateRepository: 'derektu/xr-collector-test' });
    expect(() => parsePackageArguments([...args, '--validation-update-repository', 'https://github.com/derektu/xr-collector-test'])).toThrow(/repository/u);
    expect(() => parsePackageArguments(['--target', 'darwin-arm64', '--validation-update-repository', 'derektu/xr-collector-test'])).toThrow(/all validation options/u);
  }
  finally { delete process.env.XR_COLLECTOR_VALIDATION_BUILD; }
});

it('bakes the validation product name into package metadata so Electron derives an isolated userData folder', () => {
  const options = { validationVersion: '0.1.1', validationAppId: 'com.xrcollector.verify36', validationProductName: 'XR Update Verify Mac' };
  expect(validationBuilderArguments(options)).toEqual([
    '--config.extraMetadata.version=0.1.1',
    '--config.extraMetadata.productName=XR Update Verify Mac',
    '--config.extraMetadata.xrCollectorAppId=com.xrcollector.verify36',
    '--config.extraMetadata.xrCollectorUpdateRepository=derektu/xr-collector',
    '--config.appId=com.xrcollector.verify36',
    '--config.productName=XR Update Verify Mac',
  ]);
  expect(() => assertPackagedProductMetadata({ name: 'xr-collector' }, options.validationProductName, options.validationAppId)).toThrow(/productName/u);
  expect(() => assertPackagedProductMetadata({ name: 'xr-collector', productName: options.validationProductName,
    xrCollectorAppId: options.validationAppId, xrCollectorUpdateRepository: 'derektu/xr-collector' }, options.validationProductName, options.validationAppId)).not.toThrow();
  expect(() => assertPackagedProductMetadata({ name: 'xr-collector', xrCollectorUpdateRepository: 'derektu/xr-collector-test' }, 'XR Collector')).toThrow(/Production package/u);
  expect(validationBuilderArguments({})).toEqual([]);
});

it('accepts a public update-test identity within the existing validation namespace', () => {
  process.env.XR_COLLECTOR_VALIDATION_BUILD = '1';
  try {
    const options = parsePackageArguments(['--target', 'darwin-arm64',
      '--validation-version', '0.1.0', '--validation-app-id', 'com.xrcollector.verify.public',
      '--validation-product-name', 'XR Update Verify Public', '--validation-update-repository', 'derektu/xr-collector-test']);
    expect(validationBuilderArguments(options)).toContain('--config.extraMetadata.xrCollectorUpdateRepository=derektu/xr-collector-test');
  } finally { delete process.env.XR_COLLECTOR_VALIDATION_BUILD; }
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

it('opens both final Mac containers and checks that their only App is the stapled App', async () => {
  const stapledApp = { bytes: 16, sha256: 'b'.repeat(64) };
  const zipRun = async (_command: string, args: string[]) => { await mkdir(path.join(args[3]!, 'XR Collector.app')); };
  const dmgRun = (calls: string[]) => async (_command: string, args: string[]) => {
    if (args[0] === 'attach') { await mkdir(path.join(args[4]!, 'XR Collector.app')); calls.push('attach'); }
    if (args[0] === 'detach') calls.push('detach');
  };
  const gates = (calls: string[], appIdentity = stapledApp, notarized = true) => ({
    describeArtifact: async () => { calls.push('hash'); return appIdentity; },
    verifyDeveloperIdApplication: async (_app: string, team: string) => { calls.push(`identity:${team}`); },
    validateNotarizedApplication: async () => {
      calls.push('stapler+syspolicy+spctl');
      if (!notarized) throw new Error('stapler validate: XR Collector.app does not have a ticket stapled to it');
    },
  });

  // The publisher passes no expected identity and runs the full Developer ID gate.
  const zipCalls: string[] = [];
  await expect(verifySignedMacZip('/candidate/update.zip', 'XR Collector', 'ABCDE12345', { run: zipRun, ...gates(zipCalls) }))
    .resolves.toEqual({ appIdentity: stapledApp });
  expect(zipCalls).toEqual(['hash', 'identity:ABCDE12345', 'stapler+syspolicy+spctl']);

  // The packager compares with the stapled App, whose Developer ID gate already passed.
  const dmgCalls: string[] = [];
  await verifySignedMacDmgContents('/candidate/installer.dmg', 'XR Collector', 'ABCDE12345', {
    run: dmgRun(dmgCalls), ...gates(dmgCalls), expectedAppIdentity: stapledApp, verifyDeveloperId: false,
  });
  expect(dmgCalls).toEqual(['attach', 'hash', 'stapler+syspolicy+spctl', 'detach']);

  const differentApp = { bytes: 10, sha256: 'a'.repeat(64) };
  const differentCalls: string[] = [];
  await expect(verifySignedMacDmgContents('/candidate/installer.dmg', 'XR Collector', 'ABCDE12345', {
    run: dmgRun(differentCalls), ...gates(differentCalls, differentApp), expectedAppIdentity: stapledApp, verifyDeveloperId: false,
  })).rejects.toThrow(/App inside the DMG differs from the stapled App/u);
  expect(differentCalls).toEqual(['attach', 'hash', 'detach']);
  await expect(verifySignedMacZip('/candidate/update.zip', 'XR Collector', 'ABCDE12345', {
    run: zipRun, ...gates([], differentApp), expectedAppIdentity: stapledApp, verifyDeveloperId: false,
  })).rejects.toThrow(/App inside the ZIP differs from the stapled App/u);

  await expect(verifySignedMacDmgContents('/candidate/installer.dmg', 'XR Collector', 'ABCDE12345', {
    run: dmgRun([]), ...gates([], stapledApp, false), expectedAppIdentity: stapledApp, verifyDeveloperId: false,
  })).rejects.toThrow(/does not have a ticket stapled/u);
});

it('resolves each Windows package resource once with an exact app-local CRT filter', async () => {
  for (const configFile of ['electron-builder.yml']) {
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
  for (const configFile of ['electron-builder.signed.yml']) {
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
  const buildInfo = { schemaVersion: 1, kind: 'packaged', version: '0.1.0', builtAt: '2026-10-25T00:00:00.000Z', commit, buildId: 'id', target: 'darwin-arm64', sourceDirty: false };
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
    schemaVersion: 1, releaseRepository: 'https://github.com/meilisearch/meilisearch', releaseTag: 'v1.53.2',
    releaseAsset: 'meilisearch-macos-apple-silicon', releaseUrl: 'https://example.test/meilisearch-macos-apple-silicon', target: 'darwin-arm64',
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
    { outputDir, commit, version: '0.1.0', target: 'darwin-arm64' },
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
  const windowsManifest = { ...meiliManifest, target: 'win32-x64' };
  await writeFile(path.join(resources, 'bin/meilisearch-build.json'), JSON.stringify(windowsManifest));
  await expect(verify(windowsManifest)).rejects.toThrow(/package target/u);
  await writeFile(path.join(resources, 'bin/meilisearch-build.json'), JSON.stringify(meiliManifest));
  await expect(verify({ ...meiliManifest, releaseTag: 'v1.53.1' })).rejects.toThrow(/prepared producer identity/u);
  await writeFile(path.join(resources, 'bin/vcruntime140.dll'), 'crt');
  await expect(verify()).rejects.toThrow(/Only the Windows package contains vcruntime140\.dll/u);
  await rm(path.join(resources, 'bin/vcruntime140.dll'));
  await writeFile(path.join(resources, 'bin/meilisearch-build.json'), JSON.stringify(meiliManifest));
  await writeFile(path.join(resources, 'skills/xr-collector-agent/SKILL.md'), 'stale skill');
  await expect(verify()).rejects.toThrow(/Agent Skill/u);
  await writeFile(path.join(resources, 'skills/xr-collector-agent/SKILL.md'), 'skill');
  await writeFile(path.join(resources, 'search/coct-main.txt'), 'wrong lexicon');
  await expect(verify()).rejects.toThrow(/search lexicon bytes/u);
  await writeFile(path.join(resources, 'search/coct-main.txt'), lexiconBytes);
  await writeFile(path.join(resources, 'bin/meilisearch'), 'wrong pair');
  await expect(verify()).rejects.toThrow(/Meilisearch bytes/u);

  await writeFile(path.join(resources, 'bin/meilisearch'), meiliBinary);
  const validationProductName = 'XR Update Verify Public';
  const validationAppId = 'com.xrcollector.verify.public';
  await writeFile(path.join(asarSource, 'package.json'), JSON.stringify({ name: 'xr-collector', version: '0.1.0',
    productName: validationProductName, xrCollectorAppId: validationAppId, xrCollectorUpdateRepository: 'derektu/xr-collector-test' }));
  await rm(path.join(resources, 'app.asar'));
  await createPackage(asarSource, path.join(resources, 'app.asar'));
  await rename(path.join(outputDir, 'mac-arm64/XR Collector.app'), path.join(outputDir, `mac-arm64/${validationProductName}.app`));
  await expect(verifyPackagedApplication({ outputDir, commit, version: '0.1.0', target: 'darwin-arm64',
    productName: validationProductName, appId: validationAppId, updateRepository: 'derektu/xr-collector-test' },
  { trustedManifest: meiliManifest, trustedLexiconManifest: lexiconManifest, sourceSkillPath: sourceSkill,
    runBinary: async () => ({ stdout: 'meilisearch 1.53.2' }), verifyMacBundle: async () => undefined }))
    .resolves.toMatchObject({ packageMetadata: { productName: validationProductName, xrCollectorUpdateRepository: 'derektu/xr-collector-test' } });
});

it('accepts a Developer ID App only when it is byte-identical to the verified stapled App', async () => {
  const outputDir = await temporaryRoot('xr-signed-readback-');
  const stapled = { bytes: 16, sha256: 'b'.repeat(64) };
  const readBack = (verifiedAppIdentity: unknown, actual = stapled) => verifyPackagedApplication({
    outputDir, commit: 'a'.repeat(40), version: '0.1.0', target: 'darwin-arm64',
    signingPolicy: 'developer-id-notarized', expectedTeamId: 'ABCDE12345', verifiedAppIdentity,
  }, {
    describeArtifact: async () => actual,
    verifyDeveloperIdApplication: async () => { throw new Error('the final ZIP already ran the Developer ID gate on these bytes'); },
  } as any);
  await expect(readBack(stapled, { bytes: 16, sha256: 'c'.repeat(64) })).rejects.toThrow(/differs from the verified stapled App/u);
  await expect(readBack(undefined)).rejects.toThrow(/differs from the verified stapled App/u);
  // Identical bytes pass the identity gate and continue to the resource read-back.
  await expect(readBack(stapled)).rejects.toThrow(/app\.asar|ENOENT|no such file/iu);
});

it('writes the platform release index and an exact artifact inventory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-package-artifacts-'));
  roots.push(root);
  const names = ['XR-Collector-0.1.0-mac-arm64.dmg', 'XR-Collector-0.1.0-mac-arm64.dmg.blockmap', 'XR-Collector-0.1.0-mac-arm64.zip', 'XR-Collector-0.1.0-mac-arm64.zip.blockmap'];
  await Promise.all(names.map((name) => writeFile(path.join(root, name), name)));
  const buildInfo = { schemaVersion: 1, kind: 'packaged', version: '0.1.0', builtAt: '2026-10-25T00:00:00.000Z', commit: 'a'.repeat(40), buildId: 'build', target: 'darwin-arm64', sourceDirty: false };
  const result = await writeArtifactHandoff({
    outputDir: root, target: 'darwin-arm64', version: '0.1.0', commit: 'a'.repeat(40), buildInfo,
    artifacts: names.map((name) => path.join(root, name)), host: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64', emulated: false },
    toolVersions: { node: 'v22' }, signing: { status: 'ad-hoc' },
  });
  const digest = (name: string) => createHash('sha256').update(name).digest('hex');
  expect(path.basename(result.releaseIndex)).toBe('release-darwin-arm64.json');
  expect(JSON.parse(await readFile(result.releaseIndex, 'utf8'))).toEqual({
    schemaVersion: 1, version: '0.1.0', commit: 'a'.repeat(40), target: 'darwin-arm64', buildInfo,
    installer: { name: names[0], bytes: Buffer.byteLength(names[0]!), sha256: digest(names[0]!) },
    update: { name: names[2], bytes: Buffer.byteLength(names[2]!), sha256: digest(names[2]!) },
  });
  expect(path.basename(result.artifactManifest)).toBe('XR-Collector-0.1.0-darwin-arm64-artifacts.json');
  const manifest = JSON.parse(await readFile(result.artifactManifest, 'utf8'));
  expect(manifest.packageIdentity).toEqual({ productName: 'XR Collector', appId: 'com.moneydj.xrcollector', updateRepository: 'derektu/xr-collector' });
  expect(manifest.artifacts.map((entry: { path: string }) => entry.path)).toEqual([...names, 'release-darwin-arm64.json']);
});

it('indexes one Windows setup as both the installer and the update', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-package-artifacts-'));
  roots.push(root);
  const installer = path.join(root, 'XR-Collector-0.1.0-win-x64-setup.exe');
  await writeFile(installer, 'installer');
  const result = await writeArtifactHandoff({
    outputDir: root, target: 'win32-x64', version: '0.1.0', commit: 'a'.repeat(40),
    buildInfo: { schemaVersion: 1, kind: 'packaged', version: '0.1.0', builtAt: '2026-10-25T00:00:00.000Z', commit: 'a'.repeat(40), buildId: 'build', target: 'win32-x64', sourceDirty: false },
    artifacts: [installer], host: { platform: 'win32', processArch: 'x64', hostArch: 'arm64', emulated: true },
    toolVersions: { node: 'v22' }, signing: { status: 'unsigned' },
  });
  const index = JSON.parse(await readFile(result.releaseIndex, 'utf8'));
  expect(path.basename(result.releaseIndex)).toBe('release-win32-x64.json');
  expect(index.installer).toEqual(index.update);
  expect(index.update).toEqual({ name: 'XR-Collector-0.1.0-win-x64-setup.exe', bytes: 9, sha256: createHash('sha256').update('installer').digest('hex') });
  expect(JSON.parse(await readFile(result.artifactManifest, 'utf8')).builderHost).toMatchObject({ hostArch: 'arm64', emulated: true });
});
