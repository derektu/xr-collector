import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import plist from 'plist';
import { prepareRuntimeDependencies, verifyRuntimeDependencyInstallation } from './runtime-dependencies.mjs';

export const DEVELOPER_ID_POLICY = 'developer-id-notarized';
export const RUNTIME_SIGNING_MANIFEST = 'runtime-signing.json';
export const DENO_TEAM_ID = '2H4KBF436B';
export const DENO_ENTITLEMENTS = [
  'com.apple.security.cs.allow-dyld-environment-variables', 'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.cs.disable-library-validation',
];
const KEYCHAIN_SEARCH_LOCK = path.join(tmpdir(), 'xr-collector-mac-keychain-search.lock');

const ENV_KEYS = new Set(['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_TEAM_ID']);

export async function loadMacSigningConfiguration({ environmentFile, pathRoot }, dependencies = {}) {
  if (!path.isAbsolute(environmentFile ?? '') || !path.isAbsolute(pathRoot ?? '')) {
    throw new Error('Developer ID signing requires absolute --mac-signing-env and --mac-signing-root paths.');
  }
  const real = dependencies.realpath ?? realpath;
  const inspect = dependencies.stat ?? stat;
  const load = dependencies.readFile ?? readFile;
  const root = await real(pathRoot);
  const envPath = await real(environmentFile);
  assertInside(root, envPath, 'signing environment file');
  assertProtectedFile(await inspect(envPath), 'signing environment file');
  const values = parseProtectedEnvironment(await load(envPath, 'utf8'));
  const required = [...ENV_KEYS];
  for (const key of required) if (!values[key]) throw new Error(`Signing environment is missing ${key}.`);
  if (!/^[A-Z0-9]{10}$/u.test(values.APPLE_TEAM_ID)) throw new Error('Signing environment APPLE_TEAM_ID is invalid.');
  if (!/^[A-Z0-9]{10}$/u.test(values.APPLE_API_KEY_ID)) throw new Error('Signing environment APPLE_API_KEY_ID is invalid.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(values.APPLE_API_ISSUER)) {
    throw new Error('Signing environment APPLE_API_ISSUER is invalid.');
  }
  const certificatePath = await resolveProtectedCredential(root, values.CSC_LINK, 'CSC_LINK', { real, inspect });
  const apiKeyPath = await resolveProtectedCredential(root, values.APPLE_API_KEY, 'APPLE_API_KEY', { real, inspect });
  return {
    policy: DEVELOPER_ID_POLICY,
    root,
    environmentFile: envPath,
    certificatePath,
    certificatePassword: values.CSC_KEY_PASSWORD,
    teamId: values.APPLE_TEAM_ID,
    notary: { apiKeyPath, keyId: values.APPLE_API_KEY_ID, issuer: values.APPLE_API_ISSUER, teamId: values.APPLE_TEAM_ID },
  };
}

