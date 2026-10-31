import type { BuildInfo, DeviceUpdateStatus, UpdateOffer } from '../core/types.js';

export interface UpdateIdentity { version: string; target: string }
export interface UpdateSource {
  readonly id: string;
  check(identity: UpdateIdentity, signal?: AbortSignal): Promise<UpdateOffer | null>;
}
export interface NativeInstaller {
  readonly available: boolean;
  validate(offer: UpdateOffer, packageFile: string, signal?: AbortSignal): Promise<void>;
  prepare(offer: UpdateOffer, packageFile: string, signal: AbortSignal): Promise<PreparedInstall>;
  /** Reads only installer-owned receipts. The caller persists a result before invoking finalize. */
  recover?(): Promise<NativeRecoveryResult>;
}
export interface PreparedInstall {
  /** Opaque native journal identity. When present it becomes the existing install-attempt id. */
  recoveryToken?: string;
  handoff(): Promise<void>;
  cancel(): Promise<void>;
}
export interface NativeInstallRecovery {
  token: string;
  phase: 'succeeded' | 'rolled_back' | 'failed' | 'recovery_required';
  previousVersion: string;
  previousBuildId: string;
  expectedVersion: string;
  expectedBuildId: string;
  reason?: string;
  /** Removes the exact owned journal only after its result has been durably consumed. */
  finalize(): Promise<void>;
}
export interface NativeRecoveryResult { launchReady: boolean; results: NativeInstallRecovery[] }
export interface UpdateApplyRequest {
  offer: UpdateOffer;
  packageFile: string;
  signal: AbortSignal;
  recordAttempt(recoveryToken?: string): Promise<void>;
  installing(): void;
  failed(code: string, message: string): Promise<void>;
}
export interface UpdateAccess {
  status(): DeviceUpdateStatus;
  check(): Promise<DeviceUpdateStatus>;
  download(selection: UpdateSelection): Promise<DeviceUpdateStatus>;
  apply(selection: UpdateSelection): Promise<DeviceUpdateStatus>;
  cancel(): Promise<DeviceUpdateStatus>;
  /** Calls `listener` after each change of the status; returns the function that stops it. */
  subscribe?(listener: () => void): () => void;
}
export interface UpdateSelection { version: string; sha256: string }
export interface PackagedIdentity extends UpdateIdentity { buildInfo: BuildInfo }
