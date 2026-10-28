import { createHash } from 'node:crypto';
import { CollectorError, type BuildInfo, type UpdateAsset, type UpdateOffer } from '../core/types.js';
import { validateBuildInfo } from '../runtime/build-info.js';
import type { UpdateIdentity } from './types.js';

interface ReleaseIndex {
  schemaVersion: 1; version: string; tag: string; commit: string; releaseNotes: string;
  source: { id: string; baseUrl: string };
  candidates: Array<{ target: string; variant: string; updatePayload: unknown; manifest: unknown }>;
}
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 15_000;

export async function offerFromIndex(indexValue: unknown, indexUrl: string, identity: UpdateIdentity,
  request: typeof fetch, signal?: AbortSignal): Promise<UpdateOffer | null> {
  const index = parseIndex(indexValue);
  if (compareVersions(index.version, identity.version) <= 0) return null;
  const candidate = index.candidates.find((entry) => entry.target === identity.target && entry.variant === identity.variant);
  if (!candidate) throw new CollectorError('update_asset_missing', `版本 ${index.version} 沒有 ${identity.target}/${identity.variant} 的更新檔。`);
  const payload = parseAsset(candidate.updatePayload, 'update payload');
  const manifest = parseAsset(candidate.manifest, 'manifest');
  assertPinnedAsset(payload, index, indexUrl);
  assertPinnedAsset(manifest, index, indexUrl);
  const buildInfo = parseManifest(await fetchVerifiedJson(manifest, request, signal), index, identity, payload);
  return Object.freeze({
    version: index.version, commit: index.commit, target: identity.target, variant: identity.variant,
    releaseNotes: index.releaseNotes, source: Object.freeze({ id: index.source.id, indexUrl }),
    payload: Object.freeze(payload), manifest: Object.freeze(manifest), buildInfo,
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
  assertTransport(new URL(url));
  const response = await request(url, { signal: boundedSignal(signal), redirect: 'follow', credentials: 'omit', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new CollectorError(response.status === 404 ? 'update_not_published' : 'update_source_failed',
    response.status === 404 ? '目前沒有已發布的更新。' : `更新站點回應 ${response.status}。`);
  if (response.url) assertTransport(new URL(response.url));
  try { return JSON.parse((await readBounded(response, MAX_METADATA_BYTES)).toString('utf8')) as unknown; }
  catch (error) { throw new CollectorError('update_metadata_invalid', '更新站點回傳的 JSON 無法讀取。', { cause: error }); }
}

function parseIndex(value: unknown): ReleaseIndex {
  const fail = (): never => { throw new CollectorError('update_metadata_invalid', '更新索引格式不正確。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const index = value as Partial<ReleaseIndex>;
  if (index.schemaVersion !== 1 || typeof index.version !== 'string' || typeof index.tag !== 'string'
    || index.tag !== `v${index.version}` || typeof index.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(index.commit)
    || typeof index.releaseNotes !== 'string' || !index.source || typeof index.source.id !== 'string'
    || typeof index.source.baseUrl !== 'string' || !Array.isArray(index.candidates)) return fail();
  compareVersions(index.version, index.version);
  return index as ReleaseIndex;
}

function parseAsset(value: unknown, label: string): UpdateAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollectorError('update_metadata_invalid', `${label} 格式不正確。`);
  const asset = value as Record<string, unknown>;
  if (typeof asset.name !== 'string' || asset.name.length === 0 || /[\\/]/u.test(asset.name)
    || typeof asset.url !== 'string' || !Number.isSafeInteger(asset.bytes) || Number(asset.bytes) <= 0
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
    throw new CollectorError('update_metadata_invalid', `${label} 身分不正確。`);
  }
  return { name: asset.name, url: asset.url, bytes: Number(asset.bytes), sha256: asset.sha256 };
}

function assertPinnedAsset(asset: UpdateAsset, index: ReleaseIndex, indexUrl: string): void {
  let url: URL; let base: URL;
  try { url = new URL(asset.url); base = new URL(index.source.baseUrl); } catch (error) {
    throw new CollectorError('update_metadata_invalid', '更新網址格式不正確。', { cause: error });
  }
  assertTransport(url); assertTransport(base);
  const expected = new URL(encodeURIComponent(asset.name), base);
  if (url.username || url.password || url.search || url.hash || base.username || base.password || base.search || base.hash
    || !base.pathname.endsWith('/') || url.href !== expected.href
    || (!base.pathname.includes(`/${index.tag}/`) && !base.pathname.includes(`/${index.version}/`))) {
    throw new CollectorError('update_metadata_invalid', `更新檔 ${asset.name} 不是固定版本網址。`);
  }
  const discovery = new URL(indexUrl);
  if (discovery.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(discovery.hostname)) {
    throw new CollectorError('update_metadata_invalid', 'HTTP 更新站點只允許本機驗證。');
  }
}

async function fetchVerifiedJson(asset: UpdateAsset, request: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  if (asset.bytes > MAX_METADATA_BYTES) throw new CollectorError('update_metadata_invalid', '更新 manifest 超過大小限制。');
  const response = await request(asset.url, { signal: boundedSignal(signal), redirect: 'follow', credentials: 'omit', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new CollectorError('update_source_failed', `更新 manifest 回應 ${response.status}。`);
  if (response.url) assertTransport(new URL(response.url));
  const bytes = await readBounded(response, asset.bytes);
  if (bytes.byteLength !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new CollectorError('update_integrity_failed', '更新 manifest 的大小或雜湊不符。');
  }
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new CollectorError('update_metadata_invalid', '更新 manifest 不是有效的 JSON。', { cause: error }); }
}

function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(METADATA_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function assertTransport(url: URL): void {
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

function parseManifest(value: unknown, index: ReleaseIndex, identity: UpdateIdentity, payload: UpdateAsset): BuildInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollectorError('update_metadata_invalid', '更新 manifest 格式不正確。');
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || manifest.version !== index.version || manifest.commit !== index.commit
    || manifest.target !== identity.target || manifest.variant !== identity.variant) {
    throw new CollectorError('update_metadata_invalid', '更新 manifest 與索引的版本、平台或引擎不一致。');
  }
  if (!Array.isArray(manifest.artifacts)) throw new CollectorError('update_metadata_invalid', '更新 manifest 缺少產物清單。');
  const artifacts = manifest.artifacts.map((asset) => parseAsset(asset, 'manifest artifact'));
  if (new Set(artifacts.map((asset) => asset.name)).size !== artifacts.length) throw new CollectorError('update_metadata_invalid', '更新 manifest 的產物名稱重複。');
  const expectedName = identity.target === 'darwin-arm64'
    ? `XR-Collector-${index.version}-${identity.variant}-mac-arm64.zip`
    : `XR-Collector-${index.version}-${identity.variant}-win-x64-setup.exe`;
  const declared = artifacts.find((asset) => asset.name === payload.name);
  if (payload.name !== expectedName || !declared || declared.url !== payload.url || declared.bytes !== payload.bytes || declared.sha256 !== payload.sha256) {
    throw new CollectorError('update_metadata_invalid', '更新檔與 manifest 的平台、引擎或雜湊不一致。');
  }
  try {
    const [platform, arch] = identity.target.split('-') as [NodeJS.Platform, string];
    const info = validateBuildInfo(manifest.buildInfo, { requirePackaged: true, platform, arch });
    if (info.version !== index.version || info.commit !== index.commit || info.variant !== identity.variant) throw new Error('identity mismatch');
    return info;
  } catch (error) { throw new CollectorError('update_metadata_invalid', '更新 manifest 的 BuildInfo 不一致。', { cause: error }); }
}
