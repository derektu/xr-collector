import { randomBytes } from 'node:crypto';
import { formatCursor, type Change, type ChangeBatch, type ChangeCursor, type NoteChange } from '../../shared/api/changes.js';
import type { LogWriter } from '../../shared/log/log-types.js';

export type Catchup = { kind: 'batches'; batches: ChangeBatch[] } | { kind: 'reset' };

export interface ChangeFeedOptions {
  log: LogWriter;
  now?: () => Date;
  epoch?: string;
  keepBatches?: number;
  keepMs?: number;
  defer?: (publish: () => void) => void;
}

export const KEEP_BATCHES = 1000;
export const KEEP_MS = 10 * 60_000;

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
  private readonly log: LogWriter;

  constructor(options: ChangeFeedOptions) {
    this.log = options.log;
    this.epoch = options.epoch ?? randomBytes(4).toString('hex');
    this.now = options.now ?? (() => new Date());
    this.keepBatches = options.keepBatches ?? KEEP_BATCHES;
    this.keepMs = options.keepMs ?? KEEP_MS;
    this.defer = options.defer ?? ((publish) => { setImmediate(publish); });
  }

  get revision(): string {
    return formatCursor({ epoch: this.epoch, number: this.number });
  }

  readonly note: NoteChange = (change) => {
    this.pending.push(change);
    if (this.scheduled) return;
    this.scheduled = true;
    this.defer(() => { this.flush(); });
  };

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
      try { listener(batch); } catch (error) { this.log.write({ level: 'error', source: 'runtime', message: 'Change listener failed', error }); }
    }
    return this.revision;
  }

  since(cursor: ChangeCursor): Catchup {
    if (cursor.epoch !== this.epoch || cursor.number > this.number) return { kind: 'reset' };
    this.prune(this.now().getTime());
    if (cursor.number === this.number) return { kind: 'batches', batches: [] };
    const first = this.kept[0];
    if (!first || first.number > cursor.number + 1) return { kind: 'reset' };
    return { kind: 'batches', batches: this.kept.filter((batch) => batch.number > cursor.number).map(publicBatch) };
  }

  /** Calls `listener` with each batch published after this call; returns the function that unsubscribes it. */
  subscribe(listener: (batch: ChangeBatch) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private prune(now: number): void {
    for (let first = this.kept[0]; first && (this.kept.length > this.keepBatches || now - first.time > this.keepMs); first = this.kept[0]) {
      this.kept.shift();
    }
  }
}

function publicBatch(batch: ChangeBatch): ChangeBatch {
  return { revision: batch.revision, at: batch.at, changes: batch.changes };
}

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
