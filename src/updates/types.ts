import type { BuildInfo, DeviceUpdateStatus, UpdateOffer } from '../core/types.js';

export interface UpdateIdentity { version: string; target: string; variant: 'chinese' | 'official' }
export interface UpdateSource {
  readonly id: string;
  check(identity: UpdateIdentity, signal?: AbortSignal): Promise<UpdateOffer | null>;
}
export interface NativeInstaller {
  readonly available: boolean;
  validate(offer: UpdateOffer, packageFile: string, signal?: AbortSignal): Promise<void>;
  prepare(offer: UpdateOffer, packageFile: string, signal: AbortSignal): Promise<PreparedInstall>;
}
export interface PreparedInstall { handoff(): Promise<void>; cancel(): Promise<void> }
export interface UpdateApplyRequest {
  offer: UpdateOffer;
  packageFile: string;
  signal: AbortSignal;
  recordAttempt(): Promise<void>;
  installing(): void;
  failed(code: string, message: string): Promise<void>;
}
export interface UpdateAccess {
  status(): DeviceUpdateStatus;
  check(): Promise<DeviceUpdateStatus>;
  download(selection: UpdateSelection): Promise<DeviceUpdateStatus>;
  apply(selection: UpdateSelection): Promise<DeviceUpdateStatus>;
  cancel(): Promise<DeviceUpdateStatus>;
}
export interface UpdateSelection { version: string; sha256: string }
export interface PackagedIdentity extends UpdateIdentity { buildInfo: BuildInfo }
