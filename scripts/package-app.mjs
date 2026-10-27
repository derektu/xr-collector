#!/usr/bin/env node
import { extractFile } from '@electron/asar';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { probePhysicalHost } from './physical-host.mjs';
import { TARGETS, validateBuiltBinary } from './build-meilisearch.mjs';
import { verifyRuntimeDependencyInstallation } from './runtime-dependencies.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionUpdateRepository = 'derektu/xr-collector';

export function parsePackageArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--target') result.target = argv[++index];
    else if (argv[index] === '--variant') result.variant = argv[++index];
    else if (argv[index] === '--validation-version') result.validationVersion = argv[++index];
    else if (argv[index] === '--validation-app-id') result.validationAppId = argv[++index];
    else if (argv[index] === '--validation-product-name') result.validationProductName = argv[++index];
    else if (argv[index] === '--validation-update-repository') result.validationUpdateRepository = argv[++index];
    else throw new Error(`Unknown packaging argument ${argv[index]}.`);
  }
  if (!['darwin-arm64', 'win32-x64'].includes(result.target)) throw new Error(`Unsupported packaging target ${result.target ?? 'missing'}; use darwin-arm64 or win32-x64.`);
  if (!['chinese', 'official'].includes(result.variant)) throw new Error(`Unsupported packaging variant ${result.variant ?? 'missing'}; use chinese or official.`);
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

