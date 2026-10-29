import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertAuthorization, createGitHubAdapter, promoteStableRelease, publishPrerelease, uploadDraftRelease, verifyAnonymousRelease, verifyRemoteRelease } from '../../scripts/github-release.mjs';
import { assertPublishingHost, parseReleaseArguments, runReleaseCommand } from '../../scripts/release.mjs';
import { stageReleaseCandidate } from '../../scripts/release-candidate.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('resumes an interrupted draft without duplicate uploads and verifies every downloaded hash', async () => {
  const fixture = await stagedFixture();
  const remote = fakeRemote(fixture.state);
  remote.failUploadAfter = 1;
  await expect(uploadDraftRelease(fixture.root, remote.adapter, fixture.authorization(['draft-upload', 'create-tag', 'create-draft']))).rejects.toThrow(/interrupted/u);
  expect(remote.assets).toHaveLength(1);
  remote.failUploadAfter = null;
  await expect(uploadDraftRelease(fixture.root, remote.adapter, fixture.authorization(['draft-upload', 'create-tag', 'create-draft']))).resolves.toMatchObject({ draft: true });
  expect(remote.assets).toHaveLength(fixture.state.assets.length);
  expect(new Set(remote.assets.map((asset) => asset.name)).size).toBe(remote.assets.length);
  expect(remote.hashCalls).toBeGreaterThanOrEqual(fixture.state.assets.length);
});

it('deletes a starter or wrong-byte asset from a draft and reuploads it, but never overwrites a published release', async () => {
  const fixture = await stagedFixture();
  const remote = fakeRemote(fixture.state);
  remote.tagCommit = fixture.state.commit;
  remote.release = { id: 1, draft: true, prerelease: false, upload_url: 'fake' };
  remote.assets.push({ id: 42, name: fixture.state.assets[0]!.name, state: 'starter', size: 0, sha256: sha('') });

  await expect(uploadDraftRelease(fixture.root, remote.adapter, fixture.authorization(['draft-upload']))).resolves.toMatchObject({ draft: true });
  expect(remote.deletedAssets).toEqual([42]);
  expect(remote.assets.find((asset: any) => asset.name === fixture.state.assets[0]!.name)).toMatchObject({ state: 'uploaded', size: fixture.state.assets[0]!.bytes });

  remote.release.draft = false;
  remote.assets[0] = { id: 43, name: fixture.state.assets[0]!.name, state: 'starter', size: 0, sha256: sha('') };
  await expect(uploadDraftRelease(fixture.root, remote.adapter, fixture.authorization(['draft-upload']))).rejects.toThrow(/already public/u);
});

it('returns the fresh verified release snapshot after uploading every draft asset', async () => {
  const fixture = await stagedFixture();
  const remote = fakeRemote(fixture.state);

  const release = await uploadDraftRelease(fixture.root, remote.adapter, fixture.authorization(['draft-upload', 'create-tag', 'create-draft']));

  expect(fixture.state.assets).toHaveLength(22);
  expect(remote.createdSnapshot).toMatchObject({ assets: [] });
  expect(release).not.toBe(remote.createdSnapshot);
  expect(release.assets).toHaveLength(22);
  expect(release.assets.map((asset: any) => asset.name).sort()).toEqual(fixture.state.assets.map((asset) => asset.name).sort());
});

it('rejects stale tags, different-byte collisions, and partial remote inventories', async () => {
  const fixture = await stagedFixture();
  const stale = fakeRemote(fixture.state);
  stale.tagCommit = 'f'.repeat(40);
  await expect(uploadDraftRelease(fixture.root, stale.adapter, fixture.authorization(['draft-upload', 'create-draft']))).rejects.toThrow(/already points/u);

  const collision = fakeRemote(fixture.state);
  collision.tagCommit = fixture.state.commit;
  collision.release = { id: 1, draft: true, prerelease: false, upload_url: 'fake' };
  collision.assets.push({ id: 1, name: fixture.state.assets[0]!.name, size: 4, sha256: sha('evil') });
  await expect(uploadDraftRelease(fixture.root, collision.adapter, fixture.authorization(['draft-upload']))).resolves.toMatchObject({ draft: true });
  expect(collision.deletedAssets).toEqual([1]);

  const partial = fakeRemote(fixture.state);
  partial.tagCommit = fixture.state.commit;
  partial.release = { id: 1, draft: true, prerelease: false, upload_url: 'fake' };
  partial.assets.push(assetFromState(fixture.state.assets[0]!, 1));
  await expect(verifyRemoteRelease(fixture.root, partial.adapter, { requireDraft: true })).rejects.toThrow(/partial/u);
});

