import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareVersions, offerFromIndex } from '../../src/updates/release-index.js';
import { GenericIndexSource, GitHubReleasesSource } from '../../src/updates/sources.js';

const commit = 'a'.repeat(40);
const mac = { version: '0.1.0', target: 'darwin-arm64' };
const windows = { version: '0.1.0', target: 'win32-x64' };
const file = (name: string, body: string) => ({ name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
function platformIndex(target: 'darwin-arm64' | 'win32-x64', version = '0.1.1') {
  const update = target === 'darwin-arm64' ? file(`XR-Collector-${version}-mac-arm64.zip`, 'mac payload') : file(`XR-Collector-${version}-win-x64-setup.exe`, 'windows payload');
  return {
    schemaVersion: 1, version, commit, target,
    buildInfo: { schemaVersion: 1, kind: 'packaged', version, builtAt: '2026-10-26T00:00:00.000Z', commit, buildId: `build-${target}`, target, sourceDirty: false },
    installer: target === 'darwin-arm64' ? file(`XR-Collector-${version}-mac-arm64.dmg`, 'mac installer') : update,
    update,
  };
}
const location = { sourceId: 'mirror', indexUrl: 'https://downloads.example.test/v0.1.1/release-darwin-arm64.json', releaseNotes: 'Fixes',
  resolve: (name: string) => `https://downloads.example.test/v0.1.1/${name}` };

/** A latest-release response holding the given platform indexes and their update files. */
function github(indexes: Array<ReturnType<typeof platformIndex>>, release: Record<string, unknown> = {}) {
  const base = 'https://github.com/derektu/xr-collector/releases/download/v0.1.1/';
  const bodies = new Map<string, unknown>(indexes.map((index) => [`release-${index.target}.json`, index]));
  const names = [...bodies.keys(), ...indexes.flatMap((index) => [index.installer.name, index.update.name])];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith('/releases/latest')) {
      return Response.json({ draft: false, prerelease: false, tag_name: 'v0.1.1', body: '## 0.1.1', ...release,
        assets: [...new Set(names)].map((name) => ({ name, browser_download_url: `${base}${name}` })) });
    }
    const body = bodies.get(url.slice(base.length));
    return body ? Response.json(body) : new Response('missing', { status: 404 });
  };
  return { request: request as typeof fetch, calls };
}

describe('platform release index', () => {
  it('builds a frozen offer for its own platform from the index and the release location', () => {
    const offer = offerFromIndex(platformIndex('darwin-arm64'), location, mac);
    expect(offer).toMatchObject({ version: '0.1.1', commit, target: 'darwin-arm64', releaseNotes: 'Fixes', source: { id: 'mirror' },
      payload: { name: 'XR-Collector-0.1.1-mac-arm64.zip', url: 'https://downloads.example.test/v0.1.1/XR-Collector-0.1.1-mac-arm64.zip' },
      buildInfo: { buildId: 'build-darwin-arm64' } });
    expect(Object.isFrozen(offer)).toBe(true);
    expect(offerFromIndex(platformIndex('darwin-arm64', '0.1.0'), location, mac)).toBeNull();
  });

  it.each([['0.1.0', '0.1.0', 0], ['0.1.1', '0.1.0', 1], ['0.1.0', '0.2.0', -1]])('compares stable versions', (a, b, result) => {
    expect(compareVersions(a, b)).toBe(result);
  });
  it.each(['0.1.1-test.1', 'v0.1.1', '1.2'])('rejects non-stable version %s', (version) => expect(() => compareVersions(version, '0.1.0')).toThrow(/穩定/u));

  it('rejects another platform\'s index, a renamed payload, a mismatched BuildInfo and a version that is not the tag', () => {
    expect(() => offerFromIndex(platformIndex('win32-x64'), location, mac)).toThrow(/不是 darwin-arm64/u);
    const renamed = platformIndex('darwin-arm64'); renamed.update = { ...renamed.update, name: 'XR-Collector-0.1.1-win-x64-setup.exe' };
    expect(() => offerFromIndex(renamed, location, mac)).toThrow(/名稱/u);
    const other = platformIndex('darwin-arm64'); other.buildInfo = { ...other.buildInfo, commit: 'b'.repeat(40) };
    expect(() => offerFromIndex(other, location, mac)).toThrow(/BuildInfo/u);
    expect(() => offerFromIndex(platformIndex('darwin-arm64'), { ...location, tag: 'v0.1.2' }, mac)).toThrow(/v0.1.2/u);
  });
});

