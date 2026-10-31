#!/usr/bin/env node
import { extractFile } from '@electron/asar';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuildEnvironment } from './build-doctor.mjs';
import { probePhysicalHost } from './physical-host.mjs';
import { TARGETS, validateExecutable } from './prepare-meilisearch.mjs';
import { verifyRuntimeDependencyInstallation } from './runtime-dependencies.mjs';
import { withOwnedDirectoryLock } from './owned-directory-lock.mjs';
import { inspectOwnedProcessTree, runOwnedProcess } from './owned-process.mjs';
import { BUILDER_TIMINGS_ENV, createStageTimer, noStageTimer, recordBuilderTimings, runWithTimingReport } from './stage-timings.mjs';
import {
  DEVELOPER_ID_POLICY, RUNTIME_SIGNING_MANIFEST, describeArtifact, loadMacSigningConfiguration, notarizeAndStaple,
  runCaptured, signedBuilderEnvironment, validateNotarizedApplication, verifyDeveloperIdApplication, verifyDeveloperIdDiskImage, verifySignedRuntimeInventory,
  withTemporarySigningKeychain,
} from './mac-signing.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionUpdateRepository = 'derektu/xr-collector';

export function parsePackageArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--target') result.target = argv[++index];
    else if (argv[index] === '--validation-version') result.validationVersion = argv[++index];
    else if (argv[index] === '--validation-app-id') result.validationAppId = argv[++index];
    else if (argv[index] === '--validation-product-name') result.validationProductName = argv[++index];
    else if (argv[index] === '--validation-update-repository') result.validationUpdateRepository = argv[++index];
    else if (argv[index] === '--mac-signing-mode') result.macSigningMode = argv[++index];
    else if (argv[index] === '--mac-signing-env') result.macSigningEnv = argv[++index];
    else if (argv[index] === '--mac-signing-root') result.macSigningRoot = argv[++index];
    else throw new Error(`Unknown packaging argument ${argv[index]}.`);
  }
  if (!['darwin-arm64', 'win32-x64'].includes(result.target)) throw new Error(`Unsupported packaging target ${result.target ?? 'missing'}; use darwin-arm64 or win32-x64.`);
  const signingOptions = [result.macSigningMode, result.macSigningEnv, result.macSigningRoot];
  if (signingOptions.some(Boolean)) {
    if (!signingOptions.every(Boolean) || result.macSigningMode !== DEVELOPER_ID_POLICY || result.target !== 'darwin-arm64') {
      throw new Error(`Developer ID signing requires Mac target plus --mac-signing-mode ${DEVELOPER_ID_POLICY}, --mac-signing-env, and --mac-signing-root.`);
    }
  }
  const validationIdentity = [result.validationVersion, result.validationAppId, result.validationProductName];
  if (validationIdentity.some(Boolean) || result.validationUpdateRepository) {
    if (!validationIdentity.every(Boolean) || process.env.XR_COLLECTOR_VALIDATION_BUILD !== '1') throw new Error('Validation identity requires all validation options and XR_COLLECTOR_VALIDATION_BUILD=1.');
    result.validationUpdateRepository ??= productionUpdateRepository;
    if (!/^\d+\.\d+\.\d+$/u.test(result.validationVersion)
      || !/^com\.xrcollector\.verify[\w.-]+$/u.test(result.validationAppId)
      || !/^XR Update Verify [\w .-]+$/u.test(result.validationProductName)
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(result.validationUpdateRepository)) {
      throw new Error('Validation version, app id, product name or update repository is invalid.');
    }
  }
  return result;
}

/**
 * Builds, signs, verifies and hands off one target's package. Each stage's wall time is
 * recorded; once the checkout lock is held, the run prints a timing table and writes
 * `XR-Collector-<version>-<target>-timings.json` to the output directory, whether the
 * run succeeds or fails.
 */
