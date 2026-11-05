import { appIdFromPackageMetadata, updateRepositoryFromPackageMetadata } from '../updates/config.js';
import { GenericIndexSource, GitHubReleasesSource } from '../updates/sources.js';
import type { UpdateSource } from '../updates/types.js';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The Windows app identity, which must match the installer's Start menu shortcut for Windows to
 * show the app's notifications: the one baked into the package, or a validation run's own
 * `com.xrcollector.verify…` identity.
 */
export function windowsAppId(env: Environment, packageMetadata: unknown): string {
  const validationAppId = env.XR_COLLECTOR_VALIDATION_APP_ID;
  return validationAppId && /^com\.xrcollector\.verify[\w.-]+$/u.test(validationAppId)
    ? validationAppId : appIdFromPackageMetadata(packageMetadata);
}

/**
 * Where the app looks for updates: the GitHub repository baked into the package, or a plain release
 * directory that `XR_COLLECTOR_UPDATE_BASE_URL` names. The package's repository is read either way,
 * so a package with a malformed repository fails to start.
 */
export function updateSourceFor(env: Environment, packageMetadata: unknown, request: typeof fetch): UpdateSource {
  const repository = updateRepositoryFromPackageMetadata(packageMetadata);
  return env.XR_COLLECTOR_UPDATE_BASE_URL
    ? new GenericIndexSource(env.XR_COLLECTOR_UPDATE_BASE_URL, request)
    : new GitHubReleasesSource(repository, request);
}

/** The window's first size: 1240×820, or `<width>x<height>` from `XR_COLLECTOR_VALIDATION_WINDOW_SIZE`. */
export function windowSize(env: Environment): { width: number; height: number } {
  const validationSize = /^([0-9]+)x([0-9]+)$/.exec(env.XR_COLLECTOR_VALIDATION_WINDOW_SIZE ?? '');
  return validationSize ? { width: Number(validationSize[1]!), height: Number(validationSize[2]!) } : { width: 1240, height: 820 };
}
