import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SubscriptionRecord } from '../core/types.js';
import type { AutoPauseNotification, NotificationAvailability, NotificationState } from './types.js';
import { limitText, redact } from '../activity/redact.js';
export type { AutoPauseNotification, NotificationAvailability, NotificationState } from './types.js';

export interface SystemNotificationAdapter {
  availability(): { state: NotificationAvailability; message: string | null };
  show(event: AutoPauseNotification): Promise<void>;
  restore(events: readonly AutoPauseNotification[]): Promise<void>;
  onDeliveryFailure?(listener: (id: string, message: string) => void): void;
}

interface StoredState { version: 1; enabled: boolean; events: AutoPauseNotification[] }
export interface ActiveSubscription { vaultId: string; sourceType: string; subscription: SubscriptionRecord }

export class NotificationCenter {
  private state: StoredState = { version: 1, enabled: true, events: [] };
  private writes: Promise<void> = Promise.resolve();
  private constructor(private readonly file: string, private readonly adapter?: SystemNotificationAdapter) {}

  static async open(profilePath: string, adapter?: SystemNotificationAdapter): Promise<NotificationCenter> {
    const center = new NotificationCenter(path.join(profilePath, 'notifications.json'), adapter);
    adapter?.onDeliveryFailure?.((id, message) => {
      void center.deliveryFailed(id, message).catch((error: unknown) => console.warn('Unable to save notification delivery failure', error));
    });
    try {
      const value = JSON.parse(await readFile(center.file, 'utf8')) as StoredState;
      if (value.version !== 1 || typeof value.enabled !== 'boolean' || !Array.isArray(value.events)) throw new Error('invalid notification profile');
      center.state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring unreadable notification profile', error);
    }
    if (adapter) await adapter.restore(center.state.events).catch((error: unknown) => console.warn('Unable to restore notification activation', error));
    return center;
  }

  async recordAutoPause(vaultId: string, sourceType: string, record: SubscriptionRecord): Promise<void> {
    await this.serial(async () => {
      if (!record.autoPausedAt || !record.checkFailures) return;
      const id = eventId(vaultId, sourceType, record.id, record.autoPausedAt);
      if (this.state.events.some((event) => event.id === id)) return;
      const event = fromSubscription(vaultId, sourceType, record, id);
      event.delivery = this.state.enabled && this.adapter && this.adapter.availability().state !== 'unavailable' ? 'pending' : 'suppressed';
      this.state.events.push(event);
      await this.save();
      if (event.delivery !== 'pending' || !this.adapter) return;
      try { await this.adapter.show(event); event.delivery = 'attempted'; }
      catch (error) { event.delivery = 'failed'; event.deliveryMessage = safe(error instanceof Error ? error.message : '系統通知發送失敗。', 300); }
      await this.save();
    });
  }

  async update(enabled: boolean): Promise<void> {
    await this.serial(async () => {
      this.state.enabled = enabled;
      if (!enabled) for (const event of this.state.events) if (event.delivery === 'pending') event.delivery = 'suppressed';
      await this.save();
    });
  }

  view(active: readonly ActiveSubscription[], activeVaultId: string | null): NotificationState {
    const actionable = active.filter(({ subscription }) => !subscription.enabled && Boolean(subscription.autoPausedAt) && Boolean(subscription.checkFailures))
      .map(({ vaultId, sourceType, subscription }) => {
        const id = eventId(vaultId, sourceType, subscription.id, subscription.autoPausedAt!);
        return this.state.events.find((event) => event.id === id) ?? fromSubscription(vaultId, sourceType, subscription, id);
      });
    const availability = this.adapter?.availability() ?? { state: 'unavailable' as const, message: '系統通知僅能在桌面 App 使用。' };
    return { enabled: this.state.enabled, availability: availability.state, availabilityMessage: availability.message,
      active: actionable, events: activeVaultId ? this.state.events.filter((event) => event.vaultId === activeVaultId) : [] };
  }

  event(id: string): AutoPauseNotification | null { return this.state.events.find((event) => event.id === id) ?? null; }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }
  private serial(work: () => Promise<void>): Promise<void> {
    const result = this.writes.then(work);
    this.writes = result.catch(() => undefined);
    return result;
  }
  private deliveryFailed(id: string, message: string): Promise<void> {
    return this.serial(async () => {
      const event = this.state.events.find((candidate) => candidate.id === id);
      if (!event) return;
      event.delivery = 'failed';
      event.deliveryMessage = safe(message, 300);
      await this.save();
    });
  }
}

function fromSubscription(vaultId: string, sourceType: string, record: SubscriptionRecord, id: string): AutoPauseNotification {
  return { id, vaultId, sourceType, subscriptionId: record.id, title: safe(record.title, 120),
    failureCount: record.checkFailures!.count,
    error: { code: safe(record.checkFailures!.error.code, 80), message: safe(record.checkFailures!.error.message, 300) }, autoPausedAt: record.autoPausedAt!,
    delivery: 'suppressed', deliveryMessage: null };
}

function safe(value: string, max: number): string { return limitText(redact(value), max, 'head'); }

export function eventId(vaultId: string, sourceType: string, subscriptionId: string, autoPausedAt: string): string {
  return createHash('sha256').update(JSON.stringify([vaultId, sourceType, subscriptionId, autoPausedAt])).digest('hex');
}