export async function packageApplication(options, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const probeHost = dependencies.probePhysicalHost ?? (() => probePhysicalHost({ run: runForOutput }));
  const ownCheckout = dependencies.withPackageCheckoutLock ?? withPackageCheckoutLock;
  const outputDir = dependencies.outputDir ?? path.join(projectRoot, 'release');
  return ownCheckout(path.join(projectRoot, '.local/package-app.lock'), async ({ signal, processTracker }) => {
    const timer = dependencies.timer ?? createStageTimer();
    const report = { command: 'package', target: options.target,
      signingPolicy: options.macSigningMode ?? (options.target === 'darwin-arm64' ? 'ad-hoc' : 'unsigned') };
    const describeRun = () => ({
      file: path.join(dependencies.timingReportDirectory ?? outputDir, `XR-Collector-${report.version ?? 'unknown'}-${options.target}-timings.json`),
      ...report,
    });
    return runWithTimingReport(timer, describeRun, async () => {
    const lifecycleRun = (command, args, runOptions = {}) => run(command, args, {
      ...runOptions, signal, processTracker, processTrackers: runOptions.processTrackers ?? [processTracker],
    });
    const { commit } = await timer.time('read commit and require a clean checkout', () => (dependencies.readPackagingGitIdentity ?? readPackagingGitIdentity)(projectRoot));
    report.commit = commit;
    const signingConfiguration = options.macSigningMode
      ? await timer.time('load signing configuration', () => (dependencies.loadMacSigningConfiguration ?? loadMacSigningConfiguration)({ environmentFile: options.macSigningEnv, pathRoot: options.macSigningRoot }))
      : null;
    const build = async (signingContext = null) => {
    const buildProcessTrackers = signingContext?.processTrackers ?? [processTracker];
    const buildLifecycleRun = (command, args, runOptions = {}) => lifecycleRun(command, args, {
      ...runOptions, processTrackers: runOptions.processTrackers ?? buildProcessTrackers,
    });
    // Verifiers parse codesign, spctl and stapler output, so they get a runner that captures it.
    const verifyRun = (command, args) => (dependencies.runCaptured ?? runCaptured)(command, args, {
      signal, processTracker, processTrackers: buildProcessTrackers,
    });
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const version = options.validationVersion ?? packageJson.version;
    report.version = version;
    const npmCli = npmCliPath();
    const electronBuilderCli = path.join(projectRoot, 'node_modules/electron-builder/cli.js');
    await stat(npmCli);
    await stat(electronBuilderCli);
    await timer.time('check build environment', () => (dependencies.assertBuildEnvironment ?? assertBuildEnvironment)({ target: options.target }));
    const targetArg = options.target === 'darwin-arm64' ? 'mac' : 'win';
    // Packaging installs runtimes only from the per-user cache; `npm run prepare:runtime` fills it.
    await timer.time('runtime: install yt-dlp/Deno and Meilisearch from cache', () => buildLifecycleRun(process.execPath, [
      path.join(projectRoot, 'scripts/prepare-runtime.mjs'), targetArg, '--cache-only']));
    if (options.target === 'win32-x64') {
      await timer.time('runtime: verify and install Windows CRT', () => buildLifecycleRun(process.execPath, [path.join(projectRoot, 'scripts/prepare-windows-crt.mjs')]));
    }
    await timer.time('build: npm run build', () => buildLifecycleRun(process.execPath, [npmCli, 'run', 'build']));
    await timer.time('build: write BuildInfo', () => buildLifecycleRun(process.execPath, [path.join(projectRoot, 'scripts/write-build-info.mjs'), '--kind', 'packaged', '--target', options.target,
      ...(options.validationVersion ? ['--version-override', options.validationVersion] : [])]));
    await timer.time('build: stage BuildInfo sidecar', () => (dependencies.stageBuildInfoSidecar ?? stageBuildInfoSidecar)(projectRoot));
    if (options.target === 'darwin-arm64') await timer.time('build: macOS update helper', () => buildLifecycleRun(process.execPath, [path.join(projectRoot, 'scripts/build-mac-update-helper.mjs')]));
    await timer.time('clear previous artifacts', () => (dependencies.clearPreviousArtifactSet ?? clearPreviousArtifactSet)(outputDir, [
      expectedArtifactPrefix(version, options.target),
      `XR-Collector-${version}-${options.target}`,
      releaseIndexName(options.target),
    ]));
    const signed = signingConfiguration !== null;
    const commonBuilderArgs = [...(signed ? ['--config', 'electron-builder.signed.yml'] : []),
      ...validationBuilderArguments(options), '--publish', 'never'];
    const builderEnvironment = signedBuilderEnvironmentForPackage(signingConfiguration, signingContext);
    let signingReceipt = null;
    let verifiedAppIdentity = null;
    if (signed) {
      const identityOverride = signedBuilderIdentityOverride(signingContext.identity);
      const firstArgs = [...commonBuilderArgs, '--mac', '--dir', identityOverride];
      await timeElectronBuilder(timer, 'electron-builder --dir (pack, afterPack runtime signing, App codesign)', { signedAfterPack: true },
        (hookArgs, hookEnvironment) => buildLifecycleRun(process.execPath, [electronBuilderCli, ...firstArgs, ...hookArgs], { environment: { ...builderEnvironment, ...hookEnvironment } }));
      const productName = options.validationProductName ?? 'XR Collector';
      const appPath = path.join(outputDir, 'mac-arm64', `${productName}.app`);
      const verifyApp = dependencies.verifyDeveloperIdApplication ?? verifyDeveloperIdApplication;
      const validateNotarized = dependencies.validateNotarizedApplication ?? validateNotarizedApplication;
      // The App is notarized once and stapled; the DMG and ZIP are both built from that stapled App,
      // and the DMG is then notarized and stapled itself. The full Developer ID gate runs on the App
      // before notarization and on the stapled App; the App inside the DMG and the ZIP, and the
      // packaged App, are then byte-compared with the stapled App instead of re-running that gate.
      const notarize = dependencies.notarizeAndStaple ?? notarizeAndStaple;
      await timer.group('verify: App Developer ID before notarization', (child) => verifyApp(appPath, signingConfiguration.teamId, { run: verifyRun, timer: child }));
      const evidenceDirectory = path.join(projectRoot, '.local/ticket-artifacts/35/notary', version);
      const app = await timer.group('notarize: App', (child) => notarize({
        kind: 'app', artifactPath: appPath, credentials: signingConfiguration.notary, evidenceDirectory,
      }, { signal, processTrackers: signingContext.processTrackers, timer: child }));
      signal.throwIfAborted();
      await timer.group('verify: stapled App Developer ID', (child) => verifyApp(appPath, signingConfiguration.teamId, { run: verifyRun, timer: child }));
      await timer.group('verify: stapled App Gatekeeper', (child) => validateNotarized(appPath, { run: verifyRun, timer: child, stapleValidated: app.stapleValidated }));
      const installerArgs = [...commonBuilderArgs, '--mac', 'dmg', 'zip', '--prepackaged', appPath, identityOverride];
      await timeElectronBuilder(timer, 'electron-builder --prepackaged (signed DMG, ZIP)', { signedAfterPack: true },
        (hookArgs, hookEnvironment) => buildLifecycleRun(process.execPath, [electronBuilderCli, ...installerArgs, ...hookArgs], { environment: { ...builderEnvironment, ...hookEnvironment } }));
      const dmgPath = await findUniqueArtifact(outputDir, expectedArtifactPrefix(version, options.target), '.dmg');
      const zipPath = await findUniqueArtifact(outputDir, expectedArtifactPrefix(version, options.target), '.zip');
      const dmg = await timer.group('notarize: DMG', (child) => notarize({
        kind: 'dmg', artifactPath: dmgPath, credentials: signingConfiguration.notary, evidenceDirectory,
      }, { signal, processTrackers: signingContext.processTrackers, timer: child }));
      signal.throwIfAborted();
      const dmgCheck = await timer.group('verify: DMG Developer ID and Gatekeeper', (child) => (dependencies.verifyDeveloperIdDiskImage ?? verifyDeveloperIdDiskImage)(dmgPath, signingConfiguration.teamId, { run: verifyRun, timer: child, stapleValidated: dmg.stapleValidated }));
      (dependencies.log ?? console.log)(`DMG Gatekeeper assessment (spctl --type open): source=${dmgCheck.gatekeeper.source}`);
      const appGate = { run: verifyRun, expectedAppIdentity: app.stapled, verifyDeveloperId: false };
      await timer.group('verify: DMG contents', (child) => (dependencies.verifySignedMacDmgContents ?? verifySignedMacDmgContents)(dmgPath, productName, signingConfiguration.teamId, { ...appGate, timer: child }));
      await timer.group('verify: ZIP contents', (child) => (dependencies.verifySignedMacZip ?? verifySignedMacZip)(zipPath, productName, signingConfiguration.teamId, { ...appGate, timer: child }));
      verifiedAppIdentity = app.stapled;
      signingReceipt = {
        policy: DEVELOPER_ID_POLICY,
        credentialDiscovery: false,
        teamId: signingConfiguration.teamId,
        identity: { sha1: signingContext.identity.sha1, name: signingContext.identity.name },
        actualVerification: { kind: 'developer-id-notarized', app, dmg, gatekeeperDownload: 'pending-clean-browser-acceptance' },
      };
    } else {
      const builderArgs = [...commonBuilderArgs, options.target === 'darwin-arm64' ? '--mac' : '--win'];
      if (options.target === 'win32-x64') builderArgs.push('--x64');
      await timeElectronBuilder(timer, `electron-builder ${options.target === 'darwin-arm64' ? '--mac (pack, ad-hoc codesign, ZIP, DMG)' : '--win (pack, NSIS)'}`, { signedAfterPack: false },
        (hookArgs, hookEnvironment) => buildLifecycleRun(process.execPath, [electronBuilderCli, ...builderArgs, ...hookArgs], { environment: { ...packageChildEnvironment(), ...hookEnvironment } }));
    }
    const expected = { commit, version, target: options.target,
      ...(options.validationProductName ? { productName: options.validationProductName, appId: options.validationAppId } : {}),
      updateRepository: options.validationUpdateRepository ?? productionUpdateRepository };
    const verified = await timer.group('verify: packaged App (BuildInfo, runtime, resources)', (child) => verifyPackagedApplication({ outputDir, ...expected,
      signingPolicy: signingReceipt?.policy, expectedTeamId: signingConfiguration?.teamId, verifiedAppIdentity }, { run: verifyRun, timer: child }));
    const artifacts = await findInstallerArtifacts(outputDir, expected, signingReceipt?.policy);
    const { host, toolVersions } = await timer.time('read host and tool versions', async () => ({
      host: await probeHost(),
      toolVersions: {
        node: process.version,
        npm: (await capture(process.execPath, [npmCli, '--version'])).trim(),
        electron: packageJson.devDependencies.electron,
        electronBuilder: (await capture(process.execPath, [electronBuilderCli, '--version'])).trim(),
      },
    }));
    const handoff = await writeArtifactHandoff({ outputDir, ...expected, timer, buildInfo: verified.buildInfo, artifacts, host,
      toolVersions, runtimeIdentity: {
        dependencies: verified.dependencyManifest,
        meilisearch: verified.meiliManifest,
        signed: verified.signedRuntimeIdentity ?? null,
        searchLexicon: verified.lexiconManifest,
        windowsCrt: options.target === 'win32-x64'
          ? JSON.parse(await readFile(path.join(projectRoot, 'scripts/runtime-dependency-pins.json'), 'utf8')).windowsCrt
          : null,
      },
      signing: signingReceipt ?? (options.target === 'darwin-arm64'
        ? { policy: 'ad-hoc', credentialDiscovery: false, actualVerification: { kind: 'codesign-deep-strict', notarization: 'not-requested', gatekeeperDownload: 'not-trusted' } }
        : { policy: 'unsigned', credentialDiscovery: false, actualVerification: 'pending-native-package-check' }),
    });
    report.artifacts = handoff.manifest.artifacts;
    return handoff;
    };
    if (!signingConfiguration) return build();
    const sessionStartedAt = timer.now();
    let buildStarted = false;
    let buildEndedAt = null;
    const timedBuild = async (signingContext) => {
      buildStarted = true;
      timer.record('signing keychain: create and import identity', { startedAt: sessionStartedAt, ms: timer.now() - sessionStartedAt });
      try { return await build(signingContext); } finally { buildEndedAt = timer.now(); }
    };
    try {
      return await (dependencies.withTemporarySigningKeychain ?? withTemporarySigningKeychain)(signingConfiguration, timedBuild, { signal, processTracker });
    } finally {
      if (!buildStarted) timer.record('signing keychain: create and import identity', { startedAt: sessionStartedAt, ms: timer.now() - sessionStartedAt, status: 'failed' });
      else timer.record('signing keychain: remove', { startedAt: buildEndedAt, ms: timer.now() - buildEndedAt });
    }
    }, { log: dependencies.timingLog });
  });
}

