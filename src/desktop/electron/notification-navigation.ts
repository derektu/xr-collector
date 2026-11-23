import type { AutoPauseNotification } from '../../shared/api/device-types.js';

export type NotificationTarget = Pick<AutoPauseNotification, 'vaultId' | 'sourceType' | 'subscriptionId'>;

export type NotificationNavigation = { kind: 'source'; type: string; id: string } | { kind: 'message'; message: string };

export function notificationNavigation(target: NotificationTarget, activeVaultId: string | null): NotificationNavigation {
  if (target.vaultId !== activeVaultId) return { kind: 'message', message: '這則通知屬於其他知識庫；目前知識庫沒有切換。' };
  return { kind: 'source', type: target.sourceType, id: target.subscriptionId };
}
