import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareVersions, offerFromIndex } from '../../src/updates/release-index.js';
import { GenericIndexSource, GitHubReleasesSource } from '../../src/updates/sources.js';

const commit = 'a'.repeat(40);
const identity = { version: '0.1.0', target: 'darwin-arm64', variant: 'chinese' as const };
const buildInfo = { schemaVersion: 1, kind: 'packaged', version: '0.1.1', builtAt: '2026-10-26T00:00:00.000Z', commit,
  buildId: 'build-b', target: 'darwin-arm64', variant: 'chinese', sourceDirty: false };
function fixture() {
  const baseUrl = 'https://downloads.example.test/v0.1.1/';
  const descriptor = (name: string, body: Buffer) => ({ name, url: `${baseUrl}${name}`, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  const payload = descriptor('XR-Collector-0.1.1-chinese-mac-arm64.zip', Buffer.from('payload'));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, version: '0.1.1', commit, target: 'darwin-arm64', variant: 'chinese', buildInfo,
    artifacts: [payload] }));
  const index = { schemaVersion: 1, version: '0.1.1', tag: 'v0.1.1', commit, releaseNotes: 'Fixes', source: { id: 'mirror', baseUrl },
    candidates: [{ target: 'darwin-arm64', variant: 'chinese', updatePayload: payload, manifest: descriptor('manifest.json', manifest) }] };
  return { index, manifest };
}

describe('release index update source', () => {
  it('normalizes one target and keeps the fixed source identity', async () => {
    const { index, manifest } = fixture();
    const request = async (input: string | URL | Request) => new Response(manifest, { status: String(input).endsWith('manifest.json') ? 200 : 404 });
    const offer = await offerFromIndex(index, 'https://api.example.test/index.json', identity, request as typeof fetch);
    expect(offer).toMatchObject({ version: '0.1.1', commit, target: 'darwin-arm64', variant: 'chinese', source: { id: 'mirror' }, buildInfo: { buildId: 'build-b' } });
    expect(Object.isFrozen(offer)).toBe(true);
  });

  it.each([['0.1.0', '0.1.0', 0], ['0.1.1', '0.1.0', 1], ['0.1.0', '0.2.0', -1]])('compares stable versions', (a, b, result) => {
    expect(compareVersions(a, b)).toBe(result);
  });
  it.each(['0.1.1-test.1', 'v0.1.1', '1.2'])('rejects non-stable version %s', (version) => expect(() => compareVersions(version, '0.1.0')).toThrow(/穩定/u));

  it('rejects a missing variant and altered manifest bytes', async () => {
    const { index, manifest } = fixture();
    await expect(offerFromIndex(index, 'https://example.test/index.json', { ...identity, variant: 'official' }, fetch)).rejects.toThrow(/沒有/u);
    const request = async () => new Response(Buffer.concat([manifest, Buffer.from('x')]));
    await expect(offerFromIndex(index, 'https://example.test/index.json', identity, request as typeof fetch)).rejects.toThrow(/大小/u);
  });

  it('rejects a payload from another engine variant even when the index pins its real hash', async () => {
    const { index, manifest } = fixture(); const body = Buffer.from('official payload');
    const official = { name: 'XR-Collector-0.1.1-official-mac-arm64.zip', url: 'https://downloads.example.test/v0.1.1/XR-Collector-0.1.1-official-mac-arm64.zip',
      bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    index.candidates[0]!.updatePayload = official;
    const request = async () => new Response(manifest);
    await expect(offerFromIndex(index, 'https://example.test/index.json', identity, request as typeof fetch)).rejects.toThrow(/manifest/u);
  });

  it('discovers only a stable public GitHub JSON release and sends no credentials', async () => {
    const { index, manifest } = fixture(); const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes('/releases/latest')) return Response.json({ draft: false, prerelease: false, tag_name: 'v0.1.1', assets: [{ name: 'release-index.json', browser_download_url: 'https://downloads.example.test/v0.1.1/release-index.json' }] });
      if (url.endsWith('release-index.json')) return Response.json(index);
      return new Response(manifest);
    };
    expect(await new GitHubReleasesSource('derektu/xr-collector', request as typeof fetch).check(identity)).toMatchObject({ version: '0.1.1' });
    expect(calls.every((call) => call.init?.credentials === 'omit' && !new Headers(call.init.headers).has('authorization'))).toBe(true);
  });

  it('distinguishes no published version from a successful up-to-date check for both sources', async () => {
    const missing = (async () => new Response('missing', { status: 404 })) as typeof fetch;
    await expect(new GitHubReleasesSource('derektu/xr-collector', missing).check(identity)).rejects.toMatchObject({ code: 'update_not_published' });
    await expect(new GenericIndexSource('https://downloads.example.test/release-index.json', missing).check(identity)).rejects.toMatchObject({ code: 'update_not_published' });
  });
});