it('binds GitHub browser download URLs and rejects authorization that contradicts frozen acceptance', async () => {
  const fixture = await stagedFixture();
  const remote = fakeRemote(fixture.state);
  remote.tagCommit = fixture.state.commit;
  remote.release = { id: 1, draft: true, prerelease: false, upload_url: 'fake' };
  remote.assets.push(...fixture.state.assets.map((asset, index) => ({ ...assetFromState(asset, index + 1), browser_download_url: new URL(encodeURIComponent(asset.name), fixture.state.sourceBaseUrl).toString() })));
  remote.assets[0].browser_download_url = 'https://github.com/attacker/repo/releases/download/v0.1.0/release-index.json';
  await expect(verifyRemoteRelease(fixture.root, remote.adapter, { requireDraft: true })).rejects.toThrow(/URL differs/u);

  const state = { ...fixture.state, acceptance: { scenarios: { 'R35-01': { status: 'failed' } } } };
  expect(() => assertAuthorization(state, fixture.authorization(['draft-upload'], { 'R35-01': 'passed' }), 'draft-upload')).toThrow(/contradicts/u);
});

it('keeps prerelease and stable promotion gates separate and never self-requires R35-08', async () => {
  const fixture = await stagedFixture();
  const remote = fakeRemote(fixture.state);
  remote.tagCommit = fixture.state.commit;
  remote.release = { id: 1, draft: true, prerelease: false, upload_url: 'fake' };
  remote.assets.push(...fixture.state.assets.map((asset, index) => assetFromState(asset, index + 1)));
  const prereleaseAuthorization = fixture.authorization(['publish-prerelease'], {
    'R35-01': 'passed', 'R35-02': 'passed', 'R35-03': 'passed', 'R35-06': 'passed', 'R35-07': 'pending',
  }, ['R35-07']);
  await expect(publishPrerelease(fixture.root, remote.adapter, prereleaseAuthorization)).resolves.toMatchObject({ prerelease: true, draft: false });

  const missingBrowser = fixture.authorization(['promote-stable'], {
    'R35-01': 'passed', 'R35-02': 'passed', 'R35-03': 'passed', 'R35-04': 'passed', 'R35-05': 'pending', 'R35-06': 'passed', 'R35-07': 'pending',
  }, ['R35-07']);
  await expect(promoteStableRelease(fixture.root, remote.adapter, missingBrowser, goodAnonymous(fixture))).rejects.toThrow(/R35-05/u);

  const ready = fixture.authorization(['promote-stable'], {
    'R35-01': 'passed', 'R35-02': 'passed', 'R35-03': 'passed', 'R35-04': 'passed', 'R35-05': 'passed', 'R35-06': 'passed', 'R35-07': 'pending',
  }, ['R35-07']);
  await expect(promoteStableRelease(fixture.root, remote.adapter, ready, goodAnonymous(fixture))).resolves.toMatchObject({ prerelease: false, draft: false });
});

it('rejects anonymous HTML, missing assets, and incorrect bytes', async () => {
  const fixture = await stagedFixture();
  await expect(verifyAnonymousRelease(fixture.root, async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }))).rejects.toThrow(/HTML/u);
  await expect(verifyAnonymousRelease(fixture.root, async () => new Response('missing', { status: 404 }))).rejects.toThrow(/HTTP 404/u);
  await expect(verifyAnonymousRelease(fixture.root, async () => new Response('wrong', { status: 200, headers: { 'content-type': 'application/octet-stream' } }))).rejects.toThrow(/do not match/u);
});

