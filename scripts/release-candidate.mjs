import { extractFile } from '@electron/asar';
import sevenZip from '7zip-bin';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { inspectExecutable } from './build-meilisearch.mjs';
import { verifyMacBundleSignature } from './package-app.mjs';
import { expectedOfficialManifest, readRuntimePins } from './prepare-meilisearch.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const combinations = [
  ['darwin-arm64', 'chinese'], ['darwin-arm64', 'official'],
  ['win32-x64', 'chinese'], ['win32-x64', 'official'],
];
const combinationKeys = new Set(combinations.map(([target, variant]) => `${target}/${variant}`));

export async function planReleaseCandidate(options, dependencies = {}) {
  const expectedVersion = options.version ?? '0.1.0';
  const tag = options.tag ?? `v${expectedVersion}`;
  if (tag !== `v${expectedVersion}`) throw new Error(`Release tag ${tag} must match version ${expectedVersion}.`);
  const sourceBaseUrl = normalizeSourceBaseUrl(options.sourceBaseUrl, tag);
  const releaseNotes = await readFile(options.notes, 'utf8');
  if (!releaseNotes.trim() || containsPrivateMaterial(releaseNotes)) throw new Error('Release notes are empty or contain private material.');
  const acceptance = JSON.parse(await readFile(options.acceptance, 'utf8'));
  const manifestPaths = (await walkFiles(options.input)).filter((file) => file.endsWith('-artifacts.json'));
  if (manifestPaths.length !== 4) throw new Error(`Expected exactly four private artifact manifests, found ${manifestPaths.length}.`);
  const manifests = await Promise.all(manifestPaths.map(async (manifestPath) => ({
    manifestPath,
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
  })));
  const sourceCommits = new Set(manifests.map((item) => item.manifest.commit));
  if (sourceCommits.size !== 1) throw new Error('All release candidates must use the same full source commit.');
  const seen = new Set();
  const [commit] = sourceCommits;
  const candidates = [];
  const allowedInputFiles = new Set(manifestPaths.map(resolvePath));
  for (const item of manifests) {
    const { manifest } = item;
    const key = `${manifest.target}/${manifest.variant}`;
    if (!combinationKeys.has(key) || seen.has(key)) throw new Error(`Unexpected or duplicate release combination ${key}.`);
    seen.add(key);
    validateManifestIdentity(manifest, expectedVersion, key);
    const directory = path.dirname(item.manifestPath);
    const artifacts = [];
    for (const declared of manifest.artifacts) {
      const basename = assertBasename(declared.path);
      const artifactPath = path.join(directory, basename);
      const actual = await describeFile(artifactPath);
      if (actual.bytes !== declared.bytes || actual.sha256 !== declared.sha256) throw new Error(`Artifact bytes do not match private manifest: ${basename}.`);
      allowedInputFiles.add(resolvePath(artifactPath));
      artifacts.push({ basename, path: artifactPath, ...actual });
    }
    validateArtifactInventory(manifest, artifacts);
    await validateUpdateMetadata(manifest, artifacts);
    const acceptanceRecord = await validateAcceptance(acceptance, options.acceptance, manifest, key);
    const inspect = dependencies.inspectPackagedPayload ?? inspectPackagedPayload;
    const primary = artifacts.find((artifact) => manifest.target === 'darwin-arm64' ? artifact.basename.endsWith('.zip') : artifact.basename.endsWith('.exe'));
    if (!primary) throw new Error(`Missing primary update payload for ${key}.`);
    const inspected = await inspect(primary.path, manifest.target, manifest.packageIdentity);
    await validateInspectedIdentity(inspected, manifest);
    candidates.push({ key, manifestPath: item.manifestPath, manifest, artifacts, acceptance: acceptanceRecord, inspected });
  }
  if (seen.size !== combinationKeys.size) throw new Error('Release candidate does not contain all target and variant combinations.');
  const repositories = new Set(candidates.map((candidate) => candidate.manifest.packageIdentity.updateRepository));
  if (repositories.size !== 1) throw new Error('All release candidates must use the same packaged update repository.');
  const [updateRepository] = repositories;
  const githubRepository = githubReleaseRepository(sourceBaseUrl);
  if (githubRepository && githubRepository.toLowerCase() !== updateRepository.toLowerCase()) {
    throw new Error(`GitHub release source must match packaged update repository ${updateRepository}.`);
  }
  const allInputFiles = await walkFiles(options.input);
  const acceptanceResolved = resolvePath(options.acceptance);
  if (allInputFiles.some((file) => resolvePath(file) === acceptanceResolved)) allowedInputFiles.add(acceptanceResolved);
  const extras = allInputFiles.filter((file) => !allowedInputFiles.has(resolvePath(file)));
  if (extras.length) throw new Error(`Input contains files outside the four declared handoffs: ${extras.map((file) => path.relative(options.input, file)).join(', ')}.`);
  validateGlobalAcceptance(acceptance, commit, expectedVersion);
  return { schemaVersion: 1, version: expectedVersion, tag, commit, sourceBaseUrl, updateRepository, releaseNotes, acceptance, candidates };
}

