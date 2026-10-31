import { randomBytes } from 'node:crypto';
import { formatCursor, type Change, type ChangeBatch, type ChangeCursor, type NoteChange } from './changes.js';

export * from './changes.js';

/** What a reader at a cursor receives: the batches after it, or `reset` when they are no longer all kept. */
export type Catchup = { kind: 'batches'; batches: ChangeBatch[] } | { kind: 'reset' };

export interface ChangeFeedOptions {
  now?: () => Date;
  epoch?: string;
  /** Batches kept for readers catching up; older ones answer `reset`. */
  keepBatches?: number;
  keepMs?: number;
  /** Defers publishing pending changes; the changes noted in one turn of the event loop share a revision. */
  defer?: (publish: () => void) => void;
}

export const KEEP_BATCHES = 1000;
export const KEEP_MS = 10 * 60_000;

/**
 * The process's change stream. Every component records a change once readers can see it; the
 * changes noted together are published as one batch under the next revision. Revisions start over
 * with each process, which has its own epoch, and recent batches are kept so a reader that lost
 * its connection catches up from its last revision.
 */
export class ChangeFeed {
  readonly epoch: string;
  private number = 0;
  private pending: Change[] = [];
  private scheduled = false;
  private readonly kept: Array<ChangeBatch & { number: number; time: number }> = [];
  private readonly listeners = new Set<(batch: ChangeBatch) => void>();
  private readonly now: () => Date;
  private readonly keepBatches: number;
  private readonly keepMs: number;
  private readonly defer: (publish: () => void) => void;

  constructor(options: ChangeFeedOptions = {}) {
    this.epoch = options.epoch ?? randomBytes(4).toString('hex');
    this.now = options.now ?? (() => new Date());
    this.keepBatches = options.keepBatches ?? KEEP_BATCHES;
    this.keepMs = options.keepMs ?? KEEP_MS;
    this.defer = options.defer ?? ((publish) => { setImmediate(publish); });
  }

  /** The cursor of the last published revision. */
  get revision(): string {
    return formatCursor({ epoch: this.epoch, number: this.number });
  }

  readonly note: NoteChange = (change) => {
    this.pending.push(change);
    if (this.scheduled) return;
    this.scheduled = true;
    this.defer(() => { this.flush(); });
  };

  /** Publishes the pending changes now and returns the resulting revision. */
  flush(): string {
    this.scheduled = false;
    if (this.pending.length === 0) return this.revision;
    const changes = dedupe(this.pending);
    this.pending = [];
    this.number += 1;
    const at = this.now();
    const batch: ChangeBatch = { revision: this.revision, at: at.toISOString(), changes };
    this.kept.push({ ...batch, number: this.number, time: at.getTime() });
    this.prune(at.getTime());
    for (const listener of [...this.listeners]) {
      try { listener(batch); } catch (error) { console.error('Change listener failed', error); }
    }
    return this.revision;
  }

  /** The batches after `cursor`; `reset` when it names another epoch or batches after it are no longer kept. */
  since(cursor: ChangeCursor): Catchup {
    if (cursor.epoch !== this.epoch || cursor.number > this.number) return { kind: 'reset' };
    this.prune(this.now().getTime());
    if (cursor.number === this.number) return { kind: 'batches', batches: [] };
    const first = this.kept[0];
    if (!first || first.number > cursor.number + 1) return { kind: 'reset' };
    return { kind: 'batches', batches: this.kept.filter((batch) => batch.number > cursor.number).map(publicBatch) };
  }

  /** Calls `listener` with each batch published from now on; returns the function that stops it. */
  subscribe(listener: (batch: ChangeBatch) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private prune(now: number): void {
    while (this.kept.length > this.keepBatches || (this.kept.length > 0 && now - this.kept[0]!.time > this.keepMs)) this.kept.shift();
  }
}

function publicBatch(batch: ChangeBatch): ChangeBatch {
  return { revision: batch.revision, at: batch.at, changes: batch.changes };
}

/** One entry per resource, the last noted for it; job progress noted many times in one turn keeps its last state. */
function dedupe(changes: readonly Change[]): Change[] {
  const byKey = new Map<string, Change>();
  for (const change of changes) {
    const key = changeKey(change);
    byKey.delete(key);
    byKey.set(key, change);
  }
  return [...byKey.values()];
}

function changeKey(change: Change): string {
  switch (change.kind) {
    case 'job': case 'document': return `${change.kind}:${change.id}`;
    case 'subscription': return `subscription:${change.type}:${change.id}`;
    case 'pacing': return `pacing:${change.group}`;
    case 'vault': return `vault:${change.scope}`;
    default: return change.kind;
  }
}
