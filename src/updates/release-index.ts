import { CollectorError, type BuildInfo, type UpdateOffer } from '../core/types.js';
import { validateBuildInfo } from '../runtime/build-info.js';
import type { UpdateIdentity } from './types.js';

/**
 * One platform's release index, `release-<target>.json`, written by `package:*` next to the
 * installers. A release carries one index per platform; files are named, not linked, so the
 * source resolves each name to a URL in the release that holds the index.
 */
interface PlatformIndex {
  schemaVersion: 1; version: string; commit: string; target: string; buildInfo: unknown;
  installer: IndexedFile; update: IndexedFile;
}
interface IndexedFile { name: string; bytes: number; sha256: string }

/** Where an index was found: its URL, the release notes, and how its file names become URLs. */
export interface IndexLocation {
  sourceId: string;
  indexUrl: string;
  /** The tag of the release holding the index; its version must match. */
  tag?: string;
  releaseNotes: string;
  resolve(name: string): string;
}

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 15_000;

export function platformIndexName(target: string): string {
  return `release-${target}.json`;
}

export function offerFromIndex(indexValue: unknown, location: IndexLocation, identity: UpdateIdentity): UpdateOffer | null {
  const index = parseIndex(indexValue);
  if (index.target !== identity.target) throw new CollectorError('update_metadata_invalid', `更新索引的平台是 ${index.target}，不是 ${identity.target}。`);
  if (location.tag !== undefined && location.tag !== `v${index.version}`) {
    throw new CollectorError('update_metadata_invalid', `Release ${location.tag} 的更新索引是版本 ${index.version}。`);
  }
  if (compareVersions(index.version, identity.version) <= 0) return null;
  const expectedName = identity.target === 'darwin-arm64'
    ? `XR-Collector-${index.version}-mac-arm64.zip`
    : `XR-Collector-${index.version}-win-x64-setup.exe`;
  if (index.update.name !== expectedName) throw new CollectorError('update_metadata_invalid', '更新檔名稱與版本或平台不一致。');
  let buildInfo: BuildInfo;
  try {
    const [platform, arch] = identity.target.split('-') as [NodeJS.Platform, string];
    buildInfo = validateBuildInfo(index.buildInfo, { requirePackaged: true, platform, arch });
    if (buildInfo.version !== index.version || buildInfo.commit !== index.commit) throw new Error('identity mismatch');
  } catch (error) { throw new CollectorError('update_metadata_invalid', '更新索引的 BuildInfo 不一致。', { cause: error }); }
  const url = location.resolve(index.update.name);
  assertTransport(new URL(url));
  return Object.freeze({
    version: index.version, commit: index.commit, target: identity.target, releaseNotes: location.releaseNotes,
    source: Object.freeze({ id: location.sourceId, indexUrl: location.indexUrl }),
    payload: Object.freeze({ ...index.update, url }), buildInfo,
  });
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string): [number, number, number] => {
    if (!/^\d+\.\d+\.\d+$/u.test(value)) throw new CollectorError('update_metadata_invalid', '更新版本必須是穩定的 major.minor.patch。');
    return value.split('.').map(Number) as [number, number, number];
  };
  const left = parse(a); const right = parse(b);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index]! > right[index]! ? 1 : -1;
  return 0;
}

export async function fetchJson(url: string, request: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const body = await fetchMetadata(url, 'application/json', request, signal);
  try { return JSON.parse(body.toString('utf8')) as unknown; }
  catch (error) { throw new CollectorError('update_metadata_invalid', '更新站點回傳的 JSON 無法讀取。', { cause: error }); }
}

/** Reads a text file that a release may omit; a 404 reads as empty. */
export async function fetchOptionalText(url: string, request: typeof fetch, signal?: AbortSignal): Promise<string> {
  try { return (await fetchMetadata(url, 'text/plain', request, signal)).toString('utf8'); }
  catch (error) { if (error instanceof CollectorError && error.code === 'update_not_published') return ''; throw error; }
}

async function fetchMetadata(url: string, accept: string, request: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  assertTransport(new URL(url));
  const response = await request(url, { signal: boundedSignal(signal), redirect: 'follow', credentials: 'omit', headers: { Accept: accept } });
  if (!response.ok) throw new CollectorError(response.status === 404 ? 'update_not_published' : 'update_source_failed',
    response.status === 404 ? '目前沒有已發布的更新。' : `更新站點回應 ${response.status}。`);
  if (response.url) assertTransport(new URL(response.url));
  return readBounded(response, MAX_METADATA_BYTES);
}

function parseIndex(value: unknown): PlatformIndex {
  const fail = (): never => { throw new CollectorError('update_metadata_invalid', '更新索引格式不正確。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const index = value as Partial<PlatformIndex>;
  if (index.schemaVersion !== 1 || typeof index.version !== 'string' || typeof index.commit !== 'string'
    || !/^[a-f0-9]{40}$/u.test(index.commit) || typeof index.target !== 'string'
    || !isIndexedFile(index.installer) || !isIndexedFile(index.update)) return fail();
  compareVersions(index.version, index.version);
  return index as PlatformIndex;
}

function isIndexedFile(value: unknown): value is IndexedFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return typeof file.name === 'string' && file.name.length > 0 && !/[\\/]/u.test(file.name)
    && Number.isSafeInteger(file.bytes) && Number(file.bytes) > 0
    && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(file.sha256);
}

function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(METADATA_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export function assertTransport(url: URL): void {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return;
  throw new CollectorError('update_metadata_invalid', '更新站點與重新導向必須使用 HTTPS；HTTP 只允許本機驗證。');
}
async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new CollectorError('update_metadata_invalid', '更新 metadata 超過大小限制。');
  if (!response.body) return Buffer.alloc(0);
  const parts: Buffer[] = []; let total = 0; const reader = response.body.getReader();
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    total += part.value.byteLength;
    if (total > maximum) { await reader.cancel(); throw new CollectorError('update_metadata_invalid', '更新 metadata 超過大小限制。'); }
    parts.push(Buffer.from(part.value));
  }
  return Buffer.concat(parts, total);
}
