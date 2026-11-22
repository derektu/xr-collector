import { CollectorError } from '../../../shared/lib/collector-error.js';
import type { SourceRegistry } from '../../../shared/sources/source-registry.js';
import { addressOwner } from '../../../domain/sources/index.js';

export function requiredUrl(value: unknown, prompt: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new CollectorError('invalid_request', prompt);
  return value;
}

export function ownedAddress(sources: SourceRegistry, value: string): { type: string; input: string } {
  const { input, url, owner } = addressOwner(value, sources.list);
  if (!owner) {
    throw url
      ? new CollectorError('unsupported_url', '目前還不支援這個網站的網址。')
      : new CollectorError('invalid_url', '請貼上完整網址，例如 https:// 開頭的網址。');
  }
  return { type: owner.id, input };
}
