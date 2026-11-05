import type { JobError } from './job-types.js';

/**
 * Device login-startup state, shared by the Settings UI and authorized Agents. `relocated` is off
 * because the App was registered from another location (Windows) and can be turned on again here.
 */
export type LoginStartupState = 'enabled' | 'disabled' | 'requires_approval' | 'relocated' | 'unavailable';

export interface LoginStartupStatus {
  supported: boolean;
  enabled: boolean;
  state: LoginStartupState;
  message: string;
}

/** Whether the device has a network, as collection needs to know it. */
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
  delivery: 'pending' | 'attempted' | 'suppressed' | 'failed'; deliveryMessage: string | null;
}

export interface NotificationState {
  enabled: boolean; availability: NotificationAvailability; availabilityMessage: string | null;
  active: AutoPauseNotification[]; events: AutoPauseNotification[];
}

/** How the Agent listener picks its port: the first free one from the default, or one fixed port. */
export type AgentPortSetting = { mode: 'auto' } | { mode: 'fixed'; port: number };

/** The address and key an Agent connects with. */
export interface AgentConnection { url: string; token: string }

export interface AgentConnectionStatus {
  state: 'available' | 'unavailable'; activeUrl: string | null; activePort: number | null;
  configured: AgentPortSetting; restartRequired: boolean; message: string;
}