export function parseProtectedEnvironment(source) {
  const result = {};
  for (const [lineIndex, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error(`Signing environment line ${lineIndex + 1} is invalid.`);
    const [, key, encoded] = match;
    if (!ENV_KEYS.has(key)) throw new Error(`Signing environment contains unsupported key ${key}.`);
    if (Object.hasOwn(result, key)) throw new Error(`Signing environment repeats ${key}.`);
    result[key] = decodeEnvironmentValue(encoded.trim(), lineIndex + 1);
  }
  return result;
}

export async function withTemporarySigningKeychain(configuration, work, dependencies = {}) {
  const run = dependencies.run ?? runCaptured;
  const makeTemp = dependencies.mkdtemp ?? mkdtemp;
  const remove = dependencies.rm ?? rm;
  const password = (dependencies.randomPassword ?? (() => randomBytes(32).toString('base64url')))();
  const directory = await makeTemp(path.join(tmpdir(), 'xr-mac-signing-'));
  const keychain = path.join(directory, 'signing.keychain-db');
  let created = false;
  let primaryError;
  try {
    await run('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
    created = true;
    await run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain]);
    await run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
    await run('/usr/bin/security', ['import', configuration.certificatePath, '-k', keychain, '-P', configuration.certificatePassword,
      '-T', '/usr/bin/codesign', '-T', '/usr/bin/productbuild', '-T', '/usr/bin/security']);
    await run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
    await withKeychainSearchLock(async () => {
      const userKeychains = parseUserKeychainList((await run('/usr/bin/security', ['list-keychains', '-d', 'user'])).stdout);
      if (userKeychains.includes(keychain)) throw new Error('Owned signing keychain unexpectedly already exists in the user search list.');
      await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...userKeychains, keychain]);
      const activeKeychains = parseUserKeychainList((await run('/usr/bin/security', ['list-keychains', '-d', 'user'])).stdout);
      if (!userKeychains.every((entry, index) => activeKeychains[index] === entry)
        || activeKeychains.filter((entry) => entry === keychain).length !== 1 || activeKeychains.indexOf(keychain) < userKeychains.length) {
        throw new Error('Temporary signing keychain was not appended without reordering the existing user search list.');
      }
    }, dependencies);
    const identities = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
    const identity = selectDeveloperIdIdentity(identities.stdout, configuration.teamId);
    return await work({ keychain, identity });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try {
      if (created) await withKeychainSearchLock(() => run('/usr/bin/security', ['delete-keychain', keychain]), dependencies);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
      try {
        await withKeychainSearchLock(async () => {
          const current = parseUserKeychainList((await run('/usr/bin/security', ['list-keychains', '-d', 'user'])).stdout);
          if (current.includes(keychain)) {
            await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...current.filter((entry) => entry !== keychain)]);
            const remaining = parseUserKeychainList((await run('/usr/bin/security', ['list-keychains', '-d', 'user'])).stdout);
            if (remaining.includes(keychain)) throw new Error('Owned signing keychain remains in the user search list after cleanup fallback.');
          }
        }, dependencies);
      } catch (fallbackError) { cleanupErrors.push(fallbackError); }
    }
    try { await remove(directory, { recursive: true, force: true }); }
    catch (removeError) { cleanupErrors.push(removeError); }
    if (cleanupErrors.length > 0) {
      const cleanupFailure = cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, 'Temporary signing keychain cleanup failed.');
      if (primaryError) throw new AggregateError([primaryError, cleanupFailure], 'Signing failed and its temporary keychain cleanup also failed.');
      throw cleanupFailure;
    }
  }
}

export function selectDeveloperIdIdentity(output, expectedTeamId) {
  const identities = output.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: .+ \(([A-Z0-9]{10})\))"/u.exec(line);
    return match ? [{ sha1: match[1], name: match[2], teamId: match[3] }] : [];
  }).filter((identity) => identity.teamId === expectedTeamId);
  if (identities.length !== 1) throw new Error(`Temporary keychain must contain exactly one Developer ID Application identity for Team ${expectedTeamId}; found ${identities.length}.`);
  return identities[0];
}

export function parseUserKeychainList(output) {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const result = lines.map((line) => {
    if (!line.startsWith('"') || !line.endsWith('"')) throw new Error('security list-keychains returned an unexpected entry.');
    try { return JSON.parse(line); } catch (error) { throw new Error('security list-keychains returned an invalid quoted path.', { cause: error }); }
  });
  if (new Set(result).size !== result.length || result.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))) {
    throw new Error('security list-keychains returned duplicate or non-absolute entries.');
  }
  return result;
}

export function signedBuilderEnvironment(base, { keychain, identity, teamId, sourceRoot }) {
  return {
    ...base,
    CSC_KEYCHAIN: keychain,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    XR_MAC_SIGNING_IDENTITY_SHA1: identity.sha1,
    XR_MAC_SIGNING_TEAM_ID: teamId,
    XR_MAC_SIGNING_SOURCE_ROOT: sourceRoot,
  };
}

