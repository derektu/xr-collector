import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, expect, it } from 'vitest';
import { expectedOfficialManifest, readRuntimePins } from '../../scripts/prepare-meilisearch.mjs';
import { inspectPackagedPayload, planReleaseCandidate, stageReleaseCandidate, verifyStagedCandidate } from '../../scripts/release-candidate.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('fully extracts and verifies the sealed Mac application before accepting its update ZIP', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let extractedRoot = '';
  await expect(inspectPackagedPayload('/candidate/update.zip', 'darwin-arm64', {
    productName: 'XR Update Verify Chinese', appId: 'com.xrcollector.verify.public.chinese', updateRepository: 'derektu/xr-collector-test',
  }, {
    run: async (command: string, args: string[]) => { calls.push({ command, args }); extractedRoot = args[3]!; },
    verifyMacBundle: async (app: string) => {
      expect(app).toBe(path.join(extractedRoot, 'XR Update Verify Chinese.app'));
      throw new Error('code has no resources but signature indicates they must be present');
    },
  })).rejects.toThrow(/no resources.*signature/u);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ command: '/usr/bin/ditto', args: ['-x', '-k', '/candidate/update.zip', extractedRoot] });
});

it('uses the Developer ID, Team, and notarization gates for a signed Mac update ZIP', async () => {
  const calls: string[] = [];
  await expect(inspectPackagedPayload('/candidate/update.zip', 'darwin-arm64', {
    productName: 'XR Collector', appId: 'com.moneydj.xrcollector', updateRepository: 'derektu/xr-collector',
  }, {
    signing: { policy: 'developer-id-notarized', teamId: 'ABCDE12345' },
    run: async () => {},
    verifyDeveloperIdApplication: async (_app: string, team: string) => { calls.push(`identity:${team}`); },
    validateNotarizedApplication: async () => { calls.push('notary'); throw new Error('signed gate reached'); },
  })).rejects.toThrow(/signed gate reached/u);
  expect(calls).toEqual(['identity:ABCDE12345', 'notary']);
});