it('bounds remote hash verification, stops scheduling after a bad hash, and drains in-flight checks before publication fails', async () => {
  const fixture = await stagedFixture();
  const remote = fakeRemote(fixture.state);
  remote.tagCommit = fixture.state.commit;
  remote.release = { id: 1, draft: true, prerelease: false, upload_url: 'fake' };
  remote.assets.push(...fixture.state.assets.map((asset, index) => assetFromState(asset, index + 1)));
  const pending = new Map<string, { resolve: (digest: string) => void }>();
  const calls: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let updateCalls = 0;
  remote.adapter.hashAsset = (asset: any) => new Promise<string>((resolve) => {
    calls.push(asset.name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    pending.set(asset.name, { resolve: (digest) => { active -= 1; resolve(digest); } });
  });
  remote.adapter.updateRelease = async () => { updateCalls += 1; return remote.release; };
  const authorization = fixture.authorization(['publish-prerelease'], {
    'R35-01': 'passed', 'R35-02': 'passed', 'R35-03': 'passed', 'R35-06': 'passed', 'R35-07': 'pending',
  }, ['R35-07']);

  const publication = publishPrerelease(fixture.root, remote.adapter, authorization);
  let settled = false;
  void publication.then(() => { settled = true; }, () => { settled = true; });
  await waitFor(() => calls.length === 3);
  pending.get(calls[0]!)!.resolve('0'.repeat(64));
  await waitFor(() => active === 2);
  await flushMicrotasks();

  expect(maximumActive).toBe(3);
  expect(calls).toHaveLength(3);
  expect(settled).toBe(false);
  expect(updateCalls).toBe(0);

  for (const name of calls.slice(1)) pending.get(name)!.resolve(remote.assets.find((asset: any) => asset.name === name).sha256);
  await expect(publication).rejects.toThrow(/does not match staged bytes/u);
  expect(calls).toHaveLength(3);
  expect(updateCalls).toBe(0);
});

it('bounds anonymous downloads and drains in-flight checks before rejecting a bad download hash', async () => {
  const fixture = await stagedFixture();
  const remote = fakeRemote(fixture.state);
  remote.tagCommit = fixture.state.commit;
  remote.release = { id: 1, draft: false, prerelease: true, upload_url: 'fake' };
  remote.assets.push(...fixture.state.assets.map((asset, index) => assetFromState(asset, index + 1)));
  const pending = new Map<string, { resolve: (response: Response) => void }>();
  const calls: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let updateCalls = 0;
  remote.adapter.updateRelease = async () => { updateCalls += 1; return remote.release; };
  const request = async (input: URL | RequestInfo) => {
    const name = decodeURIComponent(new URL(input.toString()).pathname.split('/').pop()!);
    calls.push(name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    return new Promise<Response>((resolve) => {
      pending.set(name, { resolve: (response) => { active -= 1; resolve(response); } });
    });
  };
  const authorization = fixture.authorization(['promote-stable'], {
    'R35-01': 'passed', 'R35-02': 'passed', 'R35-03': 'passed', 'R35-04': 'passed', 'R35-05': 'passed', 'R35-06': 'passed', 'R35-07': 'pending',
  }, ['R35-07']);

  const promotion = promoteStableRelease(fixture.root, remote.adapter, authorization, request);
  let settled = false;
  void promotion.then(() => { settled = true; }, () => { settled = true; });
  await waitFor(() => calls.length === 3);
  const first = calls[0]!;
  const correct = await readFile(path.join(fixture.root, first));
  const corrupt = Buffer.from(correct);
  corrupt[0] = (corrupt[0]! + 1) % 256;
  pending.get(first)!.resolve(new Response(corrupt, { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  await waitFor(() => active === 2);
  await flushMicrotasks();

  expect(maximumActive).toBe(3);
  expect(calls).toHaveLength(3);
  expect(settled).toBe(false);
  expect(updateCalls).toBe(0);

  for (const name of calls.slice(1)) {
    const value = await readFile(path.join(fixture.root, name));
    pending.get(name)!.resolve(new Response(value, { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  }
  await expect(promotion).rejects.toThrow(/do not match/u);
  expect(calls).toHaveLength(3);
  expect(updateCalls).toBe(0);
});

it('makes every release mutation explicit and Mac-only', () => {
  expect(parseReleaseArguments(['stage', '--input', 'in', '--acceptance', 'accept.json', '--notes', 'notes.md', '--source-base-url', 'https://example.test/v0.1.0/', '--output', 'out'])).toMatchObject({ action: 'stage', sourceBaseUrl: 'https://example.test/v0.1.0/' });
  expect(() => parseReleaseArguments(['publish'])).toThrow(/action must be/u);
  expect(() => assertPublishingHost('win32')).toThrow(/authorized Mac/u);
  expect(() => assertPublishingHost('darwin')).not.toThrow();
});

it('refuses private repositories and accounts without release permissions', async () => {
  const privateRepository = createGitHubAdapter('owner/repo', { gh: async () => ({ private: true, visibility: 'private', permissions: { admin: true } }) });
  await expect(privateRepository.assertRepositoryReady(undefined, 'owner/repo')).rejects.toThrow(/must be public/u);
  const readOnly = createGitHubAdapter('owner/repo', { gh: async () => ({ private: false, visibility: 'public', permissions: { pull: true } }) });
  await expect(readOnly.assertRepositoryReady(undefined, 'owner/repo')).rejects.toThrow(/cannot publish/u);
});

it('rejects a github.com asset source that points at a different repository before publishing', async () => {
  const adapter = createGitHubAdapter('owner/repo', {
    gh: async () => ({ private: false, visibility: 'public', permissions: { push: true } }),
  });
  await expect(adapter.assertRepositoryReady('https://github.com/other/project/releases/download/v0.1.0/', 'owner/repo')).rejects.toThrow(/source.*owner\/repo/u);
  await expect(adapter.assertRepositoryReady('https://evil.example/owner/repo/releases/download/v0.1.0/', 'owner/repo')).rejects.toThrow(/requires.*github\.com/u);
  await expect(adapter.assertRepositoryReady('https://mirror.example.test/v0.1.0/', 'other/project')).rejects.toThrow(/differs from packaged/u);
});

it('uses typed GitHub booleans and discovers resumable drafts through the authenticated release list', async () => {
  const calls: string[][] = [];
  const notFound: any = new Error('not found');
  notFound.status = 404;
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args.some((entry) => entry.includes('/releases/tags/'))) throw notFound;
    if (args.includes('--slurp')) return [[{ id: 7, tag_name: 'v0.1.0', draft: true }]];
    return { id: 7, tag_name: 'v0.1.0', draft: true };
  };
  const adapter = createGitHubAdapter('owner/repo', { gh });
  await expect(adapter.getReleaseByTag('v0.1.0')).resolves.toMatchObject({ id: 7, draft: true });
  await adapter.createDraft({ tag: 'v0.1.0', commit: 'a'.repeat(40), version: '0.1.0', notes: 'notes' });
  await adapter.updateRelease({ id: 7 }, { draft: false, prerelease: true, make_latest: 'false' });
  const create = calls.find((args) => args.includes('POST'))!;
  expect(create).toContain('-F');
  expect(create[create.indexOf('draft=true') - 1]).toBe('-F');
  expect(create[create.indexOf('prerelease=false') - 1]).toBe('-F');
  expect(create[create.indexOf('make_latest=false') - 1]).toBe('-f');
  const update = calls.find((args) => args.includes('PATCH'))!;
  expect(update[update.indexOf('draft=false') - 1]).toBe('-F');
  expect(update[update.indexOf('prerelease=true') - 1]).toBe('-F');
  expect(update[update.indexOf('make_latest=false') - 1]).toBe('-f');
});

it('times each upload and remote download and writes the release timing report next to the stage', async () => {
  const fixture = await stagedFixture();
  const remote = fakeRemote(fixture.state);
  const authorizationPath = path.join(path.dirname(fixture.root), 'authorize-draft.json');
  await writeFile(authorizationPath, JSON.stringify(fixture.authorization(['draft-upload', 'create-tag', 'create-draft'])));
  const output: string[] = [];

  await runReleaseCommand({ action: 'draft-upload', stage: fixture.root, repo: 'derektu/xr-collector', authorization: authorizationPath },
    { adapter: remote.adapter, platform: 'darwin', timingLog: (text: string) => output.push(text) });

  const reportPath = output.at(-1)!.replace('Stage timing report: ', '');
  expect(path.dirname(reportPath)).toBe(path.dirname(fixture.root));
  expect(path.basename(reportPath)).toMatch(/^release-draft-upload-timings-.+\.json$/u);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  expect(report).toMatchObject({ command: 'release draft-upload', status: 'passed', version: '0.1.0', tag: 'v0.1.0', commit: fixture.state.commit });
  expect(report.artifacts).toEqual(fixture.state.assets.map(({ name, bytes, sha256 }) => ({ path: name, bytes, sha256 })));
  const uploads = report.stages.filter((stage: any) => stage.name.startsWith('upload '));
  expect(uploads.map((stage: any) => [stage.name, stage.bytes])).toEqual(fixture.state.assets.map((asset) => [`upload ${asset.name}`, asset.bytes]));
  expect(report.stages.filter((stage: any) => /^remote verify \/ download and hash /u.test(stage.name))).toHaveLength(fixture.state.assets.length);
  expect(output[0]).toMatch(/Stage timings: release draft-upload passed/u);
});

it('writes the release timing report up to a failing remote asset check', async () => {
  const fixture = await stagedFixture();
  const remote = fakeRemote(fixture.state);
  remote.tagCommit = fixture.state.commit;
  remote.release = { id: 1, draft: true, prerelease: false, upload_url: 'fake' };
  remote.assets = fixture.state.assets.map(assetFromState);
  const bad = fixture.state.assets[0]!.name;
  remote.adapter.hashAsset = async (asset: any) => asset.name === bad ? sha('tampered') : asset.sha256;
  const reportDirectory = path.join(path.dirname(fixture.root), 'timings');
  const output: string[] = [];

  await expect(runReleaseCommand({ action: 'remote-verify', stage: fixture.root, repo: 'derektu/xr-collector' },
    { adapter: remote.adapter, timingReportDirectory: reportDirectory, timingLog: (text: string) => output.push(text) })).rejects.toThrow(/does not match staged bytes/u);

  const report = JSON.parse(await readFile(output.at(-1)!.replace('Stage timing report: ', ''), 'utf8'));
  expect(report).toMatchObject({ command: 'release remote-verify', status: 'failed', error: expect.stringContaining(bad), commit: fixture.state.commit });
  expect(report.stages.find((stage: any) => stage.name === `remote verify / download and hash ${bad}`)).toMatchObject({ status: 'failed', bytes: fixture.state.assets[0]!.bytes });
  expect(report.stages.find((stage: any) => stage.name === 'remote verify')).toMatchObject({ status: 'failed', depth: 0 });
  expect(output[0]).toMatch(/Stage timings: release remote-verify failed/u);
});

async function stagedFixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'xr-release-stage-'));
  roots.push(workspace);
  const source = path.join(workspace, 'source');
  const root = path.join(workspace, 'stage');
  await mkdir(source, { recursive: true });
  const version = '0.1.0';
  const commit = 'a'.repeat(40);
  const acceptance = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`R35-0${index + 1}`, { status: 'pending' }]));
  const candidates = [];
  for (const [target, variant] of [['darwin-arm64', 'chinese'], ['darwin-arm64', 'official'], ['win32-x64', 'chinese'], ['win32-x64', 'official']] as const) {
    const base = `XR-Collector-${version}-${variant}`;
    const names = target === 'darwin-arm64'
      ? [`${base}-mac-arm64.dmg`, `${base}-mac-arm64.dmg.blockmap`, `${base}-mac-arm64.zip`, `${base}-mac-arm64.zip.blockmap`, `${base}-darwin-arm64-update.yml`]
      : [`${base}-win-x64-setup.exe`, `${base}-win-x64-setup.exe.blockmap`, `${base}-win32-x64-update.yml`];
    const artifacts = [];
    for (const name of names) {
      const file = path.join(source, name);
      const value = Buffer.from(`${target}/${variant}/${name}`);
      await writeFile(file, value);
      artifacts.push({ basename: name, path: file, bytes: value.byteLength, sha256: sha(value) });
    }
    candidates.push({
      manifest: {
        target, variant,
        buildInfo: { schemaVersion: 1, kind: 'packaged', version, commit, buildId: `${target}-${variant}`, target, variant, sourceDirty: false },
        builderHost: { platform: target === 'darwin-arm64' ? 'darwin' : 'win32' },
        toolVersions: { node: 'v22.22.3' },
        signing: { policy: 'unsigned', credentialDiscovery: false, actualVerification: { kind: 'fixture' } },
        runtimeIdentity: { dependencies: null, meilisearch: null, windowsCrt: null },
      },
      artifacts,
      acceptance: { status: 'passed' },
    });
  }
  const state = await stageReleaseCandidate({
    version, tag: `v${version}`, commit,
    updateRepository: 'derektu/xr-collector',
    sourceBaseUrl: 'https://github.com/derektu/xr-collector/releases/download/v0.1.0/',
    releaseNotes: '# 0.1.0\n', acceptance: { scenarios: acceptance }, candidates,
  }, root);
  const authorization = (actions: string[], scenarios: Record<string, string> = {}, deferredScenarios: string[] = []) => ({
    schemaVersion: 1, version: state.version, tag: state.tag, commit: state.commit, confirmedAt: '2026-10-26T00:00:00.000Z', actions,
    scenarios: Object.fromEntries(Object.entries(scenarios).map(([id, status]) => [id, { status }])), deferredScenarios,
  });
  return { root, state, authorization };
}

