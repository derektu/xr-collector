import type { DeviceUpdateStatus, UpdateOffer, UpdateSelection } from '../../shared/api/update-types.js';

/** The platform updater the update service drives: electron-updater in the desktop App, a fixture elsewhere. */
export interface AppUpdater {
  /** False where this runtime cannot install an update, such as a development launch. */
  readonly available: boolean;
  /** The newest release when it is newer than the running version, otherwise null. */
  check(): Promise<UpdateOffer | null>;
  /** Downloads and verifies the release the last check found; rejects when `signal` aborts. */
  download(progress: (transferred: number, total: number) => void, signal: AbortSignal): Promise<void>;
}

export interface UpdateAccess {
  status(): DeviceUpdateStatus;
  check(): Promise<DeviceUpdateStatus>;
  download(selection: UpdateSelection): Promise<DeviceUpdateStatus>;
  apply(selection: UpdateSelection): Promise<DeviceUpdateStatus>;
  cancel(): Promise<DeviceUpdateStatus>;
  subscribe?(listener: () => void): () => void;
}
