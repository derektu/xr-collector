import { parseCursor, type Change, type ChangeBatch } from '../../shared/api/changes.js';

export type { Change, ChangeBatch };

export type Resource =
  | 'activeJobs' | 'jobs' | 'schedule' | 'subscriptions' | 'documents' | 'activity'
  | 'search' | 'transfer' | 'vaultSetup' | 'update';

const STALE_AFTER: Record<Resource, readonly Change['kind'][]> = {
  activeJobs: ['job', 'pacing', 'connectivity'],
  jobs: ['job', 'pacing', 'connectivity'],
  schedule: ['schedule', 'subscription', 'connectivity'],
  subscriptions: ['subscription', 'document', 'job', 'pacing', 'schedule', 'connectivity'],
  documents: ['document', 'subscription'],
  activity: ['activity', 'subscription'],
  search: ['search', 'document'],
  transfer: ['vault'],
  vaultSetup: ['vault'],
  update: ['update'],
};

export function replacesEverything(change: Change): boolean {
  return change.kind === 'vault' && change.scope === 'contents';
}

export function staleAfter(resources: readonly Resource[]): (change: Change) => boolean {
  const kinds = new Set(resources.flatMap((resource) => STALE_AFTER[resource]));
  return (change) => replacesEverything(change) || kinds.has(change.kind);
}

export type StreamMessage =
  | { type: 'hello'; revision: string }
  | { type: 'reset'; revision: string }
  | { type: 'change'; batch: ChangeBatch };

export type Refresh = { kind: 'none' } | { kind: 'all' } | { kind: 'changes'; changes: Change[] };

export function caughtUp(shown: string | null, target: string): boolean {
  const a = shown ? parseCursor(shown) : null;
  const b = parseCursor(target);
  return !!a && !!b && a.epoch === b.epoch && a.number >= b.number;
}

export function receive(revision: string | null, message: StreamMessage): { revision: string | null; refresh: Refresh } {
  if (message.type === 'reset') return { revision: message.revision, refresh: { kind: 'all' } };
  if (message.type === 'hello') {
    if (revision === null) return { revision: message.revision, refresh: { kind: 'none' } };
    const known = parseCursor(revision);
    const next = parseCursor(message.revision);
    return known && next && known.epoch === next.epoch
      ? { revision, refresh: { kind: 'none' } }
      : { revision: message.revision, refresh: { kind: 'all' } };
  }
  if (revision !== null && caughtUp(revision, message.batch.revision)) return { revision, refresh: { kind: 'none' } };
  return { revision: message.batch.revision, refresh: { kind: 'changes', changes: message.batch.changes } };
}
