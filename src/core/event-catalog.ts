import type { EventSeverity } from './activity-types.js';

/**
 * What the activity log knows about one kind of event.
 *
 * - `severity`: the severity an event of this kind is recorded with when its emitter gives none, and
 *   the one a stored line without a valid severity is read with. Emitters whose severity depends on
 *   the outcome give their own.
 * - `summary`: whether the summary view lists the event at all. Hidden kinds are process steps, such
 *   as accepting a job, that a later row already stands for.
 * - `child`: whether the summary view lists the event when it belongs to an item a subscription check
 *   queued; only the item's results and failures say something about the check.
 */
export interface EventSpec {
  severity: EventSeverity;
  summary: boolean;
  child: boolean;
}

const shown = (severity: EventSeverity): EventSpec => ({ severity, summary: true, child: false });
const itemResult = (severity: EventSeverity): EventSpec => ({ severity, summary: true, child: true });
const hidden = (severity: EventSeverity): EventSpec => ({ severity, summary: false, child: false });

/** Every named kind of event the product records. An `eventType` outside this list does not typecheck. */
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
  'document.delete_resumed': itemResult('info'),
  'document.delete_unresolved': itemResult('warning'),
  'document.recollected': itemResult('info'),
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
  'vault.transfer_cancelled': shown('info'),
  'device.login_startup_launched': shown('info'),
  'device.login_startup_enabled': shown('info'),
  'device.login_startup_disabled': shown('info'),
  'device.login_startup_failed': shown('error'),
  'device.login_startup_repaired': shown('info'),
  'device.login_startup_repair_failed': shown('error'),
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

/**
 * A pacing group's cooldown, named after the group (`<group>.rate_limited`). Plugins declare their
 * groups, so these kinds share one entry per suffix.
 */
export type PacingEventType = `${string}.rate_limited` | `${string}.cooldown_ended`;

export type EventType = NamedEventType | PacingEventType;

const PACING_EVENTS: Record<'rate_limited' | 'cooldown_ended', EventSpec> = {
  rate_limited: shown('warning'),
  cooldown_ended: shown('info'),
};

/** The catalog entry of an event kind; null for a text that names no kind, such as a stored line of another build. */
export function eventSpec(type: string): EventSpec | null {
  if (Object.hasOwn(NAMED_EVENTS, type)) return NAMED_EVENTS[type as NamedEventType];
  const dot = type.lastIndexOf('.');
  const suffix = type.slice(dot + 1);
  if (dot > 0 && Object.hasOwn(PACING_EVENTS, suffix)) return PACING_EVENTS[suffix as keyof typeof PACING_EVENTS];
  return null;
}
