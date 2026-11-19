import type { BuildInfo, DeviceUpdateStatus, UpdateOffer, UpdateSelection } from '../../shared/api/update-types.js';

export interface UpdateIdentity { version: string; target: string }
export interface UpdateSource {
  readonly id: string;
  check(identity: UpdateIdentity, signal?: AbortSignal): Promise<UpdateOffer | null>;
}
export interface NativeInstaller {
  readonly available: boolean;
  validate(offer: UpdateOffer, packageFile: string, signal?: AbortSignal): Promise<void>;
  prepare(offer: UpdateOffer, packageFile: string, signal: AbortSignal): Promise<PreparedInstall>;
  confirmLaunch?(launch: LaunchConfirmation): Promise<boolean>;
}
export interface PreparedInstall {
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
}
export interface LaunchConfirmation {
  acknowledge: boolean;
  record(result: NativeInstallRecovery): Promise<boolean>;
  report(error: Error): void;
}
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
  subscribe?(listener: () => void): () => void;
}
export interface PackagedIdentity extends UpdateIdentity { buildInfo: BuildInfo }