const timingHook = './scripts/package-timing-hook.mjs';

/**
 * Runs one electron-builder invocation as a stage. The timing hooks append events to a private
 * file that is read back as child stages after the builder exits, also when it fails. A Developer
 * ID build keeps its signing afterPack hook, which records its own afterPack marks and stages.
 */
async function timeElectronBuilder(timer, name, { signedAfterPack }, runBuilder) {
  return timer.group(name, async (child) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xr-builder-timings-'));
    const eventsFile = path.join(directory, 'events.jsonl');
    const hooks = ['beforePack', ...(signedAfterPack ? [] : ['afterPack']), 'afterSign', 'artifactBuildStarted', 'artifactBuildCompleted'];
    try {
      return await runBuilder(hooks.map((hook) => `--config.${hook}=${timingHook}`), { [BUILDER_TIMINGS_ENV]: eventsFile });
    } finally {
      try { await recordBuilderTimings(child, eventsFile); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
}

function signedBuilderEnvironmentForPackage(configuration, context) {
  if (!configuration) return undefined;
  return signedBuilderEnvironment(packageChildEnvironment(), {
    keychain: context.keychain,
    identity: context.identity,
    teamId: configuration.teamId,
    sourceRoot: projectRoot,
  });
}

export function signedBuilderIdentityOverride(identity) {
  if (!/^[0-9a-f]{40}$/iu.test(identity?.sha1 ?? '')) throw new Error('Signed Mac builder identity requires the selected certificate SHA-1.');
  return `--config.mac.identity=${identity.sha1}`;
}

/**
 * Stages an exact sidecar copy outside electron-builder's ASAR file set. Using the ASAR source
 * itself as `extraResources.from` makes electron-builder exclude that source from app.asar.
 */
export async function stageBuildInfoSidecar(root = projectRoot) {
  const source = path.join(root, 'dist/node/build-info.json');
  const destination = path.join(root, '.local/package-resources/build-info.json');
  const bytes = await readFile(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  if (!Buffer.from(await readFile(destination)).equals(bytes)) throw new Error('Staged BuildInfo sidecar differs from the ASAR source.');
  return { source, destination, bytes };
}

/** Validation packages bake their unique product name into ASAR metadata as well as the installer. */
export function validationBuilderArguments(options) {
  if (!options.validationVersion) return [];
  return [`--config.extraMetadata.version=${options.validationVersion}`,
    `--config.extraMetadata.productName=${options.validationProductName}`,
    `--config.extraMetadata.xrCollectorAppId=${options.validationAppId}`,
    `--config.extraMetadata.xrCollectorUpdateRepository=${options.validationUpdateRepository ?? productionUpdateRepository}`,
    `--config.appId=${options.validationAppId}`, `--config.productName=${options.validationProductName}`];
}

export async function readPackagingGitIdentity(root, sourceEnvironment = process.env) {
  const environment = packageChildEnvironment(sourceEnvironment);
  const topLevel = (await capture('git', ['rev-parse', '--show-toplevel'], { cwd: root, environment })).trim();
  if (!samePath(await realpath(topLevel), await realpath(root))) throw new Error('Packaging Git identity does not belong to this checkout.');
  const status = (await capture('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, environment })).trim();
  if (status) throw new Error('Packaging requires a clean Git checkout; no runtime or build step was started.');
  const commit = (await capture('git', ['rev-parse', 'HEAD'], { cwd: root, environment })).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('Packaging requires a full Git commit identity.');
  return { commit };
}

/**
 * Reads back the packaged App's metadata, BuildInfo, runtimes and resources. An ad-hoc App gets its
 * bundle signature checked here. A Developer ID App must be byte-identical to `verifiedAppIdentity`,
 * the stapled App that already passed the Developer ID, runtime signature and notarization gates,
 * so those gates are not repeated.
 */
export async function verifyPackagedApplication({ outputDir, commit, version, target, productName = 'XR Collector', appId = 'com.moneydj.xrcollector', updateRepository = productionUpdateRepository, signingPolicy, expectedTeamId, verifiedAppIdentity }, dependencies = {}) {
  const appPath = target === 'darwin-arm64' ? path.join(outputDir, 'mac-arm64', `${productName}.app`) : null;
  const resources = appPath
    ? path.join(appPath, 'Contents/Resources')
    : path.join(outputDir, 'win-unpacked/resources');
  const timer = dependencies.timer ?? noStageTimer;
  if (appPath) {
    if (signingPolicy === DEVELOPER_ID_POLICY) {
      const actual = await timer.time('hash App identity', () => (dependencies.describeArtifact ?? describeArtifact)(appPath));
      if (!verifiedAppIdentity || JSON.stringify(actual) !== JSON.stringify(verifiedAppIdentity)) throw new Error('Packaged App differs from the verified stapled App.');
    } else await timer.time('codesign --verify --deep --strict', () => (dependencies.verifyMacBundle ?? verifyMacBundleSignature)(appPath, dependencies.run));
  }
  const asarPath = path.join(resources, 'app.asar');
  const packageMetadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
  assertPackagedProductMetadata(packageMetadata, productName, appId, updateRepository);
  const buildInfo = JSON.parse(extractFile(asarPath, path.join('dist', 'node', 'build-info.json')).toString('utf8'));
  const sidecarBuildInfo = JSON.parse(await readFile(path.join(resources, 'build-info.json'), 'utf8'));
  if (JSON.stringify(sidecarBuildInfo) !== JSON.stringify(buildInfo)) throw new Error('Packaged BuildInfo sidecar differs from app.asar.');
  const required = { schemaVersion: 1, kind: 'packaged', version, commit, target, sourceDirty: false };
  for (const [key, value] of Object.entries(required)) if (buildInfo[key] !== value) throw new Error(`Packaged BuildInfo ${key} does not match the packaging request.`);
  if (typeof buildInfo.buildId !== 'string' || !buildInfo.buildId || !Number.isFinite(Date.parse(buildInfo.builtAt))) throw new Error('Packaged BuildInfo identity is incomplete.');
  const bin = path.join(resources, 'bin');
  const dependencyManifest = JSON.parse(await readFile(path.join(bin, 'runtime-dependencies.json'), 'utf8'));
  let signedRuntimeIdentity = null;
  if (signingPolicy === DEVELOPER_ID_POLICY) {
    const trustedDependencies = JSON.parse(await readFile(path.join(projectRoot, 'resources/bin/mac/runtime-dependencies.json'), 'utf8'));
    if (dependencyManifest.target !== target || JSON.stringify(dependencyManifest) !== JSON.stringify(trustedDependencies)) throw new Error('Signed package raw runtime producer identity is invalid.');
    signedRuntimeIdentity = await timer.group('signed runtime inventory', (child) => (dependencies.verifySignedRuntimeInventory ?? verifySignedRuntimeInventory)(bin, expectedTeamId, { verifySignatures: false, timer: child }));
  } else if (dependencyManifest.target !== target || !await timer.time('yt-dlp/Deno inventory', () => verifyRuntimeDependencyInstallation(bin, dependencyManifest))) throw new Error('Packaged yt-dlp/Deno inventory is invalid.');
  const meiliManifest = JSON.parse(await readFile(path.join(bin, 'meilisearch-build.json'), 'utf8'));
  if (meiliManifest.target !== target) throw new Error('Packaged Meilisearch target does not match the package target.');
  const runtimeDirectory = target === 'win32-x64' ? 'win' : 'mac';
  const trustedManifest = dependencies.trustedManifest
    ?? JSON.parse(await readFile(path.join(projectRoot, 'resources/bin', runtimeDirectory, 'meilisearch-build.json'), 'utf8'));
  if (JSON.stringify(meiliManifest) !== JSON.stringify(trustedManifest)) throw new Error('Packaged Meilisearch manifest does not match the prepared producer identity.');
  const executable = path.join(bin, target === 'win32-x64' ? 'meilisearch.exe' : 'meilisearch');
  if (signingPolicy !== DEVELOPER_ID_POLICY
    && await timer.time('hash Meilisearch', async () => (await stat(executable)).size !== meiliManifest.binary.bytes || await sha256(executable) !== meiliManifest.binary.sha256)) throw new Error('Packaged Meilisearch bytes do not match its manifest.');
  const validateBinary = dependencies.validateBinary ?? validateExecutable;
  const binaryIdentity = await timer.time('Meilisearch executable identity', () => validateBinary(executable, TARGETS[target], '1.53.2', dependencies.runBinary ?? runForOutput));
  if (signingPolicy === DEVELOPER_ID_POLICY) {
    if (binaryIdentity.version !== meiliManifest.binary.version || binaryIdentity.versionOutput !== meiliManifest.binary.versionOutput
      || binaryIdentity.format !== meiliManifest.binary.format || binaryIdentity.arch !== meiliManifest.binary.arch) {
      throw new Error('Signed Meilisearch executable semantics do not match its trusted producer manifest.');
    }
  } else if (JSON.stringify(binaryIdentity) !== JSON.stringify(meiliManifest.binary)) throw new Error('Packaged Meilisearch executable identity does not match its trusted producer manifest.');
  const lexiconDirectory = path.join(resources, 'search');
  const lexiconManifest = JSON.parse(await readFile(path.join(lexiconDirectory, 'coct-main.json'), 'utf8'));
  const trustedLexiconManifest = dependencies.trustedLexiconManifest
    ?? JSON.parse(await readFile(path.join(projectRoot, 'resources/search/coct-main.json'), 'utf8'));
  if (JSON.stringify(lexiconManifest) !== JSON.stringify(trustedLexiconManifest)) throw new Error('Packaged search lexicon manifest does not match the source resource identity.');
  const lexicon = path.join(lexiconDirectory, lexiconManifest.output?.file ?? '');
  if ((await stat(lexicon)).size !== lexiconManifest.output?.bytes || await sha256(lexicon) !== lexiconManifest.output?.sha256) {
    throw new Error('Packaged search lexicon bytes do not match its manifest.');
  }
  const packagedSkill = path.join(resources, 'skills/xr-collector-agent/SKILL.md');
  const sourceSkill = dependencies.sourceSkillPath ?? path.join(projectRoot, 'skills/xr-collector-agent/SKILL.md');
  if ((await stat(packagedSkill)).size !== (await stat(sourceSkill)).size || await sha256(packagedSkill) !== await sha256(sourceSkill)) {
    throw new Error('Packaged Agent Skill does not match the source artifact.');
  }
  const crt = path.join(bin, 'vcruntime140.dll');
  if (target === 'darwin-arm64') {
    const helper = path.join(bin, 'xr-mac-update-helper');
    const helperInfo = await stat(helper);
    if (!helperInfo.isFile() || (helperInfo.mode & 0o111) === 0) throw new Error('Packaged macOS update helper is missing or not executable.');
  }
  if (target === 'win32-x64') {
    const pin = JSON.parse(await readFile(path.join(projectRoot, 'scripts/runtime-dependency-pins.json'), 'utf8')).windowsCrt;
    if ((await stat(crt)).size !== pin.bytes || await sha256(crt) !== pin.sha256) throw new Error('Packaged Windows CRT does not match its pin.');
  } else if (await exists(crt)) throw new Error('Only the Windows package contains vcruntime140.dll.');
  return { resources, buildInfo, packageMetadata, dependencyManifest, meiliManifest, signedRuntimeIdentity, lexiconManifest };
}

export async function verifyMacBundleSignature(appPath, run = runVerificationCommand) {
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  } catch (error) {
    throw new Error(`Packaged macOS application has an invalid signature or sealed resource inventory: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
}

export async function verifySignedMacZip(zipPath, productName, expectedTeamId, dependencies = {}) {
  const temporary = await (dependencies.mkdtemp ?? mkdtemp)(path.join(tmpdir(), 'xr-signed-zip-'));
  const run = dependencies.run ?? runVerificationCommand;
  const timer = dependencies.timer ?? noStageTimer;
  try {
    await timer.time('extract ZIP (ditto)', () => run('/usr/bin/ditto', ['-x', '-k', zipPath, temporary]));
    const appPath = await requireOnlyExpectedApplication(temporary, productName);
    return await verifyStapledAppInArtifact(appPath, 'ZIP', expectedTeamId, { ...dependencies, run, timer });
  } finally { await (dependencies.rm ?? rm)(temporary, { recursive: true, force: true }); }
}

export async function verifySignedMacDmgContents(dmgPath, productName, expectedTeamId, dependencies = {}) {
  const temporary = await (dependencies.mkdtemp ?? mkdtemp)(path.join(tmpdir(), 'xr-signed-dmg-'));
  const mount = path.join(temporary, 'mount');
  const run = dependencies.run ?? runVerificationCommand;
  const timer = dependencies.timer ?? noStageTimer;
  let mounted = false;
  let primaryError;
  try {
    await mkdir(mount);
    await timer.time('attach DMG (hdiutil)', () => run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmgPath]));
    mounted = true;
    const appPath = await requireOnlyExpectedApplication(mount, productName);
    return await verifyStapledAppInArtifact(appPath, 'DMG', expectedTeamId, { ...dependencies, run, timer });
  } catch (error) { primaryError = error; throw error; }
  finally {
    let detachError;
    if (mounted) {
      try { await run('/usr/bin/hdiutil', ['detach', mount]); mounted = false; }
      catch (error) {
        try { await run('/usr/bin/hdiutil', ['detach', '-force', mount]); mounted = false; }
        catch (forceError) { detachError = new AggregateError([error, forceError], `Unable to detach the owned read-only DMG mount ${mount}.`); }
      }
    }
    if (!mounted) await (dependencies.rm ?? rm)(temporary, { recursive: true, force: true });
    if (detachError) throw primaryError ? new AggregateError([primaryError, detachError], 'DMG verification and mount cleanup both failed.') : detachError;
  }
}

/**
 * Checks the stapled App inside a DMG or ZIP. When `expectedAppIdentity` is given, the App bytes must
 * equal it. The full Developer ID gate runs unless `verifyDeveloperId` is false, which the packager
 * passes because those exact bytes already passed it as the stapled App. `stapler validate`,
 * `syspolicy_check` and `spctl` always run on the App as it sits in the artifact.
 */
async function verifyStapledAppInArtifact(appPath, container, expectedTeamId, dependencies) {
  const { run, timer } = dependencies;
  const appIdentity = await timer.time('hash App identity', () => (dependencies.describeArtifact ?? describeArtifact)(appPath));
  if (dependencies.expectedAppIdentity && JSON.stringify(appIdentity) !== JSON.stringify(dependencies.expectedAppIdentity)) {
    throw new Error(`The App inside the ${container} differs from the stapled App.`);
  }
  if (dependencies.verifyDeveloperId !== false) await timer.group('App Developer ID', (child) => (dependencies.verifyDeveloperIdApplication ?? verifyDeveloperIdApplication)(appPath, expectedTeamId, { run, timer: child }));
  await timer.group('App notarization and Gatekeeper', (child) => (dependencies.validateNotarizedApplication ?? validateNotarizedApplication)(appPath, { run, timer: child }));
  return { appIdentity };
}

async function requireOnlyExpectedApplication(directory, productName) {
  const apps = (await readdir(directory)).filter((name) => name.endsWith('.app'));
  const expected = `${productName}.app`;
  if (apps.length !== 1 || apps[0] !== expected) throw new Error(`Signed artifact must contain exactly ${expected}.`);
  return path.join(directory, expected);
}

export function assertPackagedProductMetadata(metadata, productName, appId = 'com.moneydj.xrcollector', updateRepository = productionUpdateRepository) {
  if (metadata?.name !== 'xr-collector') throw new Error('Packaged application name is not XR Collector.');
  if (productName === 'XR Collector') {
    if (metadata.productName !== undefined && metadata.productName !== productName) throw new Error('Packaged productName does not match the packaging request.');
  } else if (metadata.productName !== productName) {
    throw new Error('Validation productName is missing from packaged application metadata.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(updateRepository)) throw new Error('Packaging update repository is invalid.');
  if (productName === 'XR Collector') {
    if (metadata.xrCollectorUpdateRepository !== undefined || metadata.xrCollectorAppId !== undefined) throw new Error('Production package must not override its packaged identity.');
  } else if (metadata.xrCollectorUpdateRepository !== updateRepository || metadata.xrCollectorAppId !== appId) {
    throw new Error('Validation update repository is missing from packaged application metadata.');
  }
}

/**
 * Writes the platform release index, `release-<target>.json`, that the updater and
 * `release:upload` read, and the private artifact manifest that records the build.
 */
export async function writeArtifactHandoff(input) {
  const base = `XR-Collector-${input.version}-${input.target}`;
  const isMac = input.target === 'darwin-arm64';
  const installer = input.artifacts.find((artifact) => artifact.endsWith(isMac ? '.dmg' : '.exe'));
  const update = input.artifacts.find((artifact) => artifact.endsWith(isMac ? '.zip' : '.exe'));
  if (!installer || !update) throw new Error(`No installer and update artifact exist for ${input.target}.`);
  const timer = input.timer ?? noStageTimer;
  const described = await timer.time('hash: artifact sha256 inventory', async (stage) => {
    const files = await Promise.all(input.artifacts.map(async (artifact) => ({ path: path.basename(artifact), ...await describeFile(artifact) })));
    stage.bytes = files.reduce((total, artifact) => total + artifact.bytes, 0);
    return files;
  }, { count: input.artifacts.length });
  const entry = (artifact) => {
    const { path: name, bytes, sha256: digest } = described.find((file) => file.path === path.basename(artifact));
    return { name, bytes, sha256: digest };
  };
  const releaseIndex = path.join(input.outputDir, releaseIndexName(input.target));
  const index = { schemaVersion: 1, version: input.version, commit: input.commit, target: input.target,
    buildInfo: input.buildInfo, installer: entry(installer), update: entry(update) };
  await timer.time('manifest: write release index', () => writeFile(releaseIndex, `${JSON.stringify(index, null, 2)}\n`));
  const artifactManifest = path.join(input.outputDir, `${base}-artifacts.json`);
  const document = {
    schemaVersion: 1, version: input.version, commit: input.commit, target: input.target,
    packageIdentity: { productName: input.productName ?? 'XR Collector', appId: input.appId ?? 'com.moneydj.xrcollector', updateRepository: input.updateRepository ?? productionUpdateRepository },
    buildInfo: input.buildInfo, builderHost: input.host, toolVersions: input.toolVersions, signing: input.signing,
    runtimeIdentity: input.runtimeIdentity ?? null,
    artifacts: [...described, { path: path.basename(releaseIndex), ...await describeFile(releaseIndex) }],
    acceptanceEvidence: [],
  };
  await timer.time('manifest: write artifact manifest', () => writeFile(artifactManifest, `${JSON.stringify(document, null, 2)}\n`));
  return { releaseIndex, artifactManifest, manifest: document };
}

export function releaseIndexName(target) {
  return `release-${target}.json`;
}

async function findInstallerArtifacts(outputDir, { version, target }, signingPolicy) {
  const expectedPrefix = expectedArtifactPrefix(version, target);
  const entries = (await readdir(outputDir)).filter((name) => name.startsWith(expectedPrefix) && ['.dmg', '.zip', '.exe', '.blockmap'].includes(path.extname(name)));
  const installers = entries.filter((name) => ['.dmg', '.zip', '.exe'].includes(path.extname(name)));
  const expectedCount = target === 'darwin-arm64' ? 2 : 1;
  if (installers.length !== expectedCount) throw new Error(`Expected ${expectedCount} uniquely named ${target} installer artifacts, found ${installers.length}.`);
  if (target === 'darwin-arm64' && signingPolicy === DEVELOPER_ID_POLICY && entries.some((name) => name.endsWith('.dmg.blockmap'))) {
    throw new Error('Developer ID packages publish no DMG blockmap; updates use the ZIP.');
  }
  return entries.sort().map((entry) => path.join(outputDir, entry));
}

async function findUniqueArtifact(outputDir, prefix, extension) {
  const matches = (await readdir(outputDir)).filter((name) => name.startsWith(prefix) && name.endsWith(extension));
  if (matches.length !== 1) throw new Error(`Expected exactly one ${prefix}*${extension} artifact, found ${matches.length}.`);
  return path.join(outputDir, matches[0]);
}

function expectedArtifactPrefix(version, target) {
  return `XR-Collector-${version}-${target === 'darwin-arm64' ? 'mac-arm64' : 'win-x64'}`;
}

async function clearPreviousArtifactSet(outputDir, prefixes) {
  let entries;
  try { entries = await readdir(outputDir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await Promise.all(entries.filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix))).map((entry) => rm(path.join(outputDir, entry), { recursive: true, force: true })));
}

function npmCliPath() {
  const value = process.env.npm_execpath;
  if (!value || !path.isAbsolute(value)) throw new Error('Packaging must run through an npm script so the npm CLI identity is explicit.');
  return value;
}

export async function withPackageCheckoutLock(lock, work, dependencies = {}) {
  await mkdir(path.dirname(lock), { recursive: true });
  const identity = await (dependencies.processIdentity ?? readPackagingProcessIdentity)(process.pid);
  if (!identity) throw new Error('Unable to identify the packaging process owner.');
  const inspect = dependencies.processIdentity ?? readPackagingProcessIdentity;
  return withOwnedDirectoryLock(lock, async (processTracker) => {
    const controller = new AbortController();
    let interruptedSignal = null;
    const unregister = registerAbortSignals(controller, (signal) => { interruptedSignal ??= signal; }, dependencies);
    try { return await work({ signal: controller.signal, processTracker }); }
    finally {
      unregister();
      if (interruptedSignal) (dependencies.terminateAfterSignal ?? ((name) => { process.exitCode = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[name]; }))(interruptedSignal);
    }
  }, {
    ownerIdentity: async () => identity,
    inspectOwner: inspect,
    inspectUnsafeTree: dependencies.inspectProcessTree ?? inspectOwnedProcessTree,
    ownerGraceMs: dependencies.lockOwnerGraceMs,
    waitForBusy: false,
    busyMessage: `Another whole-checkout packaging run owns ${lock}.`,
    randomToken: dependencies.randomLockToken,
  });
}

export async function readPackagingProcessIdentity(pid, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const query = dependencies.capture ?? capture;
  try {
    if (platform === 'win32') {
      const script = `$p=Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; if($null -eq $p){exit 44}; $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop; if($owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.Sid)){throw 'Unable to resolve process owner SID'}; [Console]::Write(('{0}|{1}|{2}' -f $p.ProcessId,$p.CreationDate.ToUniversalTime().Ticks,$owner.Sid))`;
      const output = await query('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { environment: process.env });
      const fields = output.split('|');
      const [recordedPid, startedAt, uid] = fields;
      if (fields.length !== 3 || Number(recordedPid) !== pid || !/^\d+$/u.test(startedAt ?? '') || !uid) {
        throw new Error(`PowerShell returned malformed process identity for ${pid}.`);
      }
      return { pid, uid, startedAt };
    }
    const output = await query('/bin/ps', ['-o', 'uid=', '-o', 'lstart=', '-p', String(pid)], { environment: { ...process.env, LC_ALL: 'C' } });
    const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(output);
    if (!match) throw new Error(`ps returned malformed packaging process identity for ${pid}.`);
    return { pid, uid: Number(match[1]), startedAt: match[2] };
  } catch (error) {
    if (platform === 'win32' && /exited with status 44\b/u.test(String(error?.message))) return null;
    if (platform !== 'win32' && /exited with status 1\b/u.test(String(error?.message))) return null;
    if (/malformed (?:packaging )?process identity/u.test(String(error?.message))) throw error;
    throw new Error(`Unable to inspect packaging process ${pid}.`, { cause: error });
  }
}

function registerAbortSignals(controller, onSignal, dependencies) {
  const target = dependencies.signalTarget ?? process;
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => {
    onSignal(signal);
    controller.abort(new Error(`Packaging interrupted by ${signal}.`));
  }]));
  for (const [signal, handler] of handlers) target.once(signal, handler);
  return () => { for (const [signal, handler] of handlers) target.removeListener(signal, handler); };
}

function runCommand(command, args, options = {}) {
  return runOwnedProcess(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    environment: options.environment ?? packageChildEnvironment(),
    signal: options.signal,
    processTracker: options.processTracker,
    processTrackers: options.processTrackers,
  }).then(() => undefined);
}

export function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: options.environment ?? packageChildEnvironment(),
    });
    let output = '';
    let settled = false;
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    // A child can exit while a descendant still owns its stdout pipe. `close` is emitted only after
    // the process has ended and its stdio has drained, so the captured output is complete here.
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `status ${code}`}`));
    });
  });
}

