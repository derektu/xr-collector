import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AutoPauseNotification, NotificationAvailability, NotificationState } from '../../shared/api/device-types.js';
import type { CheckFailures, SubscriptionRecord } from '../../shared/subscriptions/subscription-types.js';
import { limitText, redact } from '../../shared/lib/redact.js';
import { replaceFile } from '../../shared/lib/json-file.js';
import type { LogWriter } from '../../shared/log/log-types.js';

export interface SystemNotificationAdapter {
  availability(): { state: NotificationAvailability; message: string | null };
  show(event: AutoPauseNotification): Promise<void>;
}

interface StoredState { version: 1; enabled: boolean }
interface ActiveSubscription { vaultId: string; sourceType: string; subscription: SubscriptionRecord }
type AutoPausedRecord = SubscriptionRecord & { autoPausedAt: string; checkFailures: CheckFailures };

export class NotificationCenter {
  private state: StoredState = { version: 1, enabled: true };
  private writes: Promise<void> = Promise.resolve();
  private constructor(private readonly file: string, private readonly adapter?: SystemNotificationAdapter) {}

  static async open(profilePath: string, log: LogWriter, adapter?: SystemNotificationAdapter): Promise<NotificationCenter> {
    const center = new NotificationCenter(path.join(profilePath, 'notifications.json'), adapter);
    try {
      const value = JSON.parse(await readFile(center.file, 'utf8')) as Partial<StoredState>;
      if (value.version === 1 && typeof value.enabled === 'boolean') center.state = { version: 1, enabled: value.enabled };
      else log.write({ level: 'warn', source: 'notifications', message: 'Ignoring an unreadable notification profile' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.write({ level: 'warn', source: 'notifications', message: 'Ignoring an unreadable notification profile', error });
      }
    }
    return center;
  }

  async recordAutoPause(vaultId: string, sourceType: string, record: SubscriptionRecord): Promise<void> {
    if (!isAutoPaused(record) || !this.state.enabled || !this.adapter || this.adapter.availability().state === 'unavailable') return;
    await this.adapter.show(fromSubscription(vaultId, sourceType, record));
  }

  async update(enabled: boolean): Promise<void> {
    const result = this.writes.then(async () => {
      this.state = { version: 1, enabled };
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await replaceFile(temporary, this.file);
    });
    this.writes = result.catch(() => undefined);
    await result;
  }

  view(active: readonly ActiveSubscription[]): NotificationState {
    const actionable = active.flatMap(({ vaultId, sourceType, subscription }) =>
      !subscription.enabled && isAutoPaused(subscription) ? [fromSubscription(vaultId, sourceType, subscription)] : []);
    const availability = this.adapter?.availability() ?? { state: 'unavailable' as const, message: '系統通知僅能在桌面 App 使用。' };
    return { enabled: this.state.enabled, availability: availability.state, availabilityMessage: availability.message, active: actionable };
  }
}

function isAutoPaused(record: SubscriptionRecord): record is AutoPausedRecord {
  return Boolean(record.autoPausedAt) && Boolean(record.checkFailures);
}

function fromSubscription(vaultId: string, sourceType: string, record: AutoPausedRecord): AutoPauseNotification {
  return { id: notificationId(vaultId, sourceType, record.id, record.autoPausedAt), vaultId, sourceType, subscriptionId: record.id,
    title: safe(record.title, 120), failureCount: record.checkFailures.count,
    error: { code: safe(record.checkFailures.error.code, 80), message: safe(record.checkFailures.error.message, 300) }, autoPausedAt: record.autoPausedAt };
}

function safe(value: string, max: number): string { return limitText(redact(value), max, 'head'); }

function notificationId(vaultId: string, sourceType: string, subscriptionId: string, autoPausedAt: string): string {
  return createHash('sha256').update(JSON.stringify([vaultId, sourceType, subscriptionId, autoPausedAt])).digest('hex');
}