export async function signStagedMacRuntimes({ appPath, sourceBin, identitySha1, expectedTeamId, keychain }, dependencies = {}) {
  const run = dependencies.run ?? runCaptured;
  const bin = path.join(appPath, 'Contents/Resources/bin');
  const dependencyManifestPath = path.join(bin, 'runtime-dependencies.json');
  const sourceDependencyManifestPath = path.join(sourceBin, 'runtime-dependencies.json');
  const meiliManifestPath = path.join(bin, 'meilisearch-build.json');
  const sourceMeiliManifestPath = path.join(sourceBin, 'meilisearch-build.json');
  const [dependencyManifest, sourceDependencyManifest, meiliManifest, sourceMeiliManifest] = await Promise.all([
    readJson(dependencyManifestPath), readJson(sourceDependencyManifestPath), readJson(meiliManifestPath), readJson(sourceMeiliManifestPath),
  ]);
  const reconstructed = await (dependencies.mkdtemp ?? mkdtemp)(path.join(tmpdir(), 'xr-runtime-provenance-'));
  try {
    await (dependencies.prepareRuntimeDependencies ?? prepareRuntimeDependencies)({ target: 'darwin-arm64', outputDir: reconstructed });
    const reconstructedManifest = await readJson(path.join(reconstructed, 'runtime-dependencies.json'));
    if (JSON.stringify(dependencyManifest) !== JSON.stringify(reconstructedManifest)
      || JSON.stringify(sourceDependencyManifest) !== JSON.stringify(reconstructedManifest)
      || !await verifyRuntimeDependencyInstallation(reconstructed, reconstructedManifest)
      || !await verifyRuntimeDependencyInstallation(bin, dependencyManifest)
      || !await verifyRuntimeDependencyInstallation(sourceBin, sourceDependencyManifest)) {
      throw new Error('Staged runtime dependencies do not match an independent extraction of the hash-pinned archives.');
    }
  } finally {
    await (dependencies.rm ?? rm)(reconstructed, { recursive: true, force: true });
  }
  if (JSON.stringify(meiliManifest) !== JSON.stringify(sourceMeiliManifest)) throw new Error('Staged Meilisearch manifest does not match the raw producer identity.');
  const stagedMeili = path.join(bin, 'meilisearch');
  const sourceMeili = path.join(sourceBin, 'meilisearch');
  const stagedHelper = path.join(bin, 'xr-mac-update-helper');
  const sourceHelper = path.join(sourceBin, 'xr-mac-update-helper');
  for (const [staged, source, label] of [[stagedMeili, sourceMeili, 'Meilisearch'], [stagedHelper, sourceHelper, 'update helper']]) {
    if (!sameFileIdentity(await describeFile(staged), await describeFile(source))) throw new Error(`Staged ${label} does not match its raw source bytes.`);
  }
  if (!sameFileIdentity(await describeFile(stagedMeili), meiliManifest.binary)) throw new Error('Raw Meilisearch bytes do not match the producer manifest before signing.');

  await repairPythonFramework(path.join(bin, 'yt-dlp/_internal/Python.framework'));
  const denoPath = path.join(bin, dependencyManifest.executables.deno);
  const codeFiles = (await listMachOFiles(bin)).filter((file) => file !== denoPath).sort(deepestFirst);
  const signArgs = (target) => ['--force', '--sign', identitySha1, '--keychain', keychain, '--options', 'runtime', '--timestamp', target];
  for (const file of codeFiles) await run('/usr/bin/codesign', signArgs(file));
  const framework = path.join(bin, 'yt-dlp/_internal/Python.framework');
  await run('/usr/bin/codesign', signArgs(framework));

  const executableSignatures = {};
  for (const file of [...codeFiles, framework, denoPath]) {
    await run('/usr/bin/codesign', ['--verify', '--strict', file]);
    const metadata = parseCodeSignature((await run('/usr/bin/codesign', ['-dv', '--verbose=4', file])).stderr);
    const expected = file === denoPath ? DENO_TEAM_ID : expectedTeamId;
    assertDeveloperIdSignature(metadata, expected, path.relative(bin, file));
    if (file === denoPath) {
      const result = await run('/usr/bin/codesign', ['-d', '--entitlements', ':-', file]);
      metadata.entitlements = parseTrueEntitlements(`${result.stdout}\n${result.stderr}`);
      assertDenoEntitlements(metadata.entitlements);
    }
    executableSignatures[path.relative(bin, file)] = metadata;
  }
  const files = await inventoryTree(bin, new Set([RUNTIME_SIGNING_MANIFEST]));
  const meiliFinal = files.find((entry) => entry.path === 'meilisearch');
  if (!meiliFinal) throw new Error('Signed Meilisearch final identity is missing.');
  const signingManifest = {
    schemaVersion: 1,
    policy: DEVELOPER_ID_POLICY,
    expectedAppTeamId: expectedTeamId,
    sourceIdentity: {
      dependencyManifest: await describeFile(sourceDependencyManifestPath),
      meilisearchManifest: await describeFile(sourceMeiliManifestPath),
    },
    meilisearch: {
      source: { bytes: meiliManifest.binary.bytes, sha256: meiliManifest.binary.sha256 },
      final: { bytes: meiliFinal.bytes, sha256: meiliFinal.sha256 },
      signature: executableSignatures.meilisearch,
    },
    files,
    executableSignatures,
  };
  await writeFile(path.join(bin, RUNTIME_SIGNING_MANIFEST), `${JSON.stringify(signingManifest, null, 2)}\n`, { mode: 0o644 });
  return signingManifest;
}

