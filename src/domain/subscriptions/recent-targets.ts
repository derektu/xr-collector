import type { SubscriptionTarget } from '../../shared/sources/source-contract.js';

export const RECENT_TARGET_TTL_MS = 10 * 60_000;

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
