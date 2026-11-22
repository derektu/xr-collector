import {
  appIdFromPackageMetadata,
  updateRepositoryFromPackageMetadata,
  GenericIndexSource,
  GitHubReleasesSource,
  type UpdateSource,
} from '../../domain/updates/index.js';

type Environment = Readonly<Record<string, string | undefined>>;

export function windowsAppId(packageMetadata: unknown): string {
  return appIdFromPackageMetadata(packageMetadata);
}

export function updateSourceFor(env: Environment, packageMetadata: unknown, request: typeof fetch): UpdateSource {
  const repository = updateRepositoryFromPackageMetadata(packageMetadata);
  return env.XR_COLLECTOR_UPDATE_BASE_URL
    ? new GenericIndexSource(env.XR_COLLECTOR_UPDATE_BASE_URL, request)
    : new GitHubReleasesSource(repository, request);
}

export function windowSize(env: Environment): { width: number; height: number } {
  const validationSize = /^(?<width>[0-9]+)x(?<height>[0-9]+)$/.exec(env.XR_COLLECTOR_VALIDATION_WINDOW_SIZE ?? '')?.groups;
  return validationSize ? { width: Number(validationSize.width), height: Number(validationSize.height) } : { width: 1240, height: 820 };
}