export async function verifySignedRuntimeInventory(bin, expectedTeamId, dependencies = {}) {
  const signingManifest = await readJson(path.join(bin, RUNTIME_SIGNING_MANIFEST));
  if (signingManifest.schemaVersion !== 1 || signingManifest.policy !== DEVELOPER_ID_POLICY
    || signingManifest.expectedAppTeamId !== expectedTeamId || !Array.isArray(signingManifest.files)) {
    throw new Error('Signed runtime inventory schema or expected App Team is invalid.');
  }
  const actual = await inventoryTree(bin, new Set([RUNTIME_SIGNING_MANIFEST]));
  if (JSON.stringify(actual) !== JSON.stringify(signingManifest.files)) throw new Error('Signed runtime final bytes do not match the sealed inventory.');
  if (!sameFileIdentity(signingManifest.sourceIdentity?.dependencyManifest, await describeFile(path.join(bin, 'runtime-dependencies.json')))
    || !sameFileIdentity(signingManifest.sourceIdentity?.meilisearchManifest, await describeFile(path.join(bin, 'meilisearch-build.json')))) {
    throw new Error('Signed runtime producer manifests do not match their sealed source identities.');
  }
  const meiliManifest = await readJson(path.join(bin, 'meilisearch-build.json'));
  if (!sameFileIdentity(signingManifest.meilisearch?.source, meiliManifest.binary)) throw new Error('Signed runtime does not retain the raw Meilisearch producer identity.');
  const meili = actual.find((entry) => entry.path === 'meilisearch');
  if (!meili || !sameFileIdentity(meili, signingManifest.meilisearch?.final)) throw new Error('Signed Meilisearch bytes do not match the sealed final identity.');
  if (dependencies.verifySignatures !== false) {
    const run = dependencies.run ?? runCaptured;
    const framework = path.join(bin, 'yt-dlp/_internal/Python.framework');
    const expectedSignatures = [...await listMachOFiles(bin), framework].map((file) => path.relative(bin, file)).sort();
    const recordedSignatures = Object.keys(signingManifest.executableSignatures ?? {}).sort();
    if (JSON.stringify(recordedSignatures) !== JSON.stringify(expectedSignatures)) throw new Error('Signed runtime signature inventory does not cover every Mach-O file and the Python framework.');
    for (const [relative, recorded] of Object.entries(signingManifest.executableSignatures ?? {})) {
      const target = path.join(bin, relative);
      await run('/usr/bin/codesign', ['--verify', '--strict', target]);
      const actualSignature = parseCodeSignature((await run('/usr/bin/codesign', ['-dv', '--verbose=4', target])).stderr);
      assertDeveloperIdSignature(actualSignature, relative === 'deno' ? DENO_TEAM_ID : expectedTeamId, relative);
      if (relative === 'deno') {
        const result = await run('/usr/bin/codesign', ['-d', '--entitlements', ':-', target]);
        actualSignature.entitlements = parseTrueEntitlements(`${result.stdout}\n${result.stderr}`);
        assertDenoEntitlements(actualSignature.entitlements);
      }
      if (JSON.stringify(actualSignature) !== JSON.stringify(recorded)) throw new Error(`Runtime signature identity changed: ${relative}.`);
    }
  }
  return signingManifest;
}

export async function verifyDeveloperIdApplication(appPath, expectedTeamId, dependencies = {}) {
  const run = dependencies.run ?? runCaptured;
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const signature = parseCodeSignature((await run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath])).stderr);
  assertDeveloperIdSignature(signature, expectedTeamId, path.basename(appPath));
  await assertExactElectronEntitlements(appPath, run);
  for (const helper of await listNestedApplications(path.join(appPath, 'Contents/Frameworks'))) await assertExactElectronEntitlements(helper, run);
  const runtime = await verifySignedRuntimeInventory(path.join(appPath, 'Contents/Resources/bin'), expectedTeamId, dependencies);
  return { signature, runtime };
}

async function assertExactElectronEntitlements(target, run) {
  const result = await run('/usr/bin/codesign', ['-d', '--entitlements', ':-', target]);
  const output = `${result.stdout}\n${result.stderr}`;
  const start = output.indexOf('<?xml');
  const fallback = output.indexOf('<plist');
  const document = plist.parse(output.slice(start >= 0 ? start : fallback));
  if (JSON.stringify(document) !== JSON.stringify({ 'com.apple.security.cs.allow-jit': true })) throw new Error(`Signed Electron code has unexpected entitlements: ${target}.`);
}