export async function stageReleaseCandidate(plan, output) {
  await assertEmptyOrMissing(output);
  await mkdir(output, { recursive: true });
  const staged = [];
  try {
    for (const candidate of plan.candidates) {
      for (const artifact of candidate.artifacts) {
        const destination = path.join(output, artifact.basename);
        await copyFile(artifact.path, destination, constants.COPYFILE_EXCL);
        const copied = await describeFile(destination);
        if (copied.sha256 !== artifact.sha256 || copied.bytes !== artifact.bytes) throw new Error(`Staged bytes changed while copying ${artifact.basename}.`);
        staged.push({ name: artifact.basename, ...copied, kind: artifact.basename.endsWith('-update.yml') ? 'update-metadata' : 'payload' });
      }
      const publicName = `XR-Collector-${plan.version}-${candidate.manifest.variant}-${candidate.manifest.target}-manifest.json`;
      const publicManifest = sanitizeManifest(plan, candidate, publicName);
      const destination = path.join(output, publicName);
      await writeJson(destination, publicManifest);
      staged.push({ name: publicName, ...await describeFile(destination), kind: 'public-manifest' });
    }
    ensureUniqueNames(staged.map((entry) => entry.name));
    const index = createReleaseIndex(plan, staged);
    await writeJson(path.join(output, 'release-index.json'), index);
    staged.push({ name: 'release-index.json', ...await describeFile(path.join(output, 'release-index.json')), kind: 'index' });
    const checksumLines = [...staged].sort((a, b) => a.name.localeCompare(b.name)).map((entry) => `${entry.sha256}  ${entry.name}`);
    await writeFile(path.join(output, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, { flag: 'wx' });
    staged.push({ name: 'SHA256SUMS', ...await describeFile(path.join(output, 'SHA256SUMS')), kind: 'checksums' });
    const state = {
      schemaVersion: 1, version: plan.version, tag: plan.tag, commit: plan.commit, sourceBaseUrl: plan.sourceBaseUrl,
      updateRepository: plan.updateRepository, releaseNotes: plan.releaseNotes,
      assets: staged.sort((a, b) => a.name.localeCompare(b.name)),
      acceptance: plan.acceptance.scenarios,
    };
    await writeJson(path.join(output, '.release-state.json'), state);
    await verifyStagedCandidate(output);
    return state;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyStagedCandidate(stageDirectory) {
  const state = JSON.parse(await readFile(path.join(stageDirectory, '.release-state.json'), 'utf8'));
  if (state.schemaVersion !== 1 || !Array.isArray(state.assets)
    || typeof state.updateRepository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(state.updateRepository)) {
    throw new Error('Staged control file schema is invalid.');
  }
  ensureUniqueNames(state.assets.map((entry) => entry.name));
  const actual = (await walkFiles(stageDirectory)).filter((file) => path.basename(file) !== '.release-state.json');
  if (actual.length !== state.assets.length) throw new Error('Staged release inventory is incomplete or contains extra public assets.');
  for (const asset of state.assets) {
    const file = path.join(stageDirectory, assertBasename(asset.name));
    const described = await describeFile(file);
    if (described.bytes !== asset.bytes || described.sha256 !== asset.sha256) throw new Error(`Staged release asset changed: ${asset.name}.`);
  }
  const sums = await readFile(path.join(stageDirectory, 'SHA256SUMS'), 'utf8');
  const expectedSums = state.assets.filter((entry) => entry.name !== 'SHA256SUMS').sort((a, b) => a.name.localeCompare(b.name)).map((asset) => `${asset.sha256}  ${asset.name}`).join('\n') + '\n';
  if (sums !== expectedSums) throw new Error('SHA256SUMS does not exactly cover the frozen public asset inventory.');
  const publicText = await Promise.all(actual.filter((file) => /\.(json|ya?ml|txt)$/u.test(file) || path.basename(file) === 'SHA256SUMS').map((file) => readFile(file, 'utf8')));
  if (publicText.some((text) => containsPrivateMaterial(text))) throw new Error('Public release metadata contains a private path or credential marker.');
  await validateFrozenPublicMetadata(stageDirectory, state);
  return state;
}

export async function inspectPackagedPayload(payload, target, packageIdentity = {
  productName: 'XR Collector', appId: 'com.moneydj.xrcollector', updateRepository: 'derektu/xr-collector',
}, inspection = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-release-inspect-'));
  try {
    const prefix = target === 'darwin-arm64' ? `${packageIdentity.productName}.app/Contents/Resources` : 'resources';
    const resources = path.join(root, ...prefix.split('/'));
    if (target === 'darwin-arm64') {
      await extractMacApplication(payload, root, packageIdentity.productName, inspection);
    } else {
      const binary = sevenZip.path7za;
      await chmod(binary, 0o755);
      const requested = [
        `${prefix}/app.asar`, `${prefix}/bin/runtime-dependencies.json`, `${prefix}/bin/meilisearch-build.json`,
        `${prefix}/bin/meilisearch.exe`, `${prefix}/bin/deno.exe`, `${prefix}/bin/yt-dlp/yt-dlp.exe`, `${prefix}/bin/vcruntime140.dll`,
      ];
      await (inspection.run ?? run)(binary, ['x', '-y', `-o${root}`, payload, ...requested], { allowMissingPatterns: true });
    }
    const asar = path.join(resources, 'app.asar');
    const packageMetadata = JSON.parse(extractFile(asar, 'package.json').toString('utf8'));
    const buildInfo = JSON.parse(extractFile(asar, 'dist/node/build-info.json').toString('utf8'));
    const dependencies = JSON.parse(await readFile(path.join(resources, 'bin/runtime-dependencies.json'), 'utf8'));
    const meilisearch = JSON.parse(await readFile(path.join(resources, 'bin/meilisearch-build.json'), 'utf8'));
    const runtimeFiles = {};
    for (const relative of [dependencies.executables.deno, dependencies.executables.ytDlp, target === 'win32-x64' ? 'meilisearch.exe' : 'meilisearch'].map(assertRelativeRuntimePath)) {
      runtimeFiles[relative] = await describeFile(path.join(resources, 'bin', relative));
    }
    const meilisearchPath = path.join(resources, 'bin', target === 'win32-x64' ? 'meilisearch.exe' : 'meilisearch');
    const binaryIdentity = inspectExecutable(await readFile(meilisearchPath));
    const crt = path.join(resources, 'bin/vcruntime140.dll');
    let windowsCrt = null;
    try { windowsCrt = await describeFile(crt); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { packageMetadata, buildInfo, dependencies, meilisearch, runtimeFiles, binaryIdentity, windowsCrt };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function extractMacApplication(payload, root, productName, dependencies = {}) {
  await (dependencies.run ?? run)('/usr/bin/ditto', ['-x', '-k', payload, root]);
  const appPath = path.join(root, `${productName}.app`);
  await (dependencies.verifyMacBundle ?? verifyMacBundleSignature)(appPath);
  return appPath;
}

async function validateInspectedIdentity(inspected, manifest) {
  const expected = { schemaVersion: 1, kind: 'packaged', version: manifest.version, commit: manifest.commit, target: manifest.target, variant: manifest.variant, sourceDirty: false };
  for (const [key, value] of Object.entries(expected)) if (inspected.buildInfo[key] !== value) throw new Error(`Packaged app.asar BuildInfo ${key} does not match ${manifest.target}/${manifest.variant}.`);
  if (JSON.stringify(inspected.buildInfo) !== JSON.stringify(manifest.buildInfo)) throw new Error('Private manifest BuildInfo differs from packaged app.asar.');
  const metadata = inspected.packageMetadata;
  const metadataProduct = metadata?.productName ?? 'XR Collector';
  const metadataAppId = metadata?.xrCollectorAppId ?? 'com.moneydj.xrcollector';
  const metadataRepository = metadata?.xrCollectorUpdateRepository ?? 'derektu/xr-collector';
  if (metadata?.name !== 'xr-collector' || metadataProduct !== manifest.packageIdentity.productName
    || metadataAppId !== manifest.packageIdentity.appId || metadataRepository !== manifest.packageIdentity.updateRepository) {
    throw new Error('Packaged app.asar identity differs from the private manifest.');
  }
  if (JSON.stringify(inspected.dependencies) !== JSON.stringify(manifest.runtimeIdentity?.dependencies)) throw new Error('Packaged runtime dependency inventory differs from the private manifest.');
  if (JSON.stringify(inspected.meilisearch) !== JSON.stringify(manifest.runtimeIdentity?.meilisearch)) throw new Error('Packaged Meilisearch producer identity differs from the private manifest.');
  const dependencyPins = JSON.parse(await readFile(path.join(projectRoot, 'scripts/runtime-dependency-pins.json'), 'utf8'));
  const targetPins = dependencyPins.targets[manifest.target];
  for (const name of ['ytDlp', 'deno']) {
    const actual = inspected.dependencies.dependencies[name];
    const pin = targetPins[name];
    if (actual.version !== pin.version || actual.url !== pin.url || actual.archiveSha256 !== pin.sha256) throw new Error(`Packaged ${name} producer does not match repository pins.`);
  }
  for (const [relative, actual] of Object.entries(inspected.runtimeFiles)) {
    const expectedFile = relative.startsWith('meilisearch') ? inspected.meilisearch.binary : inspected.dependencies.files.find((file) => file.path === relative);
    if (!expectedFile || expectedFile.bytes !== actual.bytes || expectedFile.sha256 !== actual.sha256) throw new Error(`Packaged runtime bytes do not match inventory: ${relative}.`);
  }
  if (inspected.binaryIdentity?.format !== inspected.meilisearch.binary.format || inspected.binaryIdentity?.arch !== inspected.meilisearch.binary.arch) throw new Error('Packaged Meilisearch executable architecture differs from its producer manifest.');
  if (manifest.variant === 'official') {
    const pins = await readRuntimePins();
    if (JSON.stringify(inspected.meilisearch) !== JSON.stringify(expectedOfficialManifest(pins, manifest.target))) throw new Error('Official Meilisearch identity does not match repository pins.');
  } else {
    const recipe = JSON.parse(await readFile(path.join(projectRoot, 'scripts/meilisearch-build-recipe.json'), 'utf8'));
    const expectedChinese = { schemaVersion: recipe.schemaVersion, recipeRevision: recipe.recipeRevision, sourceRepository: recipe.repository, sourceTag: recipe.tag, sourceCommit: recipe.sourceCommit, cargoLockSha256: recipe.cargoLockSha256, features: recipe.features, defaultFeatures: recipe.defaultFeatures, target: manifest.target };
    for (const [key, value] of Object.entries(expectedChinese)) if (JSON.stringify(inspected.meilisearch[key]) !== JSON.stringify(value)) throw new Error(`Chinese Meilisearch ${key} does not match the trusted recipe.`);
    if (inspected.meilisearch.binary.version !== recipe.meilisearchVersion || inspected.meilisearch.binary.versionOutput !== `meilisearch ${recipe.meilisearchVersion}`) throw new Error('Chinese Meilisearch version does not match the trusted recipe.');
  }
  const expectedCrt = manifest.target === 'win32-x64' && manifest.variant === 'official' ? dependencyPins.officialWindowsCrt : null;
  if (expectedCrt) {
    if (!inspected.windowsCrt || inspected.windowsCrt.bytes !== expectedCrt.bytes || inspected.windowsCrt.sha256 !== expectedCrt.sha256) throw new Error('Official Windows app-local CRT does not match its repository pin.');
  } else if (inspected.windowsCrt) throw new Error('Only the official Windows payload may contain vcruntime140.dll.');
}

function validateManifestIdentity(manifest, version, key) {
  if (manifest.schemaVersion !== 1 || manifest.version !== version) throw new Error(`Private manifest version is invalid for ${key}.`);
  if (!/^[0-9a-f]{40}$/u.test(manifest.commit)) throw new Error(`Private manifest must contain a full source commit for ${key}.`);
  const build = manifest.buildInfo;
  for (const [field, expected] of Object.entries({ schemaVersion: 1, kind: 'packaged', version, commit: manifest.commit, target: manifest.target, variant: manifest.variant, sourceDirty: false })) {
    if (build?.[field] !== expected) throw new Error(`Private manifest BuildInfo ${field} is invalid for ${key}.`);
  }
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error(`Private manifest has no artifacts for ${key}.`);
  const identity = manifest.packageIdentity;
  if (!identity || typeof identity.productName !== 'string' || typeof identity.appId !== 'string'
    || typeof identity.updateRepository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity.updateRepository)) {
    throw new Error(`Private manifest package identity is invalid for ${key}.`);
  }
  const production = identity.updateRepository === 'derektu/xr-collector';
  const expectedProduct = production ? 'XR Collector' : `XR Update Verify ${manifest.variant === 'chinese' ? 'Chinese' : 'Official'}`;
  const expectedAppId = production ? 'com.moneydj.xrcollector' : `com.xrcollector.verify.public.${manifest.variant}`;
  if (identity.productName !== expectedProduct || identity.appId !== expectedAppId) throw new Error(`Private manifest product identity is invalid for ${key}.`);
}

function validateArtifactInventory(manifest, artifacts) {
  const expected = artifactBasenames(manifest.version, manifest.target, manifest.variant);
  const names = artifacts.map((entry) => entry.basename).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected.sort())) throw new Error(`Artifact inventory is missing, mixed, or contains unexpected names for ${manifest.target}/${manifest.variant}.`);
}

function artifactBasenames(version, target, variant) {
  const base = `XR-Collector-${version}-${variant}`;
  return target === 'darwin-arm64'
    ? [`${base}-mac-arm64.dmg`, `${base}-mac-arm64.dmg.blockmap`, `${base}-mac-arm64.zip`, `${base}-mac-arm64.zip.blockmap`, `${base}-darwin-arm64-update.yml`]
    : [`${base}-win-x64-setup.exe`, `${base}-win-x64-setup.exe.blockmap`, `${base}-win32-x64-update.yml`];
}

async function validateUpdateMetadata(manifest, artifacts) {
  const metadata = artifacts.find((entry) => entry.basename.endsWith('-update.yml'));
  const primary = artifacts.find((entry) => manifest.target === 'darwin-arm64' ? entry.basename.endsWith('.zip') : entry.basename.endsWith('.exe'));
  const parsed = parseYaml(await readFile(metadata.path, 'utf8'));
  if (!parsed || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(['files', 'path', 'releaseDate', 'sha512', 'version'])) throw new Error(`Update metadata has unexpected fields for ${manifest.target}/${manifest.variant}.`);
  if (!Array.isArray(parsed.files) || parsed.files.length !== 1 || JSON.stringify(Object.keys(parsed.files[0]).sort()) !== JSON.stringify(['sha512', 'size', 'url'])) throw new Error(`Update metadata file inventory is invalid for ${manifest.target}/${manifest.variant}.`);
  const expected512 = await digestFile(primary.path, 'sha512', 'base64');
  if (parsed.version !== manifest.version || parsed.path !== primary.basename || parsed.sha512 !== expected512) throw new Error(`Update metadata identity is invalid for ${manifest.target}/${manifest.variant}.`);
  if (!Array.isArray(parsed.files) || parsed.files.length !== 1 || parsed.files[0].url !== primary.basename || parsed.files[0].size !== primary.bytes || parsed.files[0].sha512 !== expected512) throw new Error(`Update metadata payload does not match ${primary.basename}.`);
}

async function validateAcceptance(index, indexPath, manifest, key) {
  if (index.schemaVersion !== 1 || !Array.isArray(index.candidates)) throw new Error('Acceptance index schema is invalid.');
  const records = index.candidates.filter((entry) => `${entry.target}/${entry.variant}` === key);
  if (records.length !== 1 || records[0].status !== 'passed' || !Array.isArray(records[0].evidence) || records[0].evidence.length === 0) throw new Error(`Acceptance is missing or not passed for ${key}.`);
  let summaryCount = 0;
  for (const evidence of records[0].evidence) {
    if (evidence.commit !== manifest.commit || !/^[0-9a-f]{64}$/u.test(evidence.sha256)) throw new Error(`Acceptance evidence identity is invalid for ${key}.`);
    const evidencePath = path.resolve(path.dirname(indexPath), evidence.path);
    if (await digestFile(evidencePath, 'sha256', 'hex') !== evidence.sha256) throw new Error(`Acceptance evidence checksum is invalid for ${key}.`);
    if (evidence.kind === 'acceptance-summary') {
      summaryCount += 1;
      const summary = JSON.parse(await readFile(evidencePath, 'utf8'));
      validateAcceptanceSummary(summary, manifest, key);
    }
  }
  if (summaryCount === 0) throw new Error(`Acceptance for ${key} must include a structured acceptance summary.`);
  return records[0];
}

function validateAcceptanceSummary(summary, manifest, key) {
  if (summary?.schemaVersion !== 1 || summary.kind !== 'xr-collector-release-acceptance') throw new Error(`Acceptance summary schema is invalid for ${key}.`);
  if (summary.status !== 'passed') throw new Error(`Acceptance summary did not pass for ${key}.`);
  if (!isDeepStrictEqual(summary.buildInfo, manifest.buildInfo)) throw new Error(`Acceptance summary BuildInfo does not match the packaged candidate for ${key}.`);
  if (!Array.isArray(summary.checks) || summary.checks.length === 0 || summary.checks.some((check) => typeof check?.id !== 'string' || !check.id.trim() || check.status !== 'passed')) {
    throw new Error(`Acceptance summary must contain successful checks for ${key}.`);
  }
  if (summary.screenshots !== undefined && (!Array.isArray(summary.screenshots) || summary.screenshots.some((item) => typeof item !== 'string' || !item.trim()))) {
    throw new Error(`Acceptance summary screenshots are invalid for ${key}.`);
  }
}

function validateGlobalAcceptance(index, commit, version) {
  if (index.commit !== commit || index.version !== version) throw new Error('Acceptance index source identity does not match the release candidate.');
  if (!index.scenarios || typeof index.scenarios !== 'object') throw new Error('Acceptance index must state each R35 scenario explicitly.');
  for (const id of ['R35-01', 'R35-02', 'R35-03', 'R35-04', 'R35-05', 'R35-06', 'R35-07', 'R35-08']) {
    if (!['passed', 'pending', 'blocked'].includes(index.scenarios[id]?.status)) throw new Error(`Acceptance scenario ${id} has no explicit status.`);
  }
}

async function validateFrozenPublicMetadata(stageDirectory, state) {
  const index = JSON.parse(await readFile(path.join(stageDirectory, 'release-index.json'), 'utf8'));
  const identityMatches = index.schemaVersion === 1
    && index.version === state.version
    && index.tag === state.tag
    && index.commit === state.commit
    && index.releaseNotes === state.releaseNotes
    && index.source?.id === 'github-releases'
    && index.source.baseUrl === state.sourceBaseUrl;
  if (!identityMatches) throw new Error('The staged control file identity disagrees with the frozen public metadata.');
  const normalizedSource = normalizeSourceBaseUrl(state.sourceBaseUrl, state.tag);
  if (normalizedSource !== state.sourceBaseUrl) throw new Error('Staged control file source URL is not canonical.');
  const githubRepository = githubReleaseRepository(state.sourceBaseUrl);
  if (githubRepository && githubRepository.toLowerCase() !== state.updateRepository?.toLowerCase()) throw new Error('Staged source repository differs from the packaged update repository.');
  if (index.checksums !== assetUrl(state.sourceBaseUrl, 'SHA256SUMS')) throw new Error('The release index checksum reference is invalid.');
  if (!Array.isArray(index.candidates) || index.candidates.length !== combinationKeys.size) throw new Error('The release index must contain exactly four candidates.');

  const stateByName = new Map(state.assets.map((asset) => [asset.name, asset]));
  const expectedNames = new Set(['release-index.json', 'SHA256SUMS']);
  const seen = new Set();
  for (const [target, variant] of combinations) {
    const key = `${target}/${variant}`;
    const matches = index.candidates.filter((candidate) => `${candidate.target}/${candidate.variant}` === key);
    if (matches.length !== 1 || seen.has(key)) throw new Error(`The release index candidate inventory is invalid for ${key}.`);
    seen.add(key);
    const candidate = matches[0];
    if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(['installer', 'manifest', 'target', 'updateMetadata', 'updatePayload', 'variant'])) {
      throw new Error(`The release index candidate fields are invalid for ${key}.`);
    }
    const artifacts = artifactBasenames(state.version, target, variant);
    const manifestName = `XR-Collector-${state.version}-${variant}-${target}-manifest.json`;
    for (const name of [...artifacts, manifestName]) expectedNames.add(name);
    const installerName = target === 'darwin-arm64' ? `XR-Collector-${state.version}-${variant}-mac-arm64.dmg` : `XR-Collector-${state.version}-${variant}-win-x64-setup.exe`;
    const updatePayloadName = target === 'darwin-arm64' ? `XR-Collector-${state.version}-${variant}-mac-arm64.zip` : installerName;
    const updateMetadataName = `XR-Collector-${state.version}-${variant}-${target}-update.yml`;
    assertIndexedAsset(candidate.installer, stateByName, state.sourceBaseUrl, installerName, `installer for ${key}`);
    assertIndexedAsset(candidate.updatePayload, stateByName, state.sourceBaseUrl, updatePayloadName, `update payload for ${key}`);
    assertIndexedAsset(candidate.updateMetadata, stateByName, state.sourceBaseUrl, updateMetadataName, `update metadata for ${key}`);
    assertIndexedAsset(candidate.manifest, stateByName, state.sourceBaseUrl, manifestName, `manifest reference for ${key}`);

    const publicManifest = JSON.parse(await readFile(path.join(stageDirectory, manifestName), 'utf8'));
    const manifestIdentity = { schemaVersion: 1, version: state.version, tag: state.tag, commit: state.commit, target, variant };
    for (const [field, expected] of Object.entries(manifestIdentity)) if (publicManifest[field] !== expected) throw new Error(`Public manifest ${field} is invalid for ${key}.`);
    if (publicManifest.url !== assetUrl(state.sourceBaseUrl, manifestName)) throw new Error(`Public manifest URL is invalid for ${key}.`);
    for (const [field, expected] of Object.entries({ version: state.version, commit: state.commit, target, variant, sourceDirty: false })) {
      if (publicManifest.buildInfo?.[field] !== expected) throw new Error(`Public manifest BuildInfo ${field} is invalid for ${key}.`);
    }
    if (!Array.isArray(publicManifest.artifacts) || publicManifest.artifacts.length !== artifacts.length) throw new Error(`Public manifest artifact inventory is invalid for ${key}.`);
    const actualArtifacts = [...publicManifest.artifacts].sort((a, b) => a.name.localeCompare(b.name));
    const expectedArtifacts = artifacts.map((name) => publicAssetDescriptor(stateByName, state.sourceBaseUrl, name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!isDeepStrictEqual(actualArtifacts, expectedArtifacts)) throw new Error(`Public manifest artifact references are invalid for ${key}.`);
  }
  const actualNames = [...stateByName.keys()].sort();
  if (!isDeepStrictEqual(actualNames, [...expectedNames].sort())) throw new Error('The staged control file inventory disagrees with the release index candidate inventory.');
}

function assertIndexedAsset(actual, stateByName, baseUrl, expectedName, label) {
  const expected = publicAssetDescriptor(stateByName, baseUrl, expectedName);
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Release index ${label} is invalid.`);
}

function publicAssetDescriptor(stateByName, baseUrl, name) {
  const asset = stateByName.get(name);
  if (!asset) throw new Error(`Frozen public inventory does not contain ${name}.`);
  return { name, bytes: asset.bytes, sha256: asset.sha256, url: assetUrl(baseUrl, name) };
}

function sanitizeManifest(plan, candidate, publicName) {
  const source = candidate.manifest;
  const safeSigning = {
    policy: source.signing?.policy ?? 'unknown',
    credentialDiscovery: source.signing?.credentialDiscovery === true,
    kind: typeof source.signing?.actualVerification === 'object' ? source.signing.actualVerification.kind ?? 'unknown' : source.signing?.actualVerification ?? 'unknown',
    notarization: typeof source.signing?.actualVerification === 'object' ? source.signing.actualVerification.notarization ?? 'unknown' : 'unknown',
    gatekeeperDownload: typeof source.signing?.actualVerification === 'object' ? source.signing.actualVerification.gatekeeperDownload ?? 'unknown' : 'unknown',
  };
  return {
    schemaVersion: 1, version: plan.version, tag: plan.tag, commit: plan.commit, target: source.target, variant: source.variant,
    buildInfo: source.buildInfo, builderHost: source.builderHost, toolVersions: source.toolVersions, signing: safeSigning,
    runtimeIdentity: sanitizeRuntimeIdentity(source.runtimeIdentity),
    artifacts: candidate.artifacts.map((artifact) => ({ name: artifact.basename, bytes: artifact.bytes, sha256: artifact.sha256, url: assetUrl(plan.sourceBaseUrl, artifact.basename) })),
    acceptance: { status: candidate.acceptance.status, pending: Object.entries(plan.acceptance.scenarios).filter(([, value]) => value.status !== 'passed').map(([id, value]) => ({ id, status: value.status, reason: value.reason ?? null })) },
    url: assetUrl(plan.sourceBaseUrl, publicName),
  };
}

function sanitizeRuntimeIdentity(identity) {
  const dependencies = identity?.dependencies;
  const meilisearch = identity?.meilisearch;
  const windowsCrt = identity?.windowsCrt;
  return {
    dependencies: dependencies ? {
      schemaVersion: dependencies.schemaVersion,
      target: dependencies.target,
      dependencies: Object.fromEntries(['ytDlp', 'deno'].filter((name) => dependencies.dependencies?.[name]).map((name) => [name, {
        version: dependencies.dependencies[name].version,
        url: dependencies.dependencies[name].url,
        archiveSha256: dependencies.dependencies[name].archiveSha256,
      }])),
      executables: { ytDlp: dependencies.executables?.ytDlp, deno: dependencies.executables?.deno },
      files: Array.isArray(dependencies.files) ? dependencies.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) : [],
    } : null,
    meilisearch: meilisearch ? {
      ...pick(meilisearch, ['schemaVersion', 'distribution', 'recipeRevision', 'recipeFingerprint', 'sourceRepository', 'sourceTag', 'sourceCommit', 'cargoLockSha256', 'features', 'defaultFeatures', 'releaseRepository', 'releaseTag', 'releaseAsset', 'releaseUrl', 'target']),
      binary: meilisearch.binary ? pick(meilisearch.binary, ['version', 'versionOutput', 'bytes', 'sha256', 'format', 'arch']) : null,
    } : null,
    windowsCrt: windowsCrt ? pick(windowsCrt, ['fileName', 'bytes', 'sha256', 'fileVersion']) : null,
  };
}

function pick(source, keys) { return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])); }

function createReleaseIndex(plan, assets) {
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  return {
    schemaVersion: 1, version: plan.version, tag: plan.tag, commit: plan.commit, releaseNotes: plan.releaseNotes,
    source: { id: 'github-releases', baseUrl: plan.sourceBaseUrl },
    checksums: assetUrl(plan.sourceBaseUrl, 'SHA256SUMS'),
    candidates: plan.candidates.map((candidate) => {
      const base = `XR-Collector-${plan.version}-${candidate.manifest.variant}`;
      const metadata = `${base}-${candidate.manifest.target}-update.yml`;
      const installer = candidate.manifest.target === 'darwin-arm64' ? `${base}-mac-arm64.dmg` : `${base}-win-x64-setup.exe`;
      const updatePayload = candidate.manifest.target === 'darwin-arm64' ? `${base}-mac-arm64.zip` : installer;
      const publicManifest = `${base}-${candidate.manifest.target}-manifest.json`;
      for (const name of [metadata, installer, updatePayload, publicManifest]) if (!byName.has(name)) throw new Error(`Release index cannot find ${name}.`);
      return {
        target: candidate.manifest.target, variant: candidate.manifest.variant,
        installer: describeIndexedAsset(byName.get(installer), plan.sourceBaseUrl),
        updatePayload: describeIndexedAsset(byName.get(updatePayload), plan.sourceBaseUrl),
        updateMetadata: describeIndexedAsset(byName.get(metadata), plan.sourceBaseUrl),
        manifest: describeIndexedAsset(byName.get(publicManifest), plan.sourceBaseUrl),
      };
    }),
  };
}

function describeIndexedAsset(asset, baseUrl) { return { name: asset.name, bytes: asset.bytes, sha256: asset.sha256, url: assetUrl(baseUrl, asset.name) }; }
function normalizeSourceBaseUrl(value, tag) {
  const url = new URL(value ?? `https://github.com/derektu/xr-collector/releases/download/${tag}/`);
  if (url.protocol !== 'https:') throw new Error('Release source base URL must use HTTPS.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Release source base URL must not contain credentials, query parameters, or a fragment.');
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments.includes('latest') || (!segments.includes(tag) && !segments.includes(tag.slice(1)))) throw new Error(`Release source base URL must be pinned to ${tag}.`);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}
function githubReleaseRepository(value) {
  const url = new URL(value);
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments.length < 5 || segments[2] !== 'releases' || segments[3] !== 'download') {
    throw new Error('GitHub release source URL must use owner/repository/releases/download/tag/.');
  }
  return `${segments[0]}/${segments[1]}`;
}
function assetUrl(base, name) { return new URL(encodeURIComponent(assertBasename(name)), base).toString(); }
function assertBasename(value) { if (typeof value !== 'string' || path.basename(value) !== value || value === '.' || value === '..') throw new Error(`Unsafe release asset name ${value}.`); return value; }
function assertRelativeRuntimePath(value) { if (typeof value !== 'string' || path.isAbsolute(value) || value.split(/[\\/]/u).some((part) => part === '..' || part === '')) throw new Error(`Unsafe packaged runtime path ${value}.`); return value; }
function ensureUniqueNames(names) { if (new Set(names).size !== names.length) throw new Error('Release asset basenames must be globally unique.'); }
function containsPrivateMaterial(text) { return /(?:\/Users\/|\/home\/|[A-Za-z]:\\|\.local\/ticket-artifacts|gh[pousr]_[A-Za-z0-9_]+|GITHUB_TOKEN|GH_TOKEN)/u.test(text); }
function resolvePath(value) { return path.resolve(value); }
async function assertEmptyOrMissing(directory) { try { if ((await readdir(directory)).length) throw new Error(`Stage directory must be empty: ${directory}.`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function writeJson(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
async function describeFile(file) { const info = await stat(file); return { bytes: info.size, sha256: await digestFile(file, 'sha256', 'hex') }; }
async function digestFile(file, algorithm, encoding) { const hash = createHash(algorithm); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest(encoding); }
async function walkFiles(root) { const result = []; for (const entry of await readdir(root, { withFileTypes: true })) { const child = path.join(root, entry.name); if (entry.isDirectory()) result.push(...await walkFiles(child)); else if (entry.isFile()) result.push(child); } return result; }
async function run(command, args, options = {}) { const { spawn } = await import('node:child_process'); await new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk.toString(); }); child.once('error', reject); child.once('exit', (code) => code === 0 || (options.allowMissingPatterns && code === 1 && /No files to process/u.test(stderr)) ? resolve() : reject(new Error(`Archive inspection failed (${code}): ${stderr.trim()}`))); }); }
