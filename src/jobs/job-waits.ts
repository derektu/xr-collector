import type { CollectionJob } from '../core/types.js';
import type { Pacing } from '../pacing/pacing-gate.js';

/**
 * What a queued job waits for before its next step may start. `collection`: a hold or the
 * collection pause (no network, system sleep), which lifts by its own event. `cooldown`: the
 * job's pacing group cools down until `until`. `retry`: the job's next attempt starts at `until`.
 */
export type WaitCondition = { kind: 'collection' } | CooldownWait | RetryWait;
export interface CooldownWait { kind: 'cooldown'; until: string }
export interface RetryWait { kind: 'retry'; until: string }

export interface JobWaitsOptions {
  now: () => Date;
  /** Starts a timer and returns its cancel function. */
  setTimer: (callback: () => void, ms: number) => () => void;
  /** The device's request channels by pacing group; a channel cooling down holds its group's jobs. */
  gates: ReadonlyMap<string, Pacing>;
  /** The pacing group a job's requests go through; null for a type without pacing. */
  groupOf: (job: CollectionJob) => string | null;
  /** True while a hold or the collection pause keeps every queued step from starting. */
  blocked: () => boolean;
  /** A group's cooldown timer ran out. */
  onCooldownEnded: (group: string) => void;
  /** A job's retry time came. */
  onRetryDue: (jobId: string) => void;
}

interface Timed {
  until: string;
  cancel: () => void;
}

/**
 * The wait conditions of one job manager's jobs: which condition holds a job back, and the timers
 * that end the timed ones. A retry lasts until its timer calls back. A cooldown lasts until its end
 * time, or while the group's request channel still cools down; its timer tells the manager to
 * let the group's jobs go on.
 */
export class JobWaits {
  private readonly cooldowns = new Map<string, Timed>();
  private readonly retries = new Map<string, Timed>();

  constructor(private readonly options: JobWaitsOptions) {}

  /** What holds a queued job back; null when its next step may start now. */
  conditionOf(job: CollectionJob): WaitCondition | null {
    if (this.options.blocked()) return { kind: 'collection' };
    const group = this.options.groupOf(job);
    const until = group ? this.cooldownUntil(group) : null;
    if (until) return { kind: 'cooldown', until };
    const retry = this.retries.get(job.id);
    return retry ? { kind: 'retry', until: retry.until } : null;
  }

  /** The end of the cooldown in force for a pacing group, as this manager or its request channel knows it; null outside one. */
  cooldownUntil(group: string): string | null {
    const own = this.cooldowns.get(group)?.until;
    if (own && new Date(own).getTime() > this.options.now().getTime()) return own;
    const status = this.options.gates.get(group)?.status();
    return status?.state === 'cooldown' ? status.cooldownUntil : null;
  }

  /** Starts or extends a group's cooldown; false when one ending as late or later is already in force. */
  startCooldown(group: string, until: string): boolean {
    const current = this.cooldowns.get(group);
    if (current && current.until >= until) return false;
    current?.cancel();
    const cancel = this.options.setTimer(() => {
      if (this.cooldowns.get(group)?.until === until) this.cooldowns.delete(group);
      this.options.onCooldownEnded(group);
    }, this.remaining(until));
    this.cooldowns.set(group, { until, cancel });
    return true;
  }

  endCooldown(group: string): void {
    this.cooldowns.get(group)?.cancel();
    this.cooldowns.delete(group);
  }

  /** Holds a job back until its next attempt at `until`. */
  startRetry(jobId: string, until: string): void {
    this.endRetry(jobId);
    const cancel = this.options.setTimer(() => {
      this.retries.delete(jobId);
      this.options.onRetryDue(jobId);
    }, this.remaining(until));
    this.retries.set(jobId, { until, cancel });
  }

  endRetry(jobId: string): void {
    this.retries.get(jobId)?.cancel();
    this.retries.delete(jobId);
  }

  /**
   * The timed conditions a job brought across a restart, from its `wait` and `retry` fields: those
   * whose time is still ahead. A wait that ended while the service was stopped is over.
   */
  stored(job: CollectionJob): { cooldown: CooldownWait | null; retry: RetryWait | null } {
    const cooldownUntil = job.wait?.until;
    const retryUntil = job.retry?.nextAttemptAt;
    return {
      cooldown: cooldownUntil && this.remaining(cooldownUntil) > 0 ? { kind: 'cooldown', until: cooldownUntil } : null,
      retry: retryUntil && this.remaining(retryUntil) > 0 ? { kind: 'retry', until: retryUntil } : null,
    };
  }

  /** Cancels every timer; no condition ends after this. */
  close(): void {
    for (const timed of [...this.cooldowns.values(), ...this.retries.values()]) timed.cancel();
    this.cooldowns.clear();
    this.retries.clear();
  }

  private remaining(until: string): number {
    return Math.max(0, new Date(until).getTime() - this.options.now().getTime());
  }
}