async function listNestedApplications(root) {
  const result = [];
  const visit = async (directory) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.name.endsWith('.app')) result.push(absolute); else await visit(absolute);
    }
  };
  await visit(root);
  return result.sort();
}

export async function verifyDeveloperIdDiskImage(dmgPath, expectedTeamId, dependencies = {}) {
  const run = dependencies.run ?? runCaptured;
  await run('/usr/bin/codesign', ['--verify', '--strict', dmgPath]);
  const signature = parseCodeSignature((await run('/usr/bin/codesign', ['-dv', '--verbose=4', dmgPath])).stderr);
  if (signature.teamId !== expectedTeamId || !signature.authorities.some((value) => value.startsWith('Developer ID Application:'))
    || !signature.secureTimestamp) throw new Error('DMG does not have the expected timestamped Developer ID Application signature.');
  return signature;
}

export async function notarizeAndStaple({ kind, artifactPath, credentials, evidenceDirectory }, dependencies = {}) {
  if (!['app', 'dmg'].includes(kind)) throw new Error(`Unsupported notarization kind ${kind}.`);
  const run = dependencies.run ?? runCaptured;
  await mkdir(evidenceDirectory, { recursive: true });
  const completedPath = path.join(evidenceDirectory, `${kind}-completed.json`);
  const completed = await readOptionalJson(completedPath);
  if (completed?.schemaVersion === 1 && completed.kind === kind && completed.teamId === credentials.teamId
    && completed.status === 'Accepted' && completed.issues === 0 && /^[0-9a-f-]{36}$/iu.test(completed.submissionId ?? '')
    && /^[0-9a-f]{64}$/u.test(completed.logSha256 ?? '') && validNonEmptyFileIdentity(completed.submitted)
    && sameFileIdentity(completed.stapled, await describeArtifact(artifactPath))) {
    await run('/usr/bin/xcrun', ['stapler', 'validate', '-v', artifactPath]);
    const resumed = { ...completed, stapleValidated: true };
    await writeJsonAtomic(completedPath, resumed);
    return resumed;
  }
  const resumable = await resumeStapledOperation({ kind, artifactPath, credentials, evidenceDirectory, completedPath, run }, dependencies);
  if (resumable) return resumable;
  const submittedPath = kind === 'app'
    ? await preparePersistentAppUpload(artifactPath, evidenceDirectory, run)
    : artifactPath;
  const auth = ['--key', credentials.apiKeyPath, '--key-id', credentials.keyId, '--issuer', credentials.issuer];
  const submittedIdentity = await describeFile(submittedPath);
  const receiptPath = path.join(evidenceDirectory, `${kind}-${submittedIdentity.sha256}-submission.json`);
  const prior = await readOptionalJson(receiptPath);
  let submissionId;
  if (prior) {
    if (prior.schemaVersion !== 1 || prior.kind !== kind || prior.teamId !== credentials.teamId
      || !sameFileIdentity(prior.submitted, submittedIdentity) || typeof prior.submissionId !== 'string') {
      throw new Error(`Existing ${kind} notarization receipt does not match this Team and exact upload bytes.`);
    }
    if (prior.status === 'Accepted' && !prior.signedCodeIdentity) throw new Error(`Existing Accepted ${kind} receipt failed full log validation and cannot be resumed.`);
    submissionId = prior.submissionId;
  } else {
    const submitted = parseJsonOutput(await run('/usr/bin/xcrun', ['notarytool', 'submit', submittedPath, ...auth, '--output-format', 'json']), 'notarytool submit');
    if (typeof submitted.id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(submitted.id)) throw new Error('notarytool submit did not return a valid submission ID; the result is ambiguous and will not be resubmitted automatically.');
    submissionId = submitted.id;
    await writeJsonAtomic(receiptPath, {
      schemaVersion: 1, kind, teamId: credentials.teamId, submissionId, status: submitted.status ?? 'Submitted', submitted: submittedIdentity,
    });
  }
  const waited = parseJsonOutput(await run('/usr/bin/xcrun', ['notarytool', 'wait', submissionId, ...auth, '--timeout', '30m', '--output-format', 'json']), 'notarytool wait');
  const logPath = path.join(evidenceDirectory, `${kind}-${submissionId}-notary-log.json`);
  await run('/usr/bin/xcrun', ['notarytool', 'log', submissionId, ...auth, logPath]);
  const log = await readJson(logPath);
  const logIdentity = await describeFile(logPath);
  const issueCount = log.issues === null ? 0 : (Array.isArray(log.issues) ? log.issues.length : null);
  await writeJsonAtomic(receiptPath, {
    schemaVersion: 1, kind, teamId: credentials.teamId, submissionId, status: waited.status ?? log.status ?? 'Unknown',
    submitted: submittedIdentity, logSha256: logIdentity.sha256, issues: issueCount,
  });
  if (waited.id !== submissionId || waited.status !== 'Accepted' || log.jobId?.toLowerCase() !== submissionId.toLowerCase()
    || log.status !== 'Accepted' || log.sha256?.toLowerCase() !== submittedIdentity.sha256 || issueCount !== 0) {
    throw new Error(`${kind} notarization did not produce an Accepted, issue-free log for submission ${submissionId}.`);
  }
  const signedCodeIdentity = await (dependencies.describeStableCodeIdentity ?? describeStableCodeIdentity)(artifactPath, credentials.teamId, run);
  await writeJsonAtomic(receiptPath, {
    schemaVersion: 1, kind, teamId: credentials.teamId, submissionId, status: 'Accepted', submitted: submittedIdentity,
    logSha256: logIdentity.sha256, issues: 0, signedCodeIdentity,
  });
  await run('/usr/bin/xcrun', ['stapler', 'staple', '-v', artifactPath]);
  if (dependencies.afterStaple) await dependencies.afterStaple();
  const finalReceipt = {
    schemaVersion: 1, kind, teamId: credentials.teamId, submissionId, status: 'Accepted', issues: 0,
    logSha256: logIdentity.sha256, submitted: submittedIdentity, signedCodeIdentity, stapled: await describeArtifact(artifactPath), stapleValidated: false,
  };
  await writeJsonAtomic(completedPath, finalReceipt);
  await run('/usr/bin/xcrun', ['stapler', 'validate', '-v', artifactPath]);
  const validated = { ...finalReceipt, stapleValidated: true };
  await writeJsonAtomic(completedPath, validated);
  return validated;
}

