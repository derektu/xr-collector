import { CollectorError, type UpdateOffer } from '../core/types.js';
import { fetchJson, fetchOptionalText, offerFromIndex, platformIndexName } from './release-index.js';
import type { UpdateIdentity, UpdateSource } from './types.js';

/**
 * Reads a release published as a plain directory: `release-<target>.json` and the files it names,
 * plus an optional `release-notes.md`, all under one base URL.
 */
export class GenericIndexSource implements UpdateSource {
  readonly id = 'generic-index';
  constructor(readonly baseUrl: string, private readonly request: typeof fetch = fetch) {
    validateSourceUrl(baseUrl);
    if (!new URL(baseUrl).pathname.endsWith('/')) throw new Error('Update base URL must end with /.');
  }
  async check(identity: UpdateIdentity, signal?: AbortSignal): Promise<UpdateOffer | null> {
    const indexUrl = new URL(platformIndexName(identity.target), this.baseUrl).href;
    const index = await fetchJson(indexUrl, this.request, signal);
    const releaseNotes = await fetchOptionalText(new URL('release-notes.md', this.baseUrl).href, this.request, signal);
    return offerFromIndex(index, {
      sourceId: this.id, indexUrl, releaseNotes,
      resolve: (name) => new URL(encodeURIComponent(name), this.baseUrl).href,
    }, identity);
  }
}

/**
 * Reads the latest stable GitHub Release. Each platform uploads its own index, so a Release
 * without this platform's index has no update for it yet.
 */
export class GitHubReleasesSource implements UpdateSource {
  readonly id = 'github-releases';
  constructor(private readonly repository: string, private readonly request: typeof fetch = fetch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('GitHub repository must be owner/name.');
  }
  async check(identity: UpdateIdentity, signal?: AbortSignal): Promise<UpdateOffer | null> {
    const release = await fetchJson(`https://api.github.com/repos/${this.repository}/releases/latest`, this.request, signal) as Record<string, unknown>;
    if (release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
      throw new CollectorError('update_metadata_invalid', 'GitHub latest release 不是穩定版本。');
    }
    const assets = new Map((release.assets as Array<Record<string, unknown>>)
      .filter((entry) => typeof entry.name === 'string' && typeof entry.browser_download_url === 'string')
      .map((entry) => [entry.name as string, entry.browser_download_url as string]));
    const indexUrl = assets.get(platformIndexName(identity.target));
    if (!indexUrl) return null;
    validateSourceUrl(indexUrl);
    const index = await fetchJson(indexUrl, this.request, signal);
    const tag = release.tag_name;
    return offerFromIndex(index, {
      sourceId: this.id, indexUrl, tag, releaseNotes: typeof release.body === 'string' ? release.body : '',
      resolve: (name) => {
        const url = assets.get(name);
        if (!url) throw new CollectorError('update_asset_missing', `Release ${tag} 缺少 ${name}。`);
        validateSourceUrl(url);
        return url;
      },
    }, identity);
  }
}

function validateSourceUrl(value: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search) throw new Error('Update URL cannot contain credentials, query, or fragment.');
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return;
  throw new Error('Update URL must use HTTPS, except loopback validation.');
}
