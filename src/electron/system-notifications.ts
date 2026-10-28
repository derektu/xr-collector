import { Notification } from 'electron';
import type { AutoPauseNotification, NotificationAvailability, SystemNotificationAdapter } from '../notifications/notification-center.js';
import { limitText, redact } from '../activity/redact.js';

export class ElectronSystemNotifications implements SystemNotificationAdapter {
  private state: { state: NotificationAvailability; message: string | null };
  private readonly live = new Map<string, Notification>();
  private events: readonly AutoPauseNotification[] = [];
  private failureListener?: (id: string, message: string) => void;

  constructor(private readonly activate: (id: string) => void, private readonly observed?: (notification: { id: string; title: string; content: string }) => void) {
    this.state = typeof Notification.isSupported !== 'function' || Notification.isSupported()
      ? { state: 'available', message: null }
      : { state: 'unavailable', message: '這個系統目前不支援 XR Collector 系統通知；訂閱提示仍會顯示在選單與圖示。' };
    if (process.platform === 'win32' && typeof Notification.handleActivation === 'function') Notification.handleActivation((details) => {
      const prefix = 'xr-collector-notification:';
      if (details.arguments.startsWith(prefix)) this.activate(decodeURIComponent(details.arguments.slice(prefix.length)));
    });
  }

  availability(): { state: NotificationAvailability; message: string | null } { return this.state; }
  onDeliveryFailure(listener: (id: string, message: string) => void): void { this.failureListener = listener; }

  async show(event: AutoPauseNotification): Promise<void> {
    if (this.state.state === 'unavailable') throw new Error(this.state.message ?? '系統通知不可用。');
    try {
      const title = `訂閱已自動暫停：${event.title}`;
      const body = `連續 ${event.failureCount} 次檢查失敗。最後原因：${event.error.message}`;
      const notification = new Notification({
        id: event.id,
        groupId: 'subscription-auto-paused',
        title, body,
        ...(process.platform === 'win32' ? { toastXml: `<toast launch="xr-collector-notification:${encodeURIComponent(event.id)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>` } : {}),
      });
      if (process.platform !== 'win32') notification.on('click', () => this.activate(event.id));
      this.live.set(event.id, notification);
      this.observed?.({ id: event.id, title, content: body });
      attemptDelivery(notification, event.id,
        () => { this.state = { state: 'available', message: null }; },
        (message) => { this.state = { state: 'failed', message }; this.failureListener?.(event.id, message); });
    } catch (error) {
      this.state = { state: 'failed', message: error instanceof Error ? safeFailure(error.message) : '系統通知發送失敗。' };
      throw error;
    }
  }

  async restore(events: readonly AutoPauseNotification[]): Promise<void> {
    this.events = events;
    if (process.platform !== 'darwin' || this.state.state !== 'available') return;
    const ids = new Set(events.map((event) => event.id));
    for (const notification of await Notification.getHistory()) {
      if (!ids.has(notification.id)) continue;
      notification.on('click', () => this.activate(notification.id));
      this.live.set(notification.id, notification);
    }
  }
}

interface DeliveryNotification {
  once(event: 'show', listener: () => void): unknown;
  once(event: 'failed', listener: (_event: unknown, error: string) => void): unknown;
  show(): void;
}

/** Hands the notification to the OS immediately; async OS events update diagnostics without blocking collection. */
export function attemptDelivery(notification: DeliveryNotification, _id: string, shown: () => void, failed: (message: string) => void): void {
  notification.once('show', shown);
  notification.once('failed', (_event, error) => failed(safeFailure(error)));
  notification.show();
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function safeFailure(value: string): string { return `系統通知發送失敗：${limitText(redact(value), 260, 'head')}`; }