describe('GitHub Releases source', () => {
  it('reports no update to Windows while the latest Release holds only the Mac index', async () => {
    const { request, calls } = github([platformIndex('darwin-arm64')]);
    await expect(new GitHubReleasesSource('derektu/xr-collector', request).check(windows)).resolves.toBeNull();
    expect(calls.map((call) => call.url)).toEqual(['https://api.github.com/repos/derektu/xr-collector/releases/latest']);
    await expect(new GitHubReleasesSource('derektu/xr-collector', request).check(mac)).resolves.toMatchObject({ version: '0.1.1' });
  });

  it('gives each platform its own update file once both indexes are in the Release, without credentials', async () => {
    const { request, calls } = github([platformIndex('darwin-arm64'), platformIndex('win32-x64')]);
    const source = new GitHubReleasesSource('derektu/xr-collector', request);
    const [macOffer, windowsOffer] = await Promise.all([source.check(mac), source.check(windows)]);
    expect(macOffer).toMatchObject({ target: 'darwin-arm64', releaseNotes: '## 0.1.1', source: { id: 'github-releases' },
      payload: { url: 'https://github.com/derektu/xr-collector/releases/download/v0.1.1/XR-Collector-0.1.1-mac-arm64.zip' } });
    expect(windowsOffer).toMatchObject({ target: 'win32-x64', buildInfo: { buildId: 'build-win32-x64' },
      payload: { url: 'https://github.com/derektu/xr-collector/releases/download/v0.1.1/XR-Collector-0.1.1-win-x64-setup.exe' } });
    expect(calls.every((call) => call.init?.credentials === 'omit' && !new Headers(call.init.headers).has('authorization'))).toBe(true);
  });

  it('rejects a Release whose index names a missing update file or another version', async () => {
    const index = platformIndex('darwin-arm64');
    const { request } = github([index]);
    const missing = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await request(input, init);
      if (!String(input).endsWith('/releases/latest')) return response;
      const release = await response.json() as { assets: Array<{ name: string }> };
      return Response.json({ ...release, assets: release.assets.filter((asset) => asset.name !== index.update.name) });
    }) as typeof fetch;
    await expect(new GitHubReleasesSource('derektu/xr-collector', missing).check(mac)).rejects.toMatchObject({ code: 'update_asset_missing' });
    await expect(new GitHubReleasesSource('derektu/xr-collector', github([index], { tag_name: 'v0.1.2' }).request).check(mac)).rejects.toThrow(/v0.1.2/u);
  });

  it('distinguishes no published release from a successful up-to-date check', async () => {
    const missing = (async () => new Response('missing', { status: 404 })) as typeof fetch;
    await expect(new GitHubReleasesSource('derektu/xr-collector', missing).check(mac)).rejects.toMatchObject({ code: 'update_not_published' });
    await expect(new GitHubReleasesSource('derektu/xr-collector', github([platformIndex('darwin-arm64', '0.1.0')], { tag_name: 'v0.1.0' }).request).check(mac)).resolves.toBeNull();
  });
});

describe('generic index source', () => {
  it('reads its platform index and optional notes under the base URL', async () => {
    const base = 'https://downloads.example.test/xr/';
    const served = new Map<string, Response>();
    const request = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${base}release-darwin-arm64.json`) return Response.json(platformIndex('darwin-arm64'));
      return served.get(url) ?? new Response('missing', { status: 404 });
    }) as typeof fetch;
    const source = new GenericIndexSource(base, request);
    await expect(source.check(mac)).resolves.toMatchObject({ releaseNotes: '', source: { id: 'generic-index', indexUrl: `${base}release-darwin-arm64.json` },
      payload: { url: `${base}XR-Collector-0.1.1-mac-arm64.zip` } });
    served.set(`${base}release-notes.md`, new Response('## Notes'));
    await expect(source.check(mac)).resolves.toMatchObject({ releaseNotes: '## Notes' });
    await expect(source.check(windows)).rejects.toMatchObject({ code: 'update_not_published' });
    expect(() => new GenericIndexSource('https://downloads.example.test/xr', request)).toThrow(/end with/u);
  });
});
