import type { AutoPauseNotification } from '../notifications/types.js';

export type NotificationNavigation = { kind: 'source'; type: string; id: string } | { kind: 'message'; message: string };

export function notificationNavigation(event: AutoPauseNotification | null, activeVaultId: string | null): NotificationNavigation {
  if (!event) return { kind: 'message', message: '找不到這則訂閱通知。' };
  if (event.vaultId !== activeVaultId) return { kind: 'message', message: '這則通知屬於其他知識庫；目前知識庫沒有切換。' };
  return { kind: 'source', type: event.sourceType, id: event.subscriptionId };
}