async function resumeStapledOperation(input, dependencies) {
  const names = await readdir(input.evidenceDirectory);
  const receipts = [];
  for (const name of names.filter((value) => value.startsWith(`${input.kind}-`) && value.endsWith('-submission.json'))) {
    const receipt = await readOptionalJson(path.join(input.evidenceDirectory, name));
    if (receipt?.schemaVersion === 1 && receipt.kind === input.kind && receipt.teamId === input.credentials.teamId
      && receipt.status === 'Accepted' && receipt.issues === 0 && /^[0-9a-f-]{36}$/iu.test(receipt.submissionId ?? '')
      && /^[0-9a-f]{64}$/u.test(receipt.logSha256 ?? '') && validNonEmptyFileIdentity(receipt.submitted)
      && receipt.signedCodeIdentity) receipts.push(receipt);
  }
  if (receipts.length === 0) return null;
  const current = await (dependencies.describeStableCodeIdentity ?? describeStableCodeIdentity)(input.artifactPath, input.credentials.teamId, input.run);
  const matching = receipts.filter((receipt) => JSON.stringify(receipt.signedCodeIdentity) === JSON.stringify(current));
  if (matching.length > 1) throw new Error(`Ambiguous Accepted ${input.kind} notarization operations match the current signed artifact.`);
  if (matching.length === 0) return null;
  try { await input.run('/usr/bin/xcrun', ['stapler', 'validate', '-v', input.artifactPath]); }
  catch { return null; }
  const receipt = { ...matching[0], stapled: await describeArtifact(input.artifactPath), stapleValidated: true };
  await writeJsonAtomic(input.completedPath, receipt);
  return receipt;
}

async function describeStableCodeIdentity(target, expectedTeamId, run) {
  const signature = parseCodeSignature((await run('/usr/bin/codesign', ['-dv', '--verbose=4', target])).stderr);
  if (signature.teamId !== expectedTeamId || !/^[0-9a-f]{40}$/iu.test(signature.cdHash ?? '')) throw new Error('Notarization artifact lacks the expected stable signed CodeDirectory identity.');
  return { teamId: signature.teamId, cdHash: signature.cdHash.toLowerCase(), identifier: signature.identifier };
}

