/** The updates module as other modules use it: the build identity, the update service, its sources and installers. */
export { loadBuildInfo } from './build-info.js';
export { appIdFromPackageMetadata, updateRepositoryFromPackageMetadata } from './config.js';
export { UnavailableInstaller } from './installer.js';
export {
  acknowledgeMacUpdateLaunch,
  acknowledgeMacUpdateShutdown,
  MacNativeInstaller,
  prepareMacUpdateRollback,
} from './mac-installer.js';
export { GenericIndexSource, GitHubReleasesSource } from './sources.js';
export type { NativeInstaller, NativeInstallRecovery, UpdateAccess, UpdateApplyRequest, UpdateSource } from './types.js';
export { UpdateService } from './update-service.js';
export { WindowsNativeInstaller } from './windows-installer.js';
