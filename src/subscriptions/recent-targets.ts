import type { SubscriptionTarget } from '../plugins/types.js';

/** How long a preview's target stands in for resolving the same address again. */
export const RECENT_TARGET_TTL_MS = 10 * 60_000;

/**
 * Targets that previews resolved, by source type and classified address. Adding a subscription
 * right after its preview takes the target from here, so the address is resolved once; an address
 * nobody previewed, or one previewed too long ago, is resolved again.
 */
export class RecentTargets {
  private readonly entries = new Map<string, { target: SubscriptionTarget; expiresAt: number }>();

  constructor(
    private readonly ttlMs = RECENT_TARGET_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  remember(type: string, url: string, target: SubscriptionTarget): void {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(entryKey);
    this.entries.set(key(type, url), { target: { ...target }, expiresAt: now + this.ttlMs });
  }

  get(type: string, url: string): SubscriptionTarget | undefined {
    const entry = this.entries.get(key(type, url));
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key(type, url));
      return undefined;
    }
    return { ...entry.target };
  }
}

function key(type: string, url: string): string {
  return `${type}\n${url}`;
}
