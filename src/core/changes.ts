import type { JobState } from './types.js';

/**
 * What changed, without the data itself: readers fetch the resource again. `vault` with `scope:
 * 'contents'` means the Vault's data was replaced as a whole (import, move, another Vault opened,
 * setup), so every resource reads again.
 */
export type Change =
  | { kind: 'job'; id: string; parentId: string | null; state: JobState }
  | { kind: 'document'; id: string }
  | { kind: 'subscription'; type: string; id: string }
  | { kind: 'schedule' }
  | { kind: 'connectivity' }
  | { kind: 'pacing'; group: string }
  | { kind: 'search' }
  | { kind: 'vault'; scope: 'transfer' | 'contents' }
  | { kind: 'update' }
  | { kind: 'notifications' }
  | { kind: 'activity' };

export type ChangeKind = Change['kind'];
export const CHANGE_KINDS: readonly ChangeKind[] = [
  'job', 'document', 'subscription', 'schedule', 'connectivity', 'pacing', 'search', 'vault', 'update', 'notifications', 'activity',
];

/** Records a change that readers can already see. */
export type NoteChange = (change: Change) => void;

/** The changes published under one revision. `revision` is the cursor `<epoch>:<number>`. */
export interface ChangeBatch {
  revision: string;
  at: string;
  changes: Change[];
}

/** Where a reader stands: the server instance and the last revision it has seen there. */
export interface ChangeCursor { epoch: string; number: number }

export function formatCursor(cursor: ChangeCursor): string {
  return `${cursor.epoch}:${cursor.number}`;
}

/** Parses `<epoch>:<number>`; null for anything else. */
export function parseCursor(value: unknown): ChangeCursor | null {
  if (typeof value !== 'string') return null;
  const match = /^([0-9a-f]{1,32}):(0|[1-9]\d{0,15})$/u.exec(value.trim());
  return match ? { epoch: match[1]!, number: Number(match[2]) } : null;
}
