/** The immutable artifact identity shared by the UI and authorized Agents. */
export interface BuildInfo {
  schemaVersion: 1;
  kind: 'development' | 'packaged';
  version: string;
  builtAt: string;
  commit: string | null;
  buildId: string;
  target: string;
  /** Null means source identity could not be determined; it never means a clean checkout. */
  sourceDirty: boolean | null;
}

export type UpdatePhase = 'idle' | 'checking' | 'up_to_date' | 'available' | 'downloading' | 'verifying'
  | 'ready' | 'waiting' | 'installing' | 'error';

/** The release a person chose: its version and the SHA-256 of its package. */
export interface UpdateSelection { version: string; sha256: string }

export interface UpdateAsset { name: string; url: string; bytes: number; sha256: string }

/** One immutable release choice. Latest discovery never changes an offer after it is selected. */
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

/** Device-level update state shared by the UI, tray and authorized Agent API. */
export interface DeviceUpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  target: string;
  installerAvailable: boolean;
  offer: UpdateOffer | null;
  ready: UpdateOffer | null;
  lastAttempt: UpdateInstallAttempt | null;
  progress: { transferred: number; total: number; percent: number } | null;
  /** Most recent check attempt, successful or failed; scheduling uses this to avoid retry storms. */
  lastCheckAttemptAt: string | null;
  /** Most recent successful check. */
  checkedAt: string | null;
  message: string;
  errorCode: string | null;
}
