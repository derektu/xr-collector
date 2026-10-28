import { CollectorError, type UpdateOffer } from '../core/types.js';
import { fetchJson, offerFromIndex } from './release-index.js';
import type { UpdateIdentity, UpdateSource } from './types.js';

export class GenericIndexSource implements UpdateSource {
  readonly id = 'generic-index';
  constructor(readonly indexUrl: string, private readonly request: typeof fetch = fetch) { validateSourceUrl(indexUrl); }
  async check(identity: UpdateIdentity, signal?: AbortSignal): Promise<UpdateOffer | null> {
    return offerFromIndex(await fetchJson(this.indexUrl, this.request, signal), this.indexUrl, identity, this.request, signal);
  }
}

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
    const asset = (release.assets as Array<Record<string, unknown>>).find((entry) => entry.name === 'release-index.json');
    if (!asset || typeof asset.browser_download_url !== 'string') throw new CollectorError('update_asset_missing', 'Release 缺少 release-index.json。');
    const indexUrl = asset.browser_download_url;
    validateSourceUrl(indexUrl);
    return offerFromIndex(await fetchJson(indexUrl, this.request, signal), indexUrl, identity, this.request, signal);
  }
}

function validateSourceUrl(value: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search) throw new Error('Update index URL cannot contain credentials, query, or fragment.');
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return;
  throw new Error('Update index URL must use HTTPS, except loopback validation.');
}
