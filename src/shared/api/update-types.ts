export interface BuildInfo {
  schemaVersion: 1;
  kind: 'development' | 'packaged';
  version: string;
  builtAt: string;
  commit: string | null;
  buildId: string;
  target: string;
  sourceDirty: boolean | null;
}

export type UpdatePhase = 'idle' | 'checking' | 'up_to_date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

export interface UpdateSelection { version: string }

export interface UpdateOffer { version: string }

export interface UpdateInstallResult {
  version: string;
  outcome: 'installed' | 'incomplete';
  message: string;
}

export interface DeviceUpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  target: string;
  installerAvailable: boolean;
  offer: UpdateOffer | null;
  ready: UpdateOffer | null;
  lastAttempt: UpdateInstallResult | null;
  progress: { transferred: number; total: number; percent: number } | null;
  lastCheckAttemptAt: string | null;
  checkedAt: string | null;
  message: string;
  errorCode: string | null;
}
