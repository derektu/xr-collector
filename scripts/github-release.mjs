import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { verifyStagedCandidate } from './release-candidate.mjs';

const RELEASE_VERIFICATION_CONCURRENCY = 3;

export async function uploadDraftRelease(stageDirectory, adapter, authorization) {
  const state = await verifyStagedCandidate(stageDirectory);
  assertAuthorization(state, authorization, 'draft-upload');
  await adapter.assertRepositoryReady(state.sourceBaseUrl, state.updateRepository);
  await ensureTag(adapter, state, authorization);
  let release = await adapter.getReleaseByTag(state.tag);
  if (release && !release.draft) throw new Error(`Release ${state.tag} is already public and cannot be overwritten.`);
  if (!release) {
    if (!authorization.actions.includes('create-draft')) throw new Error('Authorization does not allow creating the draft release.');
    release = await adapter.createDraft({ tag: state.tag, commit: state.commit, version: state.version, notes: state.releaseNotes });
  }
  const remoteAssets = await adapter.listAssets(release);
  const remoteByName = new Map(remoteAssets.map((asset) => [asset.name, asset]));
  for (const expected of state.assets) {
    const existing = remoteByName.get(expected.name);
    if (existing) {
      const digest = await adapter.hashAsset(existing, { authenticated: true });
      if (existing.size !== expected.bytes || digest !== expected.sha256) throw new Error(`Remote asset collision has different bytes: ${expected.name}.`);
      continue;
    }
    await adapter.uploadAsset(release, path.join(stageDirectory, expected.name), expected.name);
  }
  await verifyRemoteRelease(stageDirectory, adapter, { requireDraft: true, authenticated: true });
  return release;
}

