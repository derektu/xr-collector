/**
 * Why collection is paused. `sleep`: the system is suspending or asleep, dark wakes included.
 * `offline`: the device has no network, as `Connectivity` confirmed it.
 */
export type PauseReason = 'sleep' | 'offline';

/** One reason coming into force or lifting, and whether collection as a whole is paused after it. */
export interface PauseChange {
  reason: PauseReason;
  inForce: boolean;
  paused: boolean;
}

/** What the activity log says when a reason comes into force and when it lifts. */
export const PAUSE_MESSAGES: Record<PauseReason, { paused: string; resumed: string }> = {
  sleep: { paused: '系統進入睡眠，暫停收集。', resumed: '系統已喚醒，恢復收集。' },
  offline: { paused: '網路中斷，暫停收集。', resumed: '網路已恢復，恢復收集。' },
};

/**
 * The device's pause switch for collection, shared by the scheduler and the job managers of every
 * Vault this process opens. Collection is paused while any reason is in force: the scheduler
 * dispatches no check and the job manager starts no step.
 */
export class CollectionPause {
  private readonly reasons = new Set<PauseReason>();
  private readonly listeners = new Set<(change: PauseChange) => void>();

  get paused(): boolean {
    return this.reasons.size > 0;
  }

  has(reason: PauseReason): boolean {
    return this.reasons.has(reason);
  }

  /** Puts `reason` in force or lifts it; listeners hear only a reason that actually changes. */
  set(reason: PauseReason, inForce: boolean): void {
    if (this.reasons.has(reason) === inForce) return;
    if (inForce) this.reasons.add(reason);
    else this.reasons.delete(reason);
    const change: PauseChange = { reason, inForce, paused: this.paused };
    for (const listener of [...this.listeners]) listener(change);
  }

  /** Calls `listener` whenever a reason comes into force or lifts; returns the function that stops it. */
  subscribe(listener: (change: PauseChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
