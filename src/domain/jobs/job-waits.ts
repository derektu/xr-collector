import type { CollectionJob } from '../../shared/jobs/job-types.js';
import type { Pacing } from '../pacing/index.js';

export type WaitCondition = { kind: 'held' } | CooldownWait | RetryWait;
export interface CooldownWait { kind: 'cooldown'; until: string }
export interface RetryWait { kind: 'retry'; until: string }

export interface JobWaitsOptions {
  now: () => Date;
  setTimer: (callback: () => void, ms: number) => () => void;
  gates: ReadonlyMap<string, Pacing>;
  groupOf: (job: CollectionJob) => string | null;
  held: () => boolean;
  onCooldownEnded: (group: string) => void;
  onRetryDue: (jobId: string) => void;
}

interface Timed {
  until: string;
  cancel: () => void;
}

export class JobWaits {
  private readonly cooldowns = new Map<string, Timed>();
  private readonly retries = new Map<string, Timed>();

  constructor(private readonly options: JobWaitsOptions) {}

  conditionOf(job: CollectionJob): WaitCondition | null {
    if (this.options.held()) return { kind: 'held' };
    const group = this.options.groupOf(job);
    const until = group ? this.cooldownUntil(group) : null;
    if (until) return { kind: 'cooldown', until };
    const retry = this.retries.get(job.id);
    return retry ? { kind: 'retry', until: retry.until } : null;
  }

  cooldownUntil(group: string): string | null {
    const own = this.cooldowns.get(group)?.until;
    if (own && new Date(own).getTime() > this.options.now().getTime()) return own;
    const status = this.options.gates.get(group)?.status();
    return status?.state === 'cooldown' ? status.cooldownUntil : null;
  }

  extendCooldown(group: string, until: string): 'extended' | 'already_later' {
    const current = this.cooldowns.get(group);
    if (current && current.until >= until) return 'already_later';
    current?.cancel();
    const cancel = this.options.setTimer(() => {
      if (this.cooldowns.get(group)?.until === until) this.cooldowns.delete(group);
      this.options.onCooldownEnded(group);
    }, this.remaining(until));
    this.cooldowns.set(group, { until, cancel });
    return 'extended';
  }

  endCooldown(group: string): void {
    this.cooldowns.get(group)?.cancel();
    this.cooldowns.delete(group);
  }

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

  unexpiredWaitsOf(job: CollectionJob): { cooldown: CooldownWait | null; retry: RetryWait | null } {
    const cooldownUntil = job.wait?.until;
    const retryUntil = job.retry?.nextAttemptAt;
    return {
      cooldown: cooldownUntil && this.remaining(cooldownUntil) > 0 ? { kind: 'cooldown', until: cooldownUntil } : null,
      retry: retryUntil && this.remaining(retryUntil) > 0 ? { kind: 'retry', until: retryUntil } : null,
    };
  }

  close(): void {
    for (const timed of [...this.cooldowns.values(), ...this.retries.values()]) timed.cancel();
    this.cooldowns.clear();
    this.retries.clear();
  }

  private remaining(until: string): number {
    return Math.max(0, new Date(until).getTime() - this.options.now().getTime());
  }
}
