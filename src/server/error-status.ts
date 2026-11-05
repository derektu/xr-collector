import type { CoreErrorCode } from '../core/collector-error.js';
import type { SourceRegistry } from '../core/source-registry.js';

const ERROR_STATUS: Record<CoreErrorCode, number> = {
  too_many_streams: 503,
  vault_busy: 409,
  vault_not_ready: 503,
  vault_invalid: 422,
  vault_already_set: 409,
  invalid_url: 400,
  invalid_subscription: 400,
  invalid_request: 400,
  document_not_found: 404,
  document_deleted: 404,
  search_unavailable: 503,
  subscription_not_found: 404,
  subscription_paused: 409,
  out_of_range: 422,
  job_not_found: 404,
  job_not_retryable: 409,
  job_not_dismissable: 409,
  unsupported_url: 400,
  queue_full: 503,
  file_exists: 409,
  transfer_cancelled: 409,
  vault_location_fixed: 409,
  insufficient_space: 507,
  login_startup_unavailable: 409,
  login_startup_requires_approval: 409,
  login_startup_failed: 500,
  agent_connection_unavailable: 409,
  update_busy: 409,
  update_cancelled: 409,
  update_source_failed: 502,
  update_not_published: 404,
  update_metadata_invalid: 502,
  update_asset_missing: 409,
  update_not_available: 409,
  update_offer_changed: 409,
  update_download_failed: 502,
  update_integrity_failed: 422,
  update_not_ready: 409,
  update_install_unavailable: 409,
  update_apply_failed: 500,
  capture_failed: 502,
  network_error: 503,
  offline: 503,
  rate_limited: 503,
  activity_snapshot_expired: 410,
  activity_group_expired: 410,
};

/** The HTTP status of an error code: the core's own, else the one a source type of `sources` declares, else 500. */
export function errorStatus(sources: SourceRegistry, code: string): number {
  const core = (ERROR_STATUS as Record<string, number>)[code];
  if (core !== undefined) return core;
  for (const definition of sources.definitions) {
    const declared = definition.errorStatus?.[code];
    if (declared !== undefined) return declared;
  }
  return 500;
}

/** The 4xx status Fastify gave an error about the request itself, or null for any other error. */
export function requestErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('statusCode' in error) || typeof error.statusCode !== 'number') return null;
  return error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : null;
}

export function requestErrorMessage(status: number, error: unknown): string {
  if (status === 413) return '請求內容過大。';
  if (status === 415) return '請以 JSON 送出請求；檔案以本機的完整路徑指定。';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'FST_ERR_CTP_EMPTY_JSON_BODY') return '請求宣告為 JSON，但內容是空的。';
  if (code === 'FST_ERR_CTP_INVALID_JSON_BODY') return '請求內容不是有效的 JSON。';
  return '請求格式不正確。';
}
