import { Notification } from 'electron';
import type { SystemNotificationAdapter } from '../../domain/notifications/index.js';
import type { AutoPauseNotification, NotificationAvailability } from '../../shared/api/device-types.js';
import { limitText, redact } from '../../shared/lib/redact.js';
import type { NotificationTarget } from './notification-navigation.js';

const LAUNCH_PREFIX = 'xr-collector-notification:';

export class ElectronSystemNotifications implements SystemNotificationAdapter {
  private state: { state: NotificationAvailability; message: string | null };
  private readonly live = new Map<string, Notification>();

  constructor(private readonly activate: (target: NotificationTarget) => void, private readonly observed?: (notification: { id: string; title: string; content: string }) => void) {
    this.state = typeof Notification.isSupported !== 'function' || Notification.isSupported()
      ? { state: 'available', message: null }
      : { state: 'unavailable', message: '這個系統目前不支援 XR Collector 系統通知；訂閱提示仍會顯示在選單與圖示。' };
    if (process.platform === 'win32' && typeof Notification.handleActivation === 'function') Notification.handleActivation((details) => {
      const target = launchTarget(details.arguments);
      if (target) this.activate(target);
    });
  }

  availability(): { state: NotificationAvailability; message: string | null } { return this.state; }

  async show(event: AutoPauseNotification): Promise<void> {
    if (this.state.state === 'unavailable') throw new Error(this.state.message ?? '系統通知不可用。');
    try {
      const title = redact(`訂閱已自動暫停：${event.title}`);
      const body = redact(`連續 ${event.failureCount} 次檢查失敗。最後原因：${event.error.message}`);
      const target: NotificationTarget = { vaultId: event.vaultId, sourceType: event.sourceType, subscriptionId: event.subscriptionId };
      const notification = new Notification({
        id: event.id,
        groupId: 'subscription-auto-paused',
        title, body,
        ...(process.platform === 'win32' ? { toastXml: `<toast launch="${xml(LAUNCH_PREFIX + encodeURIComponent(JSON.stringify(target)))}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>` } : {}),
      });
      if (process.platform !== 'win32') notification.on('click', () => this.activate(target));
      this.live.set(event.id, notification);
      this.observed?.({ id: event.id, title, content: body });
      attemptDelivery(notification,
        () => { this.state = { state: 'available', message: null }; },
        (message) => { this.state = { state: 'failed', message }; });
    } catch (error) {
      this.state = { state: 'failed', message: error instanceof Error ? safeFailure(error.message) : '系統通知發送失敗。' };
      throw error;
    }
  }
}

interface DeliveryNotification {
  once(event: 'show', listener: () => void): unknown;
  once(event: 'failed', listener: (_event: unknown, error: string) => void): unknown;
  show(): void;
}

export function attemptDelivery(notification: DeliveryNotification, shown: () => void, failed: (message: string) => void): void {
  notification.once('show', shown);
  notification.once('failed', (_event, error) => failed(safeFailure(error)));
  notification.show();
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function launchTarget(argument: string): NotificationTarget | null {
  if (!argument.startsWith(LAUNCH_PREFIX)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(argument.slice(LAUNCH_PREFIX.length))) as Partial<NotificationTarget>;
    return typeof value.vaultId === 'string' && typeof value.sourceType === 'string' && typeof value.subscriptionId === 'string'
      ? { vaultId: value.vaultId, sourceType: value.sourceType, subscriptionId: value.subscriptionId } : null;
  } catch {
    return null;
  }
}
function safeFailure(value: string): string { return `系統通知發送失敗：${limitText(redact(value), 260, 'head')}`; }