export async function validateNotarizedArtifact(artifactPath, kind, dependencies = {}) {
  const run = dependencies.run ?? runCaptured;
  await run('/usr/bin/xcrun', ['stapler', 'validate', '-v', artifactPath]);
  if (kind === 'app') {
    await run('/usr/bin/syspolicy_check', ['distribution', artifactPath]);
    await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', artifactPath]);
  } else if (kind === 'dmg') {
    await run('/usr/bin/codesign', ['--verify', '--strict', artifactPath]);
    await run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', artifactPath]);
  } else throw new Error(`Unsupported notarized artifact kind ${kind}.`);
}

export function parseCodeSignature(output) {
  const value = (key) => output.split(/\r?\n/u).find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
  const authorities = output.split(/\r?\n/u).filter((line) => line.startsWith('Authority=')).map((line) => line.slice('Authority='.length));
  const flags = value('CodeDirectory') ?? output.split(/\r?\n/u).find((line) => line.includes(' flags=')) ?? '';
  return {
    teamId: value('TeamIdentifier'),
    cdHash: value('CDHash'),
    identifier: value('Identifier'),
    authorities,
    hardenedRuntime: flags.includes('runtime') || value('Runtime Version') !== null,
    secureTimestamp: value('Timestamp') !== null,
  };
}

function assertDeveloperIdSignature(metadata, expectedTeamId, label) {
  if (metadata.teamId !== expectedTeamId || !metadata.authorities.some((authority) => authority.startsWith('Developer ID Application:'))
    || !metadata.hardenedRuntime || !metadata.secureTimestamp) {
    throw new Error(`${label} is not signed by the expected Developer ID Team with hardened runtime and a secure timestamp.`);
  }
}

function parseTrueEntitlements(output) {
  return [...output.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/gu)].map((match) => match[1]).sort();
}
function assertDenoEntitlements(actual) {
  if (JSON.stringify(actual) !== JSON.stringify([...DENO_ENTITLEMENTS].sort())) throw new Error('Deno vendor entitlements do not match the pinned five-key policy.');
}

async function withKeychainSearchLock(work, dependencies = {}) {
  const make = dependencies.mkdir ?? mkdir;
  const remove = dependencies.rm ?? rm;
  const token = randomBytes(16).toString('hex');
  const lockPath = dependencies.keychainSearchLock ?? KEYCHAIN_SEARCH_LOCK;
  const ownerPath = path.join(lockPath, 'owner.json');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await make(lockPath);
      await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`, { flag: 'wx', mode: 0o600 });
      break;
    }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt >= 300) throw new Error('Timed out waiting for the shared macOS keychain search-list lock.', { cause: error });
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
        if (!Number.isInteger(owner.pid) || typeof owner.token !== 'string') {
          const invalid = new Error('Invalid shared keychain search-list lock owner metadata.');
          invalid.code = 'INVALID_LOCK_OWNER';
          throw invalid;
        }
        const alive = dependencies.isProcessAlive ? dependencies.isProcessAlive(owner.pid) : (() => { try { process.kill(owner.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } })();
        if (!alive) await remove(lockPath, { recursive: true });
      } catch (ownerError) {
        if (ownerError.code !== 'ENOENT' && ownerError.code !== 'INVALID_LOCK_OWNER' && !(ownerError instanceof SyntaxError)) throw ownerError;
        const info = await stat(lockPath);
        const grace = dependencies.keychainOwnerGraceMs ?? 5_000;
        if (Date.now() - info.mtimeMs >= grace) await remove(lockPath, { recursive: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await work(); } finally {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (owner.pid !== process.pid || owner.token !== token) throw new Error('Shared keychain search-list lock ownership changed unexpectedly.');
    await remove(lockPath, { recursive: true });
  }
}

async function repairPythonFramework(framework) {
  const version = '3.14';
  const versions = path.join(framework, 'Versions');
  const versionDirectory = path.join(versions, version);
  await stat(path.join(versionDirectory, 'Python'));
  await stat(path.join(versionDirectory, 'Resources/Info.plist'));
  await rm(path.join(framework, 'Python'), { recursive: true, force: true });
  await rm(path.join(framework, 'Resources'), { recursive: true, force: true });
  await rm(path.join(versions, 'Current'), { recursive: true, force: true });
  await symlink(version, path.join(versions, 'Current'));
  await symlink('Versions/Current/Python', path.join(framework, 'Python'));
  await symlink('Versions/Current/Resources', path.join(framework, 'Resources'));
}

async function listMachOFiles(root) {
  const files = await walk(root);
  const result = [];
  for (const file of files) {
    const info = await lstat(file);
    if (!info.isFile()) continue;
    const handle = await open(file, 'r');
    try {
      const header = Buffer.alloc(8);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (isMachO(header.subarray(0, bytesRead))) result.push(file);
    } finally { await handle.close(); }
  }
  return result;
}

function isMachO(buffer) {
  if (buffer.length < 4) return false;
  const little = buffer.readUInt32LE(0);
  const big = buffer.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(little)
    || [0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(big);
}

async function inventoryTree(root, excluded = new Set()) {
  const entries = [];
  for (const absolute of await walk(root, true)) {
    const relative = path.relative(root, absolute);
    if (!relative || excluded.has(relative)) continue;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) entries.push({ path: relative, type: 'symlink', target: await readlink(absolute) });
    else if (info.isFile()) entries.push({ path: relative, type: 'file', mode: info.mode & 0o777, ...await describeFile(absolute) });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(root, includeSymlinks = false) {
  const result = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() || (includeSymlinks && entry.isSymbolicLink())) result.push(absolute);
    }
  };
  await visit(root);
  return result;
}

function deepestFirst(left, right) { return right.split(path.sep).length - left.split(path.sep).length || left.localeCompare(right); }

async function resolveProtectedCredential(root, relative, name, dependencies) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error(`${name} must be a path relative to --mac-signing-root.`);
  const resolved = await dependencies.real(path.resolve(root, relative));
  assertInside(root, resolved, name);
  assertProtectedFile(await dependencies.inspect(resolved), name);
  return resolved;
}

function assertInside(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} must remain inside --mac-signing-root.`);
}

