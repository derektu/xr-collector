import type { JobState } from '../jobs/job-types.js';

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

export interface ChangeBatch {
  revision: string;
  at: string;
  changes: Change[];
}

export interface ChangeCursor { epoch: string; number: number }

export function formatCursor(cursor: ChangeCursor): string {
  return `${cursor.epoch}:${cursor.number}`;
}

/** Parses `<epoch>:<number>`; null for anything else. */
export function parseCursor(value: unknown): ChangeCursor | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[0-9a-f]{1,32}:(0|[1-9]\d{0,15})$/u.test(text)) return null;
  const separator = text.indexOf(':');
  return { epoch: text.slice(0, separator), number: Number(text.slice(separator + 1)) };
}
