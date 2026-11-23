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

export type UpdatePhase = 'idle' | 'checking' | 'up_to_date' | 'available' | 'downloading' | 'verifying'
  | 'ready' | 'waiting' | 'installing' | 'error';

export interface UpdateSelection { version: string; sha256: string }

export interface UpdateAsset { name: string; url: string; bytes: number; sha256: string }

export interface UpdateOffer {
  version: string;
  commit: string;
  target: string;
  releaseNotes: string;
  source: { id: string; indexUrl: string };
  payload: UpdateAsset;
  buildInfo: BuildInfo;
}

export interface UpdateInstallAttempt {
  id: string;
  version: string;
  buildId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'pending' | 'succeeded' | 'failed' | 'unknown';
  message: string;
}

export interface DeviceUpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  target: string;
  installerAvailable: boolean;
  offer: UpdateOffer | null;
  ready: UpdateOffer | null;
  lastAttempt: UpdateInstallAttempt | null;
  progress: { transferred: number; total: number; percent: number } | null;
  lastCheckAttemptAt: string | null;
  checkedAt: string | null;
  message: string;
  errorCode: string | null;
}
