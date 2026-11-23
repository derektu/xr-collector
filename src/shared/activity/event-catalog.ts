import type { EventSeverity } from './activity-types.js';

/**
 * - `severity`: the severity an event of this kind is recorded with when its emitter gives none, and
 *   the one a stored line without a valid severity is read with.
 * - `summary`: whether the summary view lists the event at all.
 * - `child`: whether the summary view lists the event when it belongs to an item a subscription check
 *   queued.
 */
export interface EventSpec {
  severity: EventSeverity;
  summary: boolean;
  child: boolean;
}

const shown = (severity: EventSeverity): EventSpec => ({ severity, summary: true, child: false });
const itemResult = (severity: EventSeverity): EventSpec => ({ severity, summary: true, child: true });
const hidden = (severity: EventSeverity): EventSpec => ({ severity, summary: false, child: false });

const NAMED_EVENTS = {
  'job.accepted': hidden('debug'),
  'job.started': shown('info'),
  'job.deferred': shown('debug'),
  'job.retry_scheduled': shown('warning'),
  'job.completed': shown('info'),
  'job.failed': itemResult('error'),
  'job.interrupted': shown('warning'),
  'job.resumed': shown('info'),
  'job.retry_requested': shown('info'),
  'job.dismissed': shown('info'),
  'channel.discovered': shown('debug'),
  'document.saved': itemResult('info'),
  'document.index_failed': itemResult('warning'),
  'document.deleted': itemResult('info'),
  'document.index_remove_failed': itemResult('warning'),
  'document.delete_failed': itemResult('error'),
  'document.status_changed': itemResult('info'),
  'subscription.added': shown('info'),
  'subscription.settings_updated': shown('info'),
  'subscription.settings_applied': shown('info'),
  'subscription.paused': shown('info'),
  'subscription.resumed': shown('info'),
  'subscription.removed': shown('info'),
  'subscription.auto_paused': shown('warning'),
  'subscription.item_skipped': itemResult('warning'),
  'subscription.item_failed': itemResult('warning'),
  'schedule.updated': shown('info'),
  'schedule.dispatched': hidden('debug'),
  'schedule.failed': shown('error'),
  'collection.paused': shown('info'),
  'collection.resumed': shown('info'),
  'vault.created': shown('info'),
  'vault.opened': shown('info'),
  'vault.exported': shown('info'),
  'vault.imported': shown('info'),
  'vault.transfer_failed': shown('error'),
  'device.login_startup_launched': shown('info'),
  'device.login_startup_enabled': shown('info'),
  'device.login_startup_disabled': shown('info'),
  'device.login_startup_failed': shown('error'),
  'device.agent_connection_configured': shown('info'),
  'device.agent_connection_key_reset': shown('warning'),
  'device.agent_connection_unavailable': shown('error'),
  'device.update_available': shown('info'),
  'device.update_check_failed': shown('warning'),
  'device.update_ready': shown('info'),
  'device.update_download_failed': shown('error'),
  'device.update_installed': shown('info'),
  'device.update_install_failed': shown('error'),
  'device.update_outcome_unknown': shown('warning'),
} as const satisfies Record<string, EventSpec>;

export type NamedEventType = keyof typeof NAMED_EVENTS;

export type PacingEventType = `${string}.rate_limited` | `${string}.cooldown_ended`;

export type EventType = NamedEventType | PacingEventType;

type PacingSuffix = 'rate_limited' | 'cooldown_ended';

const PACING_EVENTS: Record<PacingSuffix, EventSpec> = {
  rate_limited: shown('warning'),
  cooldown_ended: shown('info'),
};

function isNamedEvent(type: string): type is NamedEventType {
  return Object.hasOwn(NAMED_EVENTS, type);
}

function isPacingSuffix(suffix: string): suffix is PacingSuffix {
  return Object.hasOwn(PACING_EVENTS, suffix);
}

/** The catalog entry of an event kind; null for a text that names no kind. */
export function eventSpec(type: string): EventSpec | null {
  if (isNamedEvent(type)) return NAMED_EVENTS[type];
  const dot = type.lastIndexOf('.');
  const suffix = type.slice(dot + 1);
  if (dot > 0 && isPacingSuffix(suffix)) return PACING_EVENTS[suffix];
  return null;
}