async function runForOutput(command, args) {
  return { stdout: await capture(command, args), stderr: '' };
}

function runVerificationCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], env: packageChildEnvironment() });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr })
      : reject(new Error(`${path.basename(command)} exited with status ${code}: ${(stderr || stdout).trim() || 'no diagnostic output'}`)));
  });
}

export function packageChildEnvironment(source = process.env) {
  const result = {};
  const exactCredentials = new Set([
    'APPLE_ID', 'APPLE_ID_PASSWORD', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
    'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
    'API_KEY', 'API_KEY_ID', 'API_KEY_ISSUER', 'AC_USERNAME', 'AC_PASSWORD', 'AC_PROVIDER',
    'NOTARYTOOL_PROFILE', 'NOTARY_PROFILE', 'NOTARY_KEYCHAIN',
  ]);
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') || upper.startsWith('CSC_') || upper.startsWith('WIN_CSC_') || exactCredentials.has(upper)) continue;
    result[key] = value;
  }
  result.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  return result;
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function describeFile(filePath) { const info = await stat(filePath); return { bytes: info.size, sha256: await sha256(filePath) }; }
async function sha256(filePath) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filePath)) hash.update(chunk); return hash.digest('hex'); }
async function exists(target) { try { await stat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageApplication(parsePackageArguments(process.argv.slice(2))).then(({ artifactManifest }) => console.log(`Package handoff ready: ${artifactManifest}`)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
