/**
 * Why collection is paused. `sleep`: the system is suspending or asleep, dark wakes included.
 * `offline`: the device has no network, as `Connectivity` confirmed it.
 */
export type PauseReason = 'sleep' | 'offline';

/** `paused`: whether collection is paused after this change. */
export interface PauseChange {
  reason: PauseReason;
  inForce: boolean;
  paused: boolean;
}

export const PAUSE_MESSAGES: Record<PauseReason, { paused: string; resumed: string }> = {
  sleep: { paused: '系統進入睡眠，暫停收集。', resumed: '系統已喚醒，恢復收集。' },
  offline: { paused: '網路中斷，暫停收集。', resumed: '網路已恢復，恢復收集。' },
};

export class CollectionPause {
  private readonly reasons = new Set<PauseReason>();
  private readonly listeners = new Set<(change: PauseChange) => void>();

  get paused(): boolean {
    return this.reasons.size > 0;
  }

  has(reason: PauseReason): boolean {
    return this.reasons.has(reason);
  }

  /** Listeners hear only a reason that actually changes. */
  set(reason: PauseReason, inForce: boolean): void {
    if (this.reasons.has(reason) === inForce) return;
    if (inForce) this.reasons.add(reason);
    else this.reasons.delete(reason);
    const change: PauseChange = { reason, inForce, paused: this.paused };
    for (const listener of [...this.listeners]) listener(change);
  }

  /** Returns the function that unsubscribes `listener`. */
  subscribe(listener: (change: PauseChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