export async function packageApplication(options, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const probeHost = dependencies.probePhysicalHost ?? (() => probePhysicalHost({ run: runForOutput }));
  return withPackageCheckoutLock(path.join(projectRoot, '.local/package-app.lock'), async () => {
    const { commit } = await readPackagingGitIdentity(projectRoot);
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const version = options.validationVersion ?? packageJson.version;
    const outputDir = path.join(projectRoot, options.variant === 'official' ? 'release/official' : 'release');
    const npmCli = npmCliPath();
    const electronBuilderCli = path.join(projectRoot, 'node_modules/electron-builder/cli.js');
    await stat(npmCli);
    await stat(electronBuilderCli);
    await assertHostTarget(options.target, probeHost);
    const targetArg = options.target === 'darwin-arm64' ? 'mac' : 'win';
    await run(process.execPath, [path.join(projectRoot, 'scripts/download-runtime.mjs'), targetArg]);
    await run(process.execPath, [path.join(projectRoot, 'scripts/prepare-meilisearch.mjs'), '--variant', options.variant, '--target', options.target]);
    if (options.target === 'win32-x64' && options.variant === 'official') {
      await run(process.execPath, [path.join(projectRoot, 'scripts/prepare-windows-crt.mjs')]);
    } else if (options.target === 'win32-x64') {
      await rm(path.join(projectRoot, 'resources/bin/win/vcruntime140.dll'), { force: true });
    }
    await run(process.execPath, [npmCli, 'run', 'build']);
    await run(process.execPath, [path.join(projectRoot, 'scripts/write-build-info.mjs'), '--kind', 'packaged', '--target', options.target, '--variant', options.variant,
      ...(options.validationVersion ? ['--version-override', options.validationVersion] : [])]);
    await stageBuildInfoSidecar(projectRoot);
    if (options.target === 'darwin-arm64') await run(process.execPath, [path.join(projectRoot, 'scripts/build-mac-update-helper.mjs')]);
    const builderArgs = options.variant === 'official' ? ['--config', 'electron-builder.official.yml'] : [];
    builderArgs.push(options.target === 'darwin-arm64' ? '--mac' : '--win');
    if (options.target === 'win32-x64') builderArgs.push('--x64');
    builderArgs.push(...validationBuilderArguments(options));
    builderArgs.push('--publish', 'never');
    await clearPreviousArtifactSet(outputDir, [
      expectedArtifactPrefix(version, options.variant, options.target),
      `XR-Collector-${version}-${options.variant}-${options.target}`,
    ]);
    await run(process.execPath, [electronBuilderCli, ...builderArgs]);
    const expected = { commit, version, target: options.target, variant: options.variant,
      ...(options.validationProductName ? { productName: options.validationProductName, appId: options.validationAppId } : {}),
      updateRepository: options.validationUpdateRepository ?? productionUpdateRepository };
    const verified = await verifyPackagedApplication({ outputDir, ...expected });
    const artifacts = await findInstallerArtifacts(outputDir, expected);
    const host = await probeHost();
    const toolVersions = {
      node: process.version,
      npm: (await capture(process.execPath, [npmCli, '--version'])).trim(),
      electron: packageJson.devDependencies.electron,
      electronBuilder: (await capture(process.execPath, [electronBuilderCli, '--version'])).trim(),
      ...(options.variant === 'chinese' ? {
        cargo: (await capture('cargo', ['+1.91.1', '--version'])).trim(),
        rustc: (await capture('rustc', ['+1.91.1', '--version'])).trim(),
      } : {}),
    };
    return writeArtifactHandoff({ outputDir, ...expected, buildInfo: verified.buildInfo, artifacts, host,
      toolVersions, runtimeIdentity: {
        dependencies: verified.dependencyManifest,
        meilisearch: verified.meiliManifest,
        windowsCrt: options.target === 'win32-x64' && options.variant === 'official'
          ? JSON.parse(await readFile(path.join(projectRoot, 'scripts/runtime-dependency-pins.json'), 'utf8')).officialWindowsCrt
          : null,
      },
      signing: { policy: 'unsigned', credentialDiscovery: false, actualVerification: 'pending-native-package-check' },
    });
  });
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

export async function verifyPackagedApplication({ outputDir, commit, version, target, variant, productName = 'XR Collector', appId = 'com.moneydj.xrcollector', updateRepository = productionUpdateRepository }, dependencies = {}) {
  const resources = target === 'darwin-arm64'
    ? path.join(outputDir, 'mac-arm64', `${productName}.app`, 'Contents/Resources')
    : path.join(outputDir, 'win-unpacked/resources');
  const asarPath = path.join(resources, 'app.asar');
  const packageMetadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
  assertPackagedProductMetadata(packageMetadata, productName, appId, updateRepository);
  const buildInfo = JSON.parse(extractFile(asarPath, path.join('dist', 'node', 'build-info.json')).toString('utf8'));
  const sidecarBuildInfo = JSON.parse(await readFile(path.join(resources, 'build-info.json'), 'utf8'));
  if (JSON.stringify(sidecarBuildInfo) !== JSON.stringify(buildInfo)) throw new Error('Packaged BuildInfo sidecar differs from app.asar.');
  const required = { schemaVersion: 1, kind: 'packaged', version, commit, target, variant, sourceDirty: false };
  for (const [key, value] of Object.entries(required)) if (buildInfo[key] !== value) throw new Error(`Packaged BuildInfo ${key} does not match the packaging request.`);
  if (typeof buildInfo.buildId !== 'string' || !buildInfo.buildId || !Number.isFinite(Date.parse(buildInfo.builtAt))) throw new Error('Packaged BuildInfo identity is incomplete.');
  const bin = path.join(resources, 'bin');
  const dependencyManifest = JSON.parse(await readFile(path.join(bin, 'runtime-dependencies.json'), 'utf8'));
  if (dependencyManifest.target !== target || !await verifyRuntimeDependencyInstallation(bin, dependencyManifest)) throw new Error('Packaged yt-dlp/Deno inventory is invalid.');
  const meiliManifest = JSON.parse(await readFile(path.join(bin, 'meilisearch-build.json'), 'utf8'));
  if (meiliManifest.target !== target || manifestVariant(meiliManifest) !== variant) throw new Error('Packaged Meilisearch identity does not match the package variant.');
  const runtimeDirectory = target === 'win32-x64' ? 'win' : 'mac';
  const trustedManifest = dependencies.trustedManifest
    ?? JSON.parse(await readFile(path.join(projectRoot, 'resources/bin', runtimeDirectory, 'meilisearch-build.json'), 'utf8'));
  if (JSON.stringify(meiliManifest) !== JSON.stringify(trustedManifest)) throw new Error('Packaged Meilisearch manifest does not match the prepared producer identity.');
  const executable = path.join(bin, target === 'win32-x64' ? 'meilisearch.exe' : 'meilisearch');
  if ((await stat(executable)).size !== meiliManifest.binary.bytes || await sha256(executable) !== meiliManifest.binary.sha256) throw new Error('Packaged Meilisearch bytes do not match its manifest.');
  const validateBinary = dependencies.validateBinary ?? validateBuiltBinary;
  const binaryIdentity = await validateBinary(executable, TARGETS[target], '1.53.2', dependencies.runBinary ?? runForOutput);
  if (JSON.stringify(binaryIdentity) !== JSON.stringify(meiliManifest.binary)) throw new Error('Packaged Meilisearch executable identity does not match its trusted producer manifest.');
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
  if (target === 'win32-x64' && variant === 'official') {
    const pins = JSON.parse(await readFile(path.join(projectRoot, 'scripts/runtime-dependency-pins.json'), 'utf8'));
    if ((await stat(crt)).size !== pins.officialWindowsCrt.bytes || await sha256(crt) !== pins.officialWindowsCrt.sha256) throw new Error('Packaged official Windows CRT does not match its pin.');
  } else if (await exists(crt)) throw new Error('Only the official Windows package may contain vcruntime140.dll.');
  return { resources, buildInfo, packageMetadata, dependencyManifest, meiliManifest };
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

export async function writeArtifactHandoff(input) {
  const base = `XR-Collector-${input.version}-${input.variant}-${input.target}`;
  const updateMetadata = path.join(input.outputDir, `${base}-update.yml`);
  const primary = input.artifacts.find((artifact) => input.target === 'darwin-arm64' ? artifact.endsWith('.zip') : artifact.endsWith('.exe'));
  if (!primary) throw new Error(`No primary update artifact exists for ${input.target}.`);
  const primaryInfo = await describeFile(primary);
  const releaseDate = input.buildInfo.builtAt;
  await writeFile(updateMetadata, stringifyYaml({ version: input.version, files: [{ url: path.basename(primary), sha512: await sha512Base64(primary), size: primaryInfo.bytes }], path: path.basename(primary), sha512: await sha512Base64(primary), releaseDate }));
  const artifacts = [...input.artifacts, updateMetadata];
  const artifactManifest = path.join(input.outputDir, `${base}-artifacts.json`);
  const document = {
    schemaVersion: 1, version: input.version, commit: input.commit, target: input.target, variant: input.variant,
    packageIdentity: { productName: input.productName ?? 'XR Collector', appId: input.appId ?? 'com.moneydj.xrcollector', updateRepository: input.updateRepository ?? productionUpdateRepository },
    buildInfo: input.buildInfo, builderHost: input.host, toolVersions: input.toolVersions, signing: input.signing,
    runtimeIdentity: input.runtimeIdentity ?? null,
    artifacts: await Promise.all(artifacts.map(async (artifact) => ({ path: path.basename(artifact), ...await describeFile(artifact) }))),
    acceptanceEvidence: [],
  };
  await writeFile(artifactManifest, `${JSON.stringify(document, null, 2)}\n`);
  return { updateMetadata, artifactManifest, manifest: document };
}

async function findInstallerArtifacts(outputDir, { version, variant, target }) {
  const expectedPrefix = expectedArtifactPrefix(version, variant, target);
  const entries = (await readdir(outputDir)).filter((name) => name.startsWith(expectedPrefix) && ['.dmg', '.zip', '.exe', '.blockmap'].includes(path.extname(name)));
  const installers = entries.filter((name) => ['.dmg', '.zip', '.exe'].includes(path.extname(name)));
  const expectedCount = target === 'darwin-arm64' ? 2 : 1;
  if (installers.length !== expectedCount) throw new Error(`Expected ${expectedCount} uniquely named ${variant} ${target} installer artifacts, found ${installers.length}.`);
  return entries.sort().map((entry) => path.join(outputDir, entry));
}

function expectedArtifactPrefix(version, variant, target) {
  return `XR-Collector-${version}-${variant}-${target === 'darwin-arm64' ? 'mac-arm64' : 'win-x64'}`;
}

async function clearPreviousArtifactSet(outputDir, prefixes) {
  let entries;
  try { entries = await readdir(outputDir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await Promise.all(entries.filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix))).map((entry) => rm(path.join(outputDir, entry), { recursive: true, force: true })));
}

function manifestVariant(manifest) {
  if (manifest.distribution === 'official') return 'official';
  if (manifest.distribution === undefined && JSON.stringify(manifest.features) === JSON.stringify(['chinese'])) return 'chinese';
  return null;
}

export async function assertHostTarget(target, probe) {
  const host = await probe();
  if (target === 'darwin-arm64' && !(host.platform === 'darwin' && host.hostArch === 'arm64' && host.processArch === 'arm64')) throw new Error('darwin-arm64 packages require a native Apple Silicon process and host.');
  if (target === 'win32-x64' && !(host.platform === 'win32' && host.processArch === 'x64')) throw new Error('win32-x64 packages require an x64 Windows process; x64 emulation on ARM64 is recorded in the artifact manifest.');
}

function npmCliPath() {
  const value = process.env.npm_execpath;
  if (!value || !path.isAbsolute(value)) throw new Error('Packaging must run through an npm script so the npm CLI identity is explicit.');
  return value;
}

export async function withPackageCheckoutLock(lock, work) {
  await mkdir(path.dirname(lock), { recursive: true });
  try { await writeFile(lock, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another whole-checkout packaging run owns ${lock}.`); throw error; }
  try { return await work(); } finally { await rm(lock, { force: true }); }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', env: packageChildEnvironment() });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}`)));
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: options.environment ?? packageChildEnvironment(),
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited with status ${code}`)));
  });
}

async function runForOutput(command, args) {
  return { stdout: await capture(command, args), stderr: '' };
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
async function sha512Base64(filePath) { const hash = createHash('sha512'); for await (const chunk of createReadStream(filePath)) hash.update(chunk); return hash.digest('base64'); }
async function exists(target) { try { await stat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageApplication(parsePackageArguments(process.argv.slice(2))).then(({ artifactManifest }) => console.log(`Package handoff ready: ${artifactManifest}`)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
