import { parseCursor, type Change, type ChangeBatch } from '../core/changes.js';

export type { Change, ChangeBatch };

/** What a screen shows; each is stale after the changes `STALE_AFTER` names. */
export type Resource =
  | 'activeJobs' | 'jobs' | 'schedule' | 'subscriptions' | 'documents' | 'activity'
  | 'search' | 'transfer' | 'vaultSetup' | 'update';

const STALE_AFTER: Record<Resource, readonly Change['kind'][]> = {
  activeJobs: ['job', 'pacing', 'connectivity'],
  jobs: ['job', 'pacing', 'connectivity'],
  schedule: ['schedule', 'subscription', 'connectivity'],
  // A subscription's status and counts come from its jobs, documents, cooldowns and the schedule.
  subscriptions: ['subscription', 'document', 'job', 'pacing', 'schedule', 'connectivity'],
  documents: ['document', 'subscription'],
  activity: ['activity', 'subscription'],
  search: ['search', 'document'],
  transfer: ['vault'],
  vaultSetup: ['vault'],
  update: ['update'],
};

/** A Vault whose data was replaced, which makes everything any screen shows stale. */
export function replacesEverything(change: Change): boolean {
  return change.kind === 'vault' && change.scope === 'contents';
}

/** A change the reader of `resources` must read again after. */
export function staleAfter(resources: readonly Resource[]): (change: Change) => boolean {
  const kinds = new Set(resources.flatMap((resource) => STALE_AFTER[resource]));
  return (change) => replacesEverything(change) || kinds.has(change.kind);
}

/** One message of the event stream. */
export type StreamMessage =
  | { type: 'hello'; revision: string }
  | { type: 'reset'; revision: string }
  | { type: 'change'; batch: ChangeBatch };

/** What a stream message asks of the screen: nothing, read everything again, or read again after these changes. */
export type Refresh = { kind: 'none' } | { kind: 'all' } | { kind: 'changes'; changes: Change[] };

/** True when the screen at `shown` has caught up with `target`: same server instance, revision at least as new. */
export function caughtUp(shown: string | null, target: string): boolean {
  const a = shown ? parseCursor(shown) : null;
  const b = parseCursor(target);
  return !!a && !!b && a.epoch === b.epoch && a.number >= b.number;
}

/**
 * Follows the stream from the last revision received (`revision`, null before the first message).
 * A batch already received is ignored; a `hello` from another server instance, or a `reset`,
 * makes the screen read everything again.
 */
export function receive(revision: string | null, message: StreamMessage): { revision: string | null; refresh: Refresh } {
  if (message.type === 'reset') return { revision: message.revision, refresh: { kind: 'all' } };
  if (message.type === 'hello') {
    if (revision === null) return { revision: message.revision, refresh: { kind: 'none' } };
    const known = parseCursor(revision);
    const next = parseCursor(message.revision);
    // A hello on the same instance precedes the batches it replays; another instance knows nothing of ours.
    return known && next && known.epoch === next.epoch
      ? { revision, refresh: { kind: 'none' } }
      : { revision: message.revision, refresh: { kind: 'all' } };
  }
  if (revision !== null && caughtUp(revision, message.batch.revision)) return { revision, refresh: { kind: 'none' } };
  return { revision: message.batch.revision, refresh: { kind: 'changes', changes: message.batch.changes } };
}
