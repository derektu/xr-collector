import { CollectorError } from '../../core/collector-error.js';
import type { SourceRegistry } from '../../core/source-registry.js';
import { addressOwner } from '../../sources/source-types.js';

export function requiredUrl(value: unknown, prompt: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new CollectorError('invalid_request', prompt);
  return value;
}

/**
 * The source type of `sources` that owns an address, with the address as that type reads it. An
 * address no type owns is `unsupported_url`, or `invalid_url` when it is not an address at all.
 */
export function ownedAddress(sources: SourceRegistry, value: string): { type: string; input: string } {
  const { input, url, owner } = addressOwner(value, sources.list);
  if (!owner) {
    throw url
      ? new CollectorError('unsupported_url', '目前還不支援這個網站的網址。')
      : new CollectorError('invalid_url', '請貼上完整網址，例如 https:// 開頭的網址。');
  }
  return { type: owner.id, input };
}