function fakeRemote(state: Awaited<ReturnType<typeof stagedFixture>>['state']) {
  const remote: any = { tagCommit: null, release: null, createdSnapshot: null, assets: [], deletedAssets: [], failUploadAfter: null, uploadCalls: 0, hashCalls: 0 };
  remote.adapter = {
    assertRepositoryReady: async () => undefined,
    getTagCommit: async () => remote.tagCommit,
    createTag: async (_tag: string, commit: string) => { remote.tagCommit = commit; },
    getReleaseByTag: async () => remote.release && { ...remote.release, assets: [...remote.assets] },
    createDraft: async () => {
      remote.release = { id: 1, draft: true, prerelease: false, upload_url: 'fake' };
      remote.createdSnapshot = { ...remote.release, assets: [] };
      return remote.createdSnapshot;
    },
    listAssets: async () => remote.assets,
    uploadAsset: async (_release: object, file: string, name: string) => {
      remote.uploadCalls += 1;
      if (remote.failUploadAfter !== null && remote.uploadCalls > remote.failUploadAfter) throw new Error('simulated interrupted upload');
      const value = await readFile(file);
      remote.assets.push({ id: remote.assets.length + 1, name, state: 'uploaded', size: value.byteLength, sha256: sha(value) });
    },
    deleteAsset: async (asset: any) => { remote.deletedAssets.push(asset.id); remote.assets = remote.assets.filter((entry: any) => entry.id !== asset.id); },
    hashAsset: async (asset: any) => { remote.hashCalls += 1; return asset.sha256; },
    updateRelease: async (_release: object, update: any) => { remote.release = { ...remote.release, ...update, tag_name: state.tag, draft: update.draft === true || update.draft === 'true', prerelease: update.prerelease === true || update.prerelease === 'true' }; return remote.release; },
    getLatestRelease: async () => remote.release?.make_latest === 'true' ? remote.release : null,
  };
  return remote;
}

function assetFromState(asset: any, id: number) { return { id, name: asset.name, state: 'uploaded', size: asset.bytes, sha256: asset.sha256 }; }
function goodAnonymous(fixture: Awaited<ReturnType<typeof stagedFixture>>) {
  return async (input: URL | RequestInfo) => {
    const name = decodeURIComponent(new URL(input.toString()).pathname.split('/').pop()!);
    const value = await readFile(path.join(fixture.root, name));
    return new Response(value, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
}
function sha(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
async function flushMicrotasks() { await Promise.resolve(); await Promise.resolve(); }
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for release verification state.');
}
