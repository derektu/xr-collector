import type { Change, ChangeBatch } from '../../../shared/api/changes.js';

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

export type Refresh = { kind: 'all' } | { kind: 'changes'; changes: Change[] };