it('preflights all four identities and stages only sanitized, version-pinned public files', async () => {
  const fixture = await releaseFixture();
  const plan = await planReleaseCandidate(fixture.options, { inspectPackagedPayload: fixture.inspect });
  expect(plan.candidates.map((candidate) => candidate.key).sort()).toEqual(['darwin-arm64/chinese', 'darwin-arm64/official', 'win32-x64/chinese', 'win32-x64/official']);
  const stage = path.join(fixture.root, 'stage');
  const state = await stageReleaseCandidate(plan, stage);
  expect(state.assets).toHaveLength(22);
  expect(state.assets.map((asset) => asset.name)).toContain('release-index.json');
  expect(state.assets.map((asset) => asset.name)).not.toContain('XR-Collector-0.1.0-chinese-darwin-arm64-artifacts.json');
  const index = JSON.parse(await readFile(path.join(stage, 'release-index.json'), 'utf8'));
  expect(index.source.baseUrl).toBe('https://downloads.example.test/archive/v0.1.0/');
  expect(index.releaseNotes).toContain('Unsigned first release candidate.');
  expect(index.candidates[0].updateMetadata.url).toMatch(/^https:\/\/downloads\.example\.test\/archive\/v0\.1\.0\//u);
  const publicText = (await Promise.all(state.assets.filter((asset) => asset.name.endsWith('.json')).map((asset) => readFile(path.join(stage, asset.name), 'utf8')))).join('\n');
  expect(publicText).not.toContain(fixture.root);
  expect(publicText).not.toContain('.local/ticket-artifacts');
  expect(publicText).not.toContain('C:\\projects\\crabbox-work');
  expect(publicText).not.toContain('loadedWindowsCrt');
  expect(publicText).not.toContain('modulePath');
  await expect(verifyStagedCandidate(stage)).resolves.toMatchObject({ commit: fixture.commit });

  const migratedPlan = await planReleaseCandidate({ ...fixture.options, sourceBaseUrl: 'https://mirror.example.test/xr/v0.1.0/' }, { inspectPackagedPayload: fixture.inspect });
  const migratedStage = path.join(fixture.root, 'stage-migrated');
  const migrated = await stageReleaseCandidate(migratedPlan, migratedStage);
  expect(JSON.parse(await readFile(path.join(migratedStage, 'release-index.json'), 'utf8')).source.baseUrl).toBe('https://mirror.example.test/xr/v0.1.0/');
  const payload = state.assets.find((asset) => asset.name.endsWith('-setup.exe'))!;
  expect(migrated.assets.find((asset) => asset.name === payload.name)?.sha256).toBe(payload.sha256);
});

it('requires an exact GitHub owner/repository/releases/download/tag source path', async () => {
  const fixture = await releaseFixture();
  await expect(planReleaseCandidate({ ...fixture.options, sourceBaseUrl: 'https://github.com/derektu/xr-collector/releases/download/v0.0.9/v0.1.0/' }, { inspectPackagedPayload: fixture.inspect }))
    .rejects.toThrow(/owner\/repository\/releases\/download\/v0\.1\.0/u);
  await expect(planReleaseCandidate({ ...fixture.options, sourceBaseUrl: 'https://github.com/derektu/xr-collector/releases/download/v0.1.0/' }, { inspectPackagedPayload: fixture.inspect }))
    .resolves.toMatchObject({ sourceBaseUrl: 'https://github.com/derektu/xr-collector/releases/download/v0.1.0/' });
});

it('fails closed on tampering, mixed identities, missing acceptance, and extra basenames', async () => {
  const fixture = await releaseFixture();
  const first = fixture.records[0]!;
  await writeFile(first.artifactPaths[0]!, 'tampered');
  await expect(planReleaseCandidate(fixture.options, { inspectPackagedPayload: fixture.inspect })).rejects.toThrow(/bytes do not match/u);

  const mixed = await releaseFixture();
  const mixedManifest = JSON.parse(await readFile(mixed.records[0]!.manifestPath, 'utf8'));
  mixedManifest.commit = 'f'.repeat(40);
  mixedManifest.buildInfo.commit = mixedManifest.commit;
  await writeFile(mixed.records[0]!.manifestPath, JSON.stringify(mixedManifest));
  await expect(planReleaseCandidate(mixed.options, { inspectPackagedPayload: mixed.inspect })).rejects.toThrow(/same full source commit/u);

  const mixedVariant = await releaseFixture();
  const variantManifest = JSON.parse(await readFile(mixedVariant.records[0]!.manifestPath, 'utf8'));
  variantManifest.variant = 'official';
  variantManifest.buildInfo.variant = 'official';
  await writeFile(mixedVariant.records[0]!.manifestPath, JSON.stringify(variantManifest));
  await expect(planReleaseCandidate(mixedVariant.options, { inspectPackagedPayload: mixedVariant.inspect })).rejects.toThrow(/mixed|duplicate release combination/u);

  const noAcceptance = await releaseFixture();
  const acceptance = JSON.parse(await readFile(noAcceptance.options.acceptance, 'utf8'));
  acceptance.candidates = acceptance.candidates.slice(1);
  await writeFile(noAcceptance.options.acceptance, JSON.stringify(acceptance));
  await expect(planReleaseCandidate(noAcceptance.options, { inspectPackagedPayload: noAcceptance.inspect })).rejects.toThrow(/Acceptance is missing/u);

  const extra = await releaseFixture();
  await writeFile(path.join(extra.input, 'surprise.txt'), 'not declared');
  await expect(planReleaseCandidate(extra.options, { inspectPackagedPayload: extra.inspect })).rejects.toThrow(/outside the four declared handoffs/u);

  const wrongRecipe = await releaseFixture();
  const chinese = [...wrongRecipe.inspected.values()].find((candidate: any) => candidate.buildInfo.variant === 'chinese') as any;
  chinese.meilisearch.recipeRevision += 1;
  const chineseRecord = wrongRecipe.records.find((candidate) => candidate.variant === 'chinese')!;
  const chineseManifest = JSON.parse(await readFile(chineseRecord.manifestPath, 'utf8'));
  chineseManifest.runtimeIdentity.meilisearch.recipeRevision += 1;
  await writeFile(chineseRecord.manifestPath, JSON.stringify(chineseManifest));
  await expect(planReleaseCandidate(wrongRecipe.options, { inspectPackagedPayload: wrongRecipe.inspect }))
    .rejects.toThrow(/recipeRevision does not match the trusted recipe/u);
});

it('detects a changed frozen byte after staging', async () => {
  const fixture = await releaseFixture();
  const plan = await planReleaseCandidate(fixture.options, { inspectPackagedPayload: fixture.inspect });
  const stage = path.join(fixture.root, 'stage');
  const state = await stageReleaseCandidate(plan, stage);
  const payload = state.assets.find((asset) => asset.kind === 'payload')!;
  await writeFile(path.join(stage, payload.name), 'changed');
  await expect(verifyStagedCandidate(stage)).rejects.toThrow(/changed/u);
});

it.each([
  ['commit', 'f'.repeat(40)],
  ['version', '9.9.9'],
  ['tag', 'v9.9.9'],
  ['sourceBaseUrl', 'https://attacker.example.test/archive/v0.1.0/'],
  ['releaseNotes', '# Substituted notes\n'],
] as const)('rejects a staged control file whose %s disagrees with the frozen public metadata', async (field, value) => {
  const fixture = await releaseFixture();
  const plan = await planReleaseCandidate(fixture.options, { inspectPackagedPayload: fixture.inspect });
  const stage = path.join(fixture.root, `stage-state-${field}`);
  await stageReleaseCandidate(plan, stage);
  const statePath = path.join(stage, '.release-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state[field] = value;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await expect(verifyStagedCandidate(stage)).rejects.toThrow(/control file.*public metadata/u);
});

it.each([
  ['missing candidate', (index: any) => { index.candidates.pop(); }],
  ['crossed manifest reference', (index: any) => { index.candidates[0].manifest = index.candidates[1].manifest; }],
] as const)('rejects frozen public metadata with a %s even after the mutable hashes are updated', async (_case, mutate) => {
  const fixture = await releaseFixture();
  const plan = await planReleaseCandidate(fixture.options, { inspectPackagedPayload: fixture.inspect });
  const stage = path.join(fixture.root, `stage-index-${_case.replaceAll(' ', '-')}`);
  await stageReleaseCandidate(plan, stage);
  const indexPath = path.join(stage, 'release-index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  mutate(index);
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  await resignMutableStageMetadata(stage);
  await expect(verifyStagedCandidate(stage)).rejects.toThrow(/release index.*candidate|manifest reference/u);
});

it('rejects latest-relative and non-versioned payload sources', async () => {
  const fixture = await releaseFixture();
  await expect(planReleaseCandidate({ ...fixture.options, sourceBaseUrl: 'https://example.test/releases/latest/download/' }, { inspectPackagedPayload: fixture.inspect })).rejects.toThrow(/pinned to v0.1.0/u);
  await expect(planReleaseCandidate({ ...fixture.options, sourceBaseUrl: 'https://example.test/downloads/' }, { inspectPackagedPayload: fixture.inspect })).rejects.toThrow(/pinned to v0.1.0/u);
});

it.each([
  ['credentials', 'https://user:password@downloads.example.test/archive/v0.1.0/'],
  ['query', 'https://downloads.example.test/archive/v0.1.0/?token=value'],
  ['fragment', 'https://downloads.example.test/archive/v0.1.0/#private'],
] as const)('rejects a release source URL containing %s', async (_case, sourceBaseUrl) => {
  const fixture = await releaseFixture();
  await expect(planReleaseCandidate({ ...fixture.options, sourceBaseUrl }, { inspectPackagedPayload: fixture.inspect })).rejects.toThrow(/must not contain credentials, query parameters, or a fragment/u);
});

it.each([
  ['commit', (summary: any) => { summary.buildInfo.commit = 'f'.repeat(40); }],
  ['target', (summary: any) => { summary.buildInfo.target = 'win32-x64'; }],
  ['variant', (summary: any) => { summary.buildInfo.variant = 'official'; }],
  ['failed result', (summary: any) => { summary.status = 'failed'; summary.checks[0].status = 'failed'; }],
] as const)('rejects a checksummed acceptance summary with the wrong %s', async (_case, mutate) => {
  const fixture = await releaseFixture();
  const record = fixture.records[0]!;
  const summary = JSON.parse(await readFile(record.acceptanceSummaryPath, 'utf8'));
  mutate(summary);
  await writeFile(record.acceptanceSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await updateAcceptanceEvidenceDigest(fixture.options.acceptance, record.acceptanceSummaryPath);
  await expect(planReleaseCandidate(fixture.options, { inspectPackagedPayload: fixture.inspect })).rejects.toThrow(/Acceptance summary/u);
});

it('requires a structured acceptance summary instead of treating an arbitrary hashed file as a passing report', async () => {
  const fixture = await releaseFixture();
  const acceptance = JSON.parse(await readFile(fixture.options.acceptance, 'utf8'));
  acceptance.candidates[0].evidence[0].kind = 'log';
  await writeFile(fixture.options.acceptance, `${JSON.stringify(acceptance, null, 2)}\n`);
  await expect(planReleaseCandidate(fixture.options, { inspectPackagedPayload: fixture.inspect })).rejects.toThrow(/structured acceptance summary/u);
});

it('stages validation packages only for the GitHub repository baked into all four apps', async () => {
  const fixture = await releaseFixture(true);
  const plan = await planReleaseCandidate(fixture.options, { inspectPackagedPayload: fixture.inspect });
  expect(plan.updateRepository).toBe('derektu/xr-collector-test');
  await expect(planReleaseCandidate({ ...fixture.options,
    sourceBaseUrl: 'https://github.com/derektu/other/releases/download/v0.1.0/' }, { inspectPackagedPayload: fixture.inspect }))
    .rejects.toThrow(/packaged update repository/u);
});

it('keeps legacy ad-hoc staging independent of signed S35 evidence', async () => {
  const fixture = await releaseFixture();
  const acceptance = JSON.parse(await readFile(fixture.options.acceptance, 'utf8'));
  for (const id of Object.keys(acceptance.scenarios)) if (id.startsWith('S35-')) delete acceptance.scenarios[id];
  await writeFile(fixture.options.acceptance, JSON.stringify(acceptance));
  await expect(planReleaseCandidate(fixture.options, { inspectPackagedPayload: fixture.inspect })).resolves.toMatchObject({ version: '0.1.0' });
});

it('defaults the release version from package.json', async () => {
  const fixture = await releaseFixture();
  const { version: _version, tag: _tag, ...withoutVersion } = fixture.options;
  await expect(planReleaseCandidate(withoutVersion, { inspectPackagedPayload: fixture.inspect })).resolves.toMatchObject({ version: '0.1.0', tag: 'v0.1.0' });
});

it('accepts a notarized, stapled DMG only when its receipt, Gatekeeper source and both inner Apps match the stapled App', async () => {
  const fixture = await releaseFixture();
  const record = fixture.records.find((entry) => entry.target === 'darwin-arm64' && entry.variant === 'chinese')!;
  const manifest = JSON.parse(await readFile(record.manifestPath, 'utf8'));
  const blockmap = manifest.artifacts.find((artifact: any) => artifact.path.endsWith('.dmg.blockmap'));
  manifest.artifacts = manifest.artifacts.filter((artifact: any) => artifact !== blockmap);
  await rm(path.join(path.dirname(record.manifestPath), blockmap.path));
  const fileIdentity = { bytes: 1, sha256: '1'.repeat(64) };
  const stapledAppIdentity = { bytes: 1, sha256: '3'.repeat(64) };
  const dmgArtifact = manifest.artifacts.find((artifact: any) => artifact.path.endsWith('.dmg'));
  const appReceipt = { schemaVersion: 1, kind: 'app', teamId: 'ABCDE12345', submissionId: '12345678-1234-1234-1234-123456789abc', status: 'Accepted', issues: 0,
    logSha256: '2'.repeat(64), submitted: fileIdentity, stapled: stapledAppIdentity, stapleValidated: true };
  const dmgReceipt = { schemaVersion: 1, kind: 'dmg', teamId: 'ABCDE12345', submissionId: '87654321-4321-4321-4321-cba987654321', status: 'Accepted', issues: 0,
    logSha256: '4'.repeat(64), submitted: { bytes: dmgArtifact.bytes - 1, sha256: '5'.repeat(64) },
    stapled: { bytes: dmgArtifact.bytes, sha256: dmgArtifact.sha256 }, stapleValidated: true };
  manifest.signing = { policy: 'developer-id-notarized', credentialDiscovery: false, teamId: 'ABCDE12345',
    identity: { sha1: 'a'.repeat(40), name: 'Developer ID Application: Example (ABCDE12345)' },
    actualVerification: { kind: 'developer-id-notarized', app: appReceipt, dmg: dmgReceipt, gatekeeperDownload: 'pending-clean-browser-acceptance' } };
  const primary = record.artifactPaths.find((file) => file.endsWith('.zip'))!;
  const inspected = fixture.inspected.get(primary) as any;
  inspected.notarizedAppIdentity = stapledAppIdentity;
  const finalFiles = Object.entries(inspected.runtimeFiles).map(([relative, identity]: any) => ({ path: relative, type: 'file', mode: 0o755, ...identity }));
  finalFiles.push({ path: 'yt-dlp/_internal/empty-resource', type: 'file', mode: 0o644, bytes: 0, sha256: createHash('sha256').update('').digest('hex') });
  manifest.runtimeIdentity.signed = inspected.signed = {
    schemaVersion: 1, policy: 'developer-id-notarized', expectedAppTeamId: 'ABCDE12345',
    sourceIdentity: { dependencyManifest: fileIdentity, meilisearchManifest: fileIdentity },
    meilisearch: { source: { bytes: inspected.meilisearch.binary.bytes, sha256: inspected.meilisearch.binary.sha256 }, final: inspected.runtimeFiles.meilisearch },
    files: finalFiles, executableSignatures: {},
  };
  const save = () => writeFile(record.manifestPath, JSON.stringify(manifest));
  await save();
  const dmgChecks: string[] = [];
  const plan = await planReleaseCandidate(fixture.options, {
    inspectPackagedPayload: fixture.inspect,
    verifyDeveloperIdDiskImage: async (_dmg: string, team: string) => { dmgChecks.push(`identity:${team}`); },
    verifySignedMacDmgContents: async (_dmg: string, product: string, team: string) => { dmgChecks.push(`contents:${product}:${team}`); return { appIdentity: stapledAppIdentity }; },
  });
  expect(plan).toMatchObject({ version: '0.1.0' });
  expect(dmgChecks).toEqual(['identity:ABCDE12345', 'contents:XR Collector:ABCDE12345']);
  const stage = path.join(fixture.root, 'signed-stage');
  const state = await stageReleaseCandidate(plan, stage);
  expect(state.assets).toHaveLength(21);
  expect(state.assets.some((asset) => asset.name.endsWith('.dmg.blockmap'))).toBe(true);
  expect(state.assets.some((asset) => asset.name === 'XR-Collector-0.1.0-chinese-mac-arm64.dmg.blockmap')).toBe(false);
  const publicManifest = JSON.parse(await readFile(path.join(stage, 'XR-Collector-0.1.0-chinese-darwin-arm64-manifest.json'), 'utf8'));
  expect(publicManifest.signing.receipts).toEqual({
    app: { schemaVersion: 1, kind: 'app', teamId: 'ABCDE12345', submissionId: appReceipt.submissionId, status: 'Accepted', issues: 0,
      stapleValidated: true, submitted: fileIdentity, stapled: stapledAppIdentity, logSha256: appReceipt.logSha256 },
    dmg: { schemaVersion: 1, kind: 'dmg', teamId: 'ABCDE12345', submissionId: dmgReceipt.submissionId, status: 'Accepted', issues: 0,
      stapleValidated: true, submitted: dmgReceipt.submitted, stapled: dmgReceipt.stapled, logSha256: dmgReceipt.logSha256 },
  });
  await expect(verifyStagedCandidate(stage)).resolves.toMatchObject({ version: '0.1.0' });

  const attempt = (dmgAppIdentity = stapledAppIdentity) => planReleaseCandidate(fixture.options, {
    inspectPackagedPayload: fixture.inspect, verifyDeveloperIdDiskImage: async () => {},
    verifySignedMacDmgContents: async () => ({ appIdentity: dmgAppIdentity }),
  });
  manifest.signing.actualVerification.app = { ...appReceipt, stapleValidated: false };
  await save();
  await expect(attempt()).rejects.toThrow(/App notarization receipt is invalid/u);
  manifest.signing.actualVerification.app = { ...appReceipt, issues: 1 };
  await save();
  await expect(attempt()).rejects.toThrow(/App notarization receipt is invalid/u);
  manifest.signing.actualVerification.app = appReceipt;
  for (const invalid of [{ status: 'Invalid' }, { issues: 1 }, { stapleValidated: false }, { submissionId: undefined }]) {
    manifest.signing.actualVerification.dmg = { ...dmgReceipt, ...invalid };
    await save();
    await expect(attempt()).rejects.toThrow(/DMG notarization receipt is invalid/u);
  }
  const { submissionId: _id, status: _status, issues: _issues, logSha256: _log, submitted: _submitted, stapled: _stapled, stapleValidated: _validated, ...signedOnly } = dmgReceipt;
  manifest.signing.actualVerification.dmg = { ...signedOnly, notarization: 'not-requested', signed: dmgReceipt.stapled,
    gatekeeper: { source: 'Unnotarized Developer ID', output: 'XR.dmg: accepted\nsource=Unnotarized Developer ID' } };
  await save();
  await expect(attempt()).rejects.toThrow(/DMG notarization receipt is invalid/u);
  manifest.signing.actualVerification.dmg = { ...dmgReceipt, stapled: { ...dmgReceipt.stapled, sha256: '0'.repeat(64) } };
  await save();
  await expect(attempt()).rejects.toThrow(/Final DMG bytes differ/u);
  manifest.signing.actualVerification.dmg = dmgReceipt;
  await save();
  await expect(planReleaseCandidate(fixture.options, {
    inspectPackagedPayload: fixture.inspect,
    verifyDeveloperIdDiskImage: async () => { throw new Error('DMG Gatekeeper source is Unnotarized Developer ID, not Notarized Developer ID.'); },
    verifySignedMacDmgContents: async () => ({ appIdentity: stapledAppIdentity }),
  })).rejects.toThrow(/Unnotarized Developer ID/u);
  await expect(attempt({ bytes: 1, sha256: 'e'.repeat(64) })).rejects.toThrow(/DMG App identity differs from the stapled App/u);
  inspected.notarizedAppIdentity = { bytes: 1, sha256: 'f'.repeat(64) };
  await expect(attempt()).rejects.toThrow(/ZIP App identity differs from the stapled App/u);
});

async function releaseFixture(validation = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-release-fixture-'));
  roots.push(root);
  const input = path.join(root, 'input');
  await mkdir(input);
  const commit = 'a'.repeat(40);
  const version = '0.1.0';
  const pins = JSON.parse(await readFile(path.resolve('scripts/runtime-dependency-pins.json'), 'utf8'));
  const recipe = JSON.parse(await readFile(path.resolve('scripts/meilisearch-build-recipe.json'), 'utf8'));
  const officialPins = await readRuntimePins();
  const records: Array<{
    manifestPath: string;
    artifactPaths: string[];
    acceptanceSummaryPath: string;
    target: string;
    variant: string;
    buildInfo: Record<string, unknown>;
  }> = [];
  const inspected = new Map<string, object>();
  const evidenceDirectory = path.join(root, 'evidence');
  await mkdir(evidenceDirectory);
  for (const [target, variant] of [['darwin-arm64', 'chinese'], ['darwin-arm64', 'official'], ['win32-x64', 'chinese'], ['win32-x64', 'official']] as const) {
    const directory = path.join(input, `${target}-${variant}`);
    await mkdir(directory);
    const base = `XR-Collector-${version}-${variant}`;
    const names = target === 'darwin-arm64'
      ? [`${base}-mac-arm64.dmg`, `${base}-mac-arm64.dmg.blockmap`, `${base}-mac-arm64.zip`, `${base}-mac-arm64.zip.blockmap`]
      : [`${base}-win-x64-setup.exe`, `${base}-win-x64-setup.exe.blockmap`];
    const artifactPaths = [];
    for (const name of names) { const file = path.join(directory, name); await writeFile(file, `${target}/${variant}/${name}`); artifactPaths.push(file); }
    const primaryName = target === 'darwin-arm64' ? names[2]! : names[0]!;
    const primaryPath = path.join(directory, primaryName);
    const primary = await describe(primaryPath);
    const updateName = `${base}-${target}-update.yml`;
    const updatePath = path.join(directory, updateName);
    const sha512 = createHash('sha512').update(await readFile(primaryPath)).digest('base64');
    await writeFile(updatePath, stringifyYaml({ version, files: [{ url: primaryName, sha512, size: primary.bytes }], path: primaryName, sha512, releaseDate: '2026-10-26T00:00:00.000Z' }));
    artifactPaths.push(updatePath);
    const buildInfo = { schemaVersion: 1, kind: 'packaged', version, builtAt: '2026-10-26T00:00:00.000Z', commit, buildId: `${target}-${variant}`, target, variant, sourceDirty: false };
    const packageIdentity = validation ? {
      productName: `XR Update Verify ${variant === 'chinese' ? 'Chinese' : 'Official'}`,
      appId: `com.xrcollector.verify.public.${variant}`,
      updateRepository: 'derektu/xr-collector-test',
    } : { productName: 'XR Collector', appId: 'com.moneydj.xrcollector', updateRepository: 'derektu/xr-collector' };
    const targetPins = pins.targets[target];
    const dependencies = {
      schemaVersion: 1, target,
      dependencies: {
        ytDlp: { version: targetPins.ytDlp.version, url: targetPins.ytDlp.url, archiveSha256: targetPins.ytDlp.sha256 },
        deno: { version: targetPins.deno.version, url: targetPins.deno.url, archiveSha256: targetPins.deno.sha256 },
      },
      executables: { ytDlp: targetPins.ytDlp.installedExecutable, deno: targetPins.deno.installedExecutable },
      files: [
        { path: targetPins.ytDlp.installedExecutable, bytes: 2, sha256: sha('yt') },
        { path: targetPins.deno.installedExecutable, bytes: 4, sha256: sha('deno') },
      ],
    };
    const meilisearch = variant === 'official' ? expectedOfficialManifest(officialPins, target) : {
      schemaVersion: recipe.schemaVersion, recipeRevision: recipe.recipeRevision, recipeFingerprint: 'fixture', sourceRepository: recipe.repository, sourceTag: recipe.tag,
      sourceCommit: recipe.sourceCommit, cargoLockSha256: recipe.cargoLockSha256, features: recipe.features, defaultFeatures: recipe.defaultFeatures,
      target, binary: { version: recipe.meilisearchVersion, versionOutput: `meilisearch ${recipe.meilisearchVersion}`, bytes: 5, sha256: sha('meili'), format: target === 'darwin-arm64' ? 'Mach-O 64' : 'PE32+', arch: target === 'darwin-arm64' ? 'arm64' : 'x64' },
    };
    const windowsCrt = target === 'win32-x64' && variant === 'official' ? pins.officialWindowsCrt : null;
    const manifestName = `${base}-${target}-artifacts.json`;
    const manifestPath = path.join(directory, manifestName);
    const artifacts = await Promise.all(artifactPaths.map(async (file) => ({ path: path.basename(file), ...await describe(file) })));
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1, version, commit, target, variant, buildInfo, packageIdentity,
      builderHost: { platform: target === 'darwin-arm64' ? 'darwin' : 'win32', processArch: target === 'darwin-arm64' ? 'arm64' : 'x64', hostArch: 'arm64', emulated: target === 'win32-x64' },
      toolVersions: { node: 'v22.22.3' },
      signing: { policy: target === 'darwin-arm64' ? 'ad-hoc' : 'unsigned', credentialDiscovery: false, actualVerification: { kind: 'fixture', output: `${root}/private.log` } },
      runtimeIdentity: {
        dependencies,
        meilisearch,
        windowsCrt,
        ...(target === 'win32-x64' && variant === 'official' ? {
          loadedWindowsCrt: {
            pid: 14664,
            processPath: 'C:\\projects\\crabbox-work\\installed\\resources\\bin\\meilisearch.exe',
            modulePath: 'C:\\projects\\crabbox-work\\installed\\resources\\bin\\VCRUNTIME140.dll',
            moduleBytes: windowsCrt!.bytes,
            moduleSha256: windowsCrt!.sha256,
            moduleSignature: 'Valid',
            evidence: '.local/ticket-artifacts/34/vm/windows/loaded-crt.json',
          },
        } : {}),
      }, artifacts,
      acceptanceEvidence: [{ path: `${root}/private-evidence.json` }], acceptancePending: ['private details'],
    }));
    const acceptanceSummaryPath = path.join(evidenceDirectory, `${target}-${variant}-summary.json`);
    await writeFile(acceptanceSummaryPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'xr-collector-release-acceptance',
      status: 'passed',
      buildInfo,
      checks: [{ id: 'installed-app-smoke', status: 'passed' }],
    }, null, 2)}\n`);
    records.push({ manifestPath, artifactPaths, acceptanceSummaryPath, target, variant, buildInfo });
    inspected.set(primaryPath, {
      packageMetadata: { name: 'xr-collector', ...(validation ? { productName: packageIdentity.productName,
        xrCollectorAppId: packageIdentity.appId, xrCollectorUpdateRepository: packageIdentity.updateRepository } : {}) },
      buildInfo, dependencies, meilisearch,
      runtimeFiles: {
        [dependencies.executables.ytDlp]: { bytes: 2, sha256: sha('yt') },
        [dependencies.executables.deno]: { bytes: 4, sha256: sha('deno') },
        [target === 'win32-x64' ? 'meilisearch.exe' : 'meilisearch']: { bytes: meilisearch.binary.bytes, sha256: meilisearch.binary.sha256 },
      },
      binaryIdentity: { format: meilisearch.binary.format, arch: meilisearch.binary.arch },
      windowsCrt: windowsCrt ? { bytes: windowsCrt.bytes, sha256: windowsCrt.sha256 } : null,
    });
  }
  const candidates = await Promise.all(records.map(async (record) => ({
    target: record.target,
    variant: record.variant,
    status: 'passed',
    evidence: [{
      kind: 'acceptance-summary',
      path: path.relative(root, record.acceptanceSummaryPath),
      sha256: sha(await readFile(record.acceptanceSummaryPath)),
      commit,
    }],
  })));
  const scenarios = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`R35-0${index + 1}`, { status: index < 3 ? 'passed' : 'pending', reason: 'not publicly executed' }]));
  Object.assign(scenarios, Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`S35-0${index + 1}`, { status: index < 5 ? 'passed' : 'pending', reason: index < 5 ? 'verified fixture' : 'A-to-B update remains pending' }])));
  const acceptancePath = path.join(root, 'acceptance.json');
  await writeFile(acceptancePath, JSON.stringify({ schemaVersion: 1, version, commit, candidates, scenarios }));
  const notes = path.join(root, 'notes.md');
  await writeFile(notes, '# XR Collector 0.1.0\n\nUnsigned first release candidate.\n');
  const options = { input, acceptance: acceptancePath, notes, version, tag: `v${version}`,
    sourceBaseUrl: validation
      ? 'https://github.com/derektu/xr-collector-test/releases/download/v0.1.0/'
      : 'https://downloads.example.test/archive/v0.1.0/' };
  return { root, input, commit, options, records, inspected, inspect: async (payload: string) => inspected.get(payload) };
}

async function describe(file: string) { const value = await readFile(file); return { bytes: value.byteLength, sha256: sha(value) }; }
function sha(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }

async function resignMutableStageMetadata(stage: string) {
  const statePath = path.join(stage, '.release-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const indexAsset = state.assets.find((asset: any) => asset.name === 'release-index.json');
  Object.assign(indexAsset, await describe(path.join(stage, indexAsset.name)));
  const checksumAssets = state.assets.filter((asset: any) => asset.name !== 'SHA256SUMS').sort((a: any, b: any) => a.name.localeCompare(b.name));
  const sums = `${checksumAssets.map((asset: any) => `${asset.sha256}  ${asset.name}`).join('\n')}\n`;
  await writeFile(path.join(stage, 'SHA256SUMS'), sums);
  const sumsAsset = state.assets.find((asset: any) => asset.name === 'SHA256SUMS');
  Object.assign(sumsAsset, await describe(path.join(stage, sumsAsset.name)));
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function updateAcceptanceEvidenceDigest(acceptancePath: string, summaryPath: string) {
  const acceptance = JSON.parse(await readFile(acceptancePath, 'utf8'));
  const evidence = acceptance.candidates.flatMap((candidate: any) => candidate.evidence).find((item: any) => path.resolve(path.dirname(acceptancePath), item.path) === summaryPath);
  evidence.sha256 = sha(await readFile(summaryPath));
  await writeFile(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`);
}