export async function verifyRemoteRelease(stageDirectory, adapter, options = {}) {
  const state = await verifyStagedCandidate(stageDirectory);
  await adapter.assertRepositoryIdentity?.(state.sourceBaseUrl, state.updateRepository);
  const release = await adapter.getReleaseByTag(state.tag);
  if (!release) throw new Error(`Remote release ${state.tag} does not exist.`);
  if (options.requireDraft && !release.draft) throw new Error(`Remote release ${state.tag} is not a draft.`);
  const tagCommit = await adapter.getTagCommit(state.tag);
  if (tagCommit !== state.commit) throw new Error(`Remote tag ${state.tag} points at stale commit ${tagCommit}.`);
  const assets = await adapter.listAssets(release);
  const expectedNames = state.assets.map((asset) => asset.name).sort();
  const actualNames = assets.map((asset) => asset.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('Remote release inventory is partial or contains unexpected assets.');
  const expectedByName = new Map(state.assets.map((asset) => [asset.name, asset]));
  await verifyConcurrently(assets, async (asset) => {
    const expected = expectedByName.get(asset.name);
    const digest = await adapter.hashAsset(asset, { authenticated: options.authenticated !== false });
    if (asset.size !== expected.bytes || digest !== expected.sha256) throw new Error(`Remote release asset does not match staged bytes: ${asset.name}.`);
  });
  return release;
}

export async function verifyAnonymousRelease(stageDirectory, request = fetch) {
  const state = await verifyStagedCandidate(stageDirectory);
  await verifyConcurrently(state.assets, async (asset) => {
    const response = await request(new URL(encodeURIComponent(asset.name), state.sourceBaseUrl), { redirect: 'follow', headers: { Accept: 'application/octet-stream' } });
    if (!response.ok || !response.body) throw new Error(`Anonymous download failed for ${asset.name}: HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type') ?? '';
    if (/text\/html/iu.test(contentType)) throw new Error(`Anonymous download returned HTML instead of ${asset.name}.`);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.byteLength; }
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error(`Anonymous download bytes do not match ${asset.name}.`);
  });
  return state;
}

async function verifyConcurrently(items, verify) {
  let nextIndex = 0;
  let failed = false;
  let firstError;
  const worker = async () => {
    while (!failed) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        await verify(items[index]);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  };
  const workers = Array.from({ length: Math.min(RELEASE_VERIFICATION_CONCURRENCY, items.length) }, () => worker());
  await Promise.all(workers);
  if (failed) throw firstError;
}

export async function publishPrerelease(stageDirectory, adapter, authorization) {
  const state = await verifyStagedCandidate(stageDirectory);
  assertAuthorization(state, authorization, 'publish-prerelease');
  assertScenarioGates(authorization, ['R35-01', 'R35-02', 'R35-03', 'R35-06'], ['R35-07']);
  await adapter.assertRepositoryReady(state.sourceBaseUrl, state.updateRepository);
  const release = await verifyRemoteRelease(stageDirectory, adapter, { requireDraft: true, authenticated: true });
  const updated = await adapter.updateRelease(release, { draft: false, prerelease: true, make_latest: 'false' });
  if (updated.draft || !updated.prerelease) throw new Error('GitHub did not publish the release as a prerelease.');
  return updated;
}

export async function promoteStableRelease(stageDirectory, adapter, authorization, request = fetch) {
  const state = await verifyStagedCandidate(stageDirectory);
  assertAuthorization(state, authorization, 'promote-stable');
  assertScenarioGates(authorization, ['R35-01', 'R35-02', 'R35-03', 'R35-04', 'R35-05', 'R35-06'], ['R35-07']);
  await adapter.assertRepositoryReady(state.sourceBaseUrl, state.updateRepository);
  const release = await verifyRemoteRelease(stageDirectory, adapter, { authenticated: true });
  if (release.draft || !release.prerelease) throw new Error('Only the already-public prerelease may be promoted.');
  await verifyAnonymousRelease(stageDirectory, request);
  const updated = await adapter.updateRelease(release, { draft: false, prerelease: false, make_latest: 'true' });
  if (updated.draft || updated.prerelease) throw new Error('GitHub did not promote the release to stable.');
  const latest = await adapter.getLatestRelease();
  if (!latest || latest.id !== updated.id || latest.tag_name !== state.tag) throw new Error('GitHub did not make the frozen release Latest.');
  return updated;
}

export function assertAuthorization(state, document, action) {
  if (document?.schemaVersion !== 1 || document.version !== state.version || document.tag !== state.tag || document.commit !== state.commit) throw new Error('Release authorization does not match the frozen candidate.');
  if (!Array.isArray(document.actions) || !document.actions.includes(action)) throw new Error(`Release authorization does not allow ${action}.`);
  if (!Number.isFinite(Date.parse(document.confirmedAt))) throw new Error('Release authorization must record when the user confirmed it.');
}

function assertScenarioGates(authorization, requiredPassed, deferrable) {
  for (const id of requiredPassed) if (authorization.scenarios?.[id]?.status !== 'passed') throw new Error(`Publication gate ${id} has not passed.`);
  for (const id of deferrable) {
    const gate = authorization.scenarios?.[id];
    if (gate?.status === 'passed') continue;
    if (gate?.status !== 'pending' || !authorization.deferredScenarios?.includes(id)) throw new Error(`Publication gate ${id} must pass or be explicitly deferred by the user.`);
  }
}

async function ensureTag(adapter, state, authorization) {
  const existing = await adapter.getTagCommit(state.tag);
  if (existing && existing !== state.commit) throw new Error(`Tag ${state.tag} already points at ${existing}, not ${state.commit}.`);
  if (!existing) {
    if (!authorization.actions.includes('create-tag')) throw new Error(`Tag ${state.tag} is missing and authorization does not allow creating it.`);
    await adapter.createTag(state.tag, state.commit);
  }
  if (await adapter.getTagCommit(state.tag) !== state.commit) throw new Error(`Tag ${state.tag} was not fixed to ${state.commit}.`);
}

export function createGitHubAdapter(repository, dependencies = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('Repository must be owner/name.');
  const gh = dependencies.gh ?? ghJson;
  const ghDownload = dependencies.ghDownload ?? downloadWithGh;
  const assertRepositoryIdentity = (sourceBaseUrl, packagedRepository) => {
    if (packagedRepository?.toLowerCase() !== repository.toLowerCase()) {
      throw new Error(`Publisher repository ${repository} differs from packaged update repository ${packagedRepository ?? 'missing'}.`);
    }
    if (sourceBaseUrl) assertGitHubSourceRepository(sourceBaseUrl, repository);
  };
  return {
    assertRepositoryIdentity,
    async assertRepositoryReady(sourceBaseUrl, packagedRepository) {
      assertRepositoryIdentity(sourceBaseUrl, packagedRepository);
      const repo = await gh(['api', `repos/${repository}`]);
      if (repo.private || repo.visibility !== 'public') throw new Error(`Repository ${repository} must be public before release staging.`);
      if (!(repo.permissions?.admin || repo.permissions?.maintain || repo.permissions?.push)) throw new Error(`Current gh account cannot publish ${repository}.`);
    },
    async getTagCommit(tag) {
      let ref;
      try { ref = await gh(['api', `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`]); } catch (error) { if (error.status === 404) return null; throw error; }
      let object = ref.object;
      while (object.type === 'tag') object = (await gh(['api', `repos/${repository}/git/tags/${object.sha}`])).object;
      if (object.type !== 'commit') throw new Error(`Tag ${tag} does not resolve to a commit.`);
      return object.sha;
    },
    createTag(tag, commit) { return gh(['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${commit}`]); },
    async getReleaseByTag(tag) {
      try { return await gh(['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`]); }
      catch (error) {
        if (error.status !== 404) throw error;
        const pages = await gh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]);
        const releases = pages.flat();
        const matches = releases.filter((release) => release.tag_name === tag);
        if (matches.length > 1) throw new Error(`GitHub returned multiple releases for ${tag}.`);
        return matches[0] ?? null;
      }
    },
    async getLatestRelease() { try { return await gh(['api', `repos/${repository}/releases/latest`]); } catch (error) { if (error.status === 404) return null; throw error; } },
    createDraft({ tag, commit, version, notes }) { return gh(['api', '--method', 'POST', `repos/${repository}/releases`, '-f', `tag_name=${tag}`, '-f', `target_commitish=${commit}`, '-f', `name=XR Collector ${version}`, '-f', `body=${notes}`, '-F', 'draft=true', '-F', 'prerelease=false', '-f', 'make_latest=false']); },
    listAssets(release) { return gh(['api', `repos/${repository}/releases/${release.id}/assets?per_page=100`]); },
    uploadAsset(release, file, name) {
      const upload = release.upload_url.replace(/\{.*$/u, '');
      return gh(['api', '--method', 'POST', '-H', 'Content-Type: application/octet-stream', '--input', file, `${upload}?name=${encodeURIComponent(name)}`]);
    },
    async hashAsset(asset) {
      const advertised = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null;
      const root = await mkdtemp(path.join(tmpdir(), 'xr-release-remote-'));
      try {
        const destination = path.join(root, 'asset');
        await ghDownload(repository, asset.id, destination);
        const digest = await sha256(destination);
        if (advertised && advertised !== digest) throw new Error(`GitHub digest disagrees with downloaded bytes for ${asset.name}.`);
        return digest;
      } finally { await rm(root, { recursive: true, force: true }); }
    },
    updateRelease(release, values) {
      const args = ['api', '--method', 'PATCH', `repos/${repository}/releases/${release.id}`];
      for (const [key, value] of Object.entries(values)) args.push(typeof value === 'boolean' ? '-F' : '-f', `${key}=${value}`);
      return gh(args);
    },
  };
}

function assertGitHubSourceRepository(sourceBaseUrl, repository) {
  const url = new URL(sourceBaseUrl);
  if (url.hostname.toLowerCase() !== 'github.com') return;
  const [owner, name, releases, download] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (`${owner}/${name}`.toLowerCase() !== repository.toLowerCase() || releases !== 'releases' || download !== 'download') {
    throw new Error(`Release source on github.com must belong to ${repository}.`);
  }
}

async function ghJson(args) {
  const { stdout, stderr, code } = await capture('gh', args);
  if (code !== 0) {
    const error = new Error(`gh request failed without exposing credentials: ${redactSensitive(stderr.trim())}`);
    const match = stderr.match(/HTTP (\d{3})/u); if (match) error.status = Number(match[1]);
    throw error;
  }
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function downloadWithGh(repository, assetId, destination) {
  const child = spawn('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${assetId}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const [code] = await Promise.all([exit, pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' }))]);
  if (code !== 0) throw new Error(`gh asset download failed without exposing credentials: ${redactSensitive(stderr.trim())}`);
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, code }));
  });
}

async function sha256(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function redactSensitive(value) { return value.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|Bearer\s+\S+|(?:GH|GITHUB)_TOKEN=\S+)/giu, '[redacted]'); }
