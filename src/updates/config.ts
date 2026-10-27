export const PRODUCTION_UPDATE_REPOSITORY = 'derektu/xr-collector';
export const UPDATE_REPOSITORY_METADATA_KEY = 'xrCollectorUpdateRepository';
export const PRODUCTION_APP_ID = 'com.moneydj.xrcollector';
export const APP_ID_METADATA_KEY = 'xrCollectorAppId';

/** Resolves the repository baked into a validation package; ordinary packages use production. */
export function updateRepositoryFromPackageMetadata(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') return PRODUCTION_UPDATE_REPOSITORY;
  const value = (metadata as Record<string, unknown>)[UPDATE_REPOSITORY_METADATA_KEY];
  if (value === undefined) return PRODUCTION_UPDATE_REPOSITORY;
  if (typeof value !== 'string' || !isUpdateRepository(value)) throw new Error('Packaged update repository must be owner/name.');
  return value;
}

export function isUpdateRepository(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

export function appIdFromPackageMetadata(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') return PRODUCTION_APP_ID;
  const value = (metadata as Record<string, unknown>)[APP_ID_METADATA_KEY];
  if (value === undefined) return PRODUCTION_APP_ID;
  if (typeof value !== 'string' || !/^com\.xrcollector\.verify[\w.-]+$/u.test(value)) throw new Error('Packaged validation app id is invalid.');
  return value;
}
