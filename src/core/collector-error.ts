/**
 * The code of a `CollectorError`: one of the core's own codes, or a code a source type raises and
 * declares with its HTTP status (`errorStatus` of its definition).
 */
export type CollectorErrorCode = CoreErrorCode | (string & {});

/** The error codes the core raises, each with a fixed HTTP status. */
export type CoreErrorCode =
  | 'too_many_streams'
  | 'vault_busy'
  | 'vault_not_ready'
  | 'vault_invalid'
  | 'vault_already_set'
  | 'invalid_url'
  | 'invalid_subscription'
  | 'network_error'
  | 'offline'
  | 'rate_limited'
  | 'capture_failed'
  | 'document_not_found'
  | 'document_deleted'
  | 'search_unavailable'
  | 'subscription_not_found'
  | 'subscription_paused'
  | 'out_of_range'
  | 'job_not_found'
  | 'job_not_retryable'
  | 'job_not_dismissable'
  | 'unsupported_url'
  | 'queue_full'
  | 'file_exists'
  | 'transfer_cancelled'
  | 'vault_location_fixed'
  | 'insufficient_space'
  | 'activity_snapshot_expired'
  | 'activity_group_expired'
  | 'login_startup_unavailable'
  | 'login_startup_requires_approval'
  | 'login_startup_failed'
  | 'agent_connection_unavailable'
  | 'update_busy'
  | 'update_cancelled'
  | 'update_source_failed'
  | 'update_not_published'
  | 'update_metadata_invalid'
  | 'update_asset_missing'
  | 'update_not_available'
  | 'update_offer_changed'
  | 'update_download_failed'
  | 'update_integrity_failed'
  | 'update_not_ready'
  | 'update_install_unavailable'
  | 'update_apply_failed'
  | 'invalid_request';

export class CollectorError extends Error {
  readonly code: CollectorErrorCode;
  /** Diagnostic output of an external tool, such as its stderr; masked and shortened before it is recorded. */
  readonly detail: string | undefined;
  /** For `rate_limited`: when the source's requests continue. */
  readonly retryAt: string | undefined;

  constructor(code: CollectorErrorCode, message: string, options?: ErrorOptions & { detail?: string; retryAt?: string }) {
    super(message, options);
    this.name = 'CollectorError';
    this.code = code;
    this.detail = options?.detail;
    this.retryAt = options?.retryAt;
  }
}
