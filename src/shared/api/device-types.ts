import type { JobError } from '../jobs/job-types.js';

export type LoginStartupState = 'enabled' | 'disabled' | 'requires_approval' | 'unavailable';

export interface LoginStartupStatus {
  supported: boolean;
  enabled: boolean;
  state: LoginStartupState;
  message: string;
}

export type DesktopPlatform = 'darwin' | 'win32' | 'other';

export type ConnectivityState = 'online' | 'offline';

export interface ConnectivityStatus {
  state: ConnectivityState;
  /** The last confirmation of the device's network; null before the first one. */
  checkedAt: string | null;
}

export type CollectorRuntimeState = 'starting' | 'ready' | 'not_ready' | 'stopping' | 'stopped' | 'unavailable';

export interface CollectorRuntimeStatus {
  state: CollectorRuntimeState;
  instanceId: string;
  profilePath: string;
  vaultPath: string | null;
  message: string;
}

export type NotificationAvailability = 'available' | 'unavailable' | 'failed';

export interface AutoPauseNotification {
  id: string; vaultId: string; sourceType: string; subscriptionId: string; title: string;
  failureCount: number; error: JobError; autoPausedAt: string;
}

export interface NotificationState {
  enabled: boolean; availability: NotificationAvailability; availabilityMessage: string | null;
  active: AutoPauseNotification[];
}

/** How the Agent listener picks its port: the first free one of the preferred range, else any free port; or one fixed port. */
export type AgentPortSetting = { mode: 'auto' } | { mode: 'fixed'; port: number };

export interface AgentConnection { url: string; token: string }

export interface AgentConnectionStatus {
  state: 'available' | 'unavailable'; activeUrl: string | null; activePort: number | null;
  configured: AgentPortSetting; restartRequired: boolean; message: string;
}

export interface NotificationAccess {
  read(): Promise<NotificationState>;
  update(enabled: boolean): Promise<NotificationState>;
}
