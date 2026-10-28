import type { JobError } from '../core/types.js';

export type NotificationAvailability = 'available' | 'unavailable' | 'failed';
export interface AutoPauseNotification {
  id: string; vaultId: string; sourceType: string; subscriptionId: string; title: string;
  failureCount: number; error: JobError; autoPausedAt: string;
  delivery: 'pending' | 'attempted' | 'suppressed' | 'failed'; deliveryMessage: string | null;
}
export interface NotificationState {
  enabled: boolean; availability: NotificationAvailability; availabilityMessage: string | null;
  active: AutoPauseNotification[]; events: AutoPauseNotification[];
}