function assertProtectedFile(info, label) {
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`${label} must be a regular file readable only by its owner.`);
}

function decodeEnvironmentValue(value, line) {
  if (!value) return '';
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.at(-1) !== quote) throw new Error(`Signing environment line ${line} has an unterminated quoted value.`);
    const body = value.slice(1, -1);
    return quote === '"' ? body.replaceAll('\\n', '\n').replaceAll('\\"', '"').replaceAll('\\\\', '\\') : body;
  }
  if (/\s#/u.test(value)) return value.slice(0, value.indexOf(' #')).trimEnd();
  return value;
}

function parseJsonOutput(result, label) {
  try { return JSON.parse(result.stdout.trim()); } catch (error) { throw new Error(`${label} did not return valid JSON.`, { cause: error }); }
}

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function readOptionalJson(file) { try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
function sameFileIdentity(left, right) { return left?.bytes === right?.bytes && left?.sha256 === right?.sha256; }
function validNonEmptyFileIdentity(value) { return Number.isSafeInteger(value?.bytes) && value.bytes > 0 && /^[0-9a-f]{64}$/u.test(value.sha256 ?? ''); }
async function describeFile(file) { const info = await stat(file); return { bytes: info.size, sha256: await sha256(file) }; }
export async function describeArtifact(target) {
  const info = await lstat(target);
  if (info.isFile()) return describeFile(target);
  if (!info.isDirectory()) throw new Error(`Cannot describe notarized artifact ${target}.`);
  const inventory = await inventoryTree(target);
  return {
    bytes: inventory.reduce((total, entry) => total + (entry.type === 'file' ? entry.bytes : 0), 0),
    sha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
  };
}
async function preparePersistentAppUpload(appPath, evidenceDirectory, run) {
  const bundleIdentity = await describeArtifact(appPath);
  const destination = path.join(evidenceDirectory, `app-${bundleIdentity.sha256}-upload.zip`);
  const identityFile = `${destination}.json`;
  try {
    const info = await lstat(destination);
    if (!info.isFile()) throw new Error(`Persisted notarization upload is not a file: ${destination}.`);
    const recorded = await readOptionalJson(identityFile);
    if (recorded && sameFileIdentity(recorded.bundle, bundleIdentity) && sameFileIdentity(recorded.upload, await describeFile(destination))) return destination;
    if (recorded) throw new Error('Persisted App notarization upload no longer matches its exact bundle and upload identities.');
    await rm(destination, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const staging = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, staging]);
    await rename(staging, destination);
    await writeJsonAtomic(identityFile, { schemaVersion: 1, bundle: bundleIdentity, upload: await describeFile(destination) });
    return destination;
  } finally { await rm(staging, { force: true }); }
}
async function sha256(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

export function runCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr })
      : reject(new Error(`${path.basename(command)} exited with status ${code}: ${(stderr || stdout).trim() || 'no diagnostic output'}`)));
  });
}
