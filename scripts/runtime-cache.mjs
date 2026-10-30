import { homedir } from 'node:os';
import path from 'node:path';

export const RUNTIME_CACHE_ENV = 'XR_COLLECTOR_RUNTIME_CACHE';

/**
 * Per-user cache of pinned runtime inputs (yt-dlp/Deno archives and the Meilisearch release
 * asset), shared by every checkout and worktree on this machine. Entries are keyed by pin SHA-256
 * or version, so different pins never share an entry. The packaged and development App
 * never read this cache; they run the copies installed in `resources/bin`.
 */
export function runtimeCacheRoot(environment = process.env, platform = process.platform, home = homedir()) {
  const override = environment[RUNTIME_CACHE_ENV];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (override) {
    if (!paths.isAbsolute(override)) throw new Error(`${RUNTIME_CACHE_ENV} must be an absolute path.`);
    return paths.resolve(override);
  }
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData || !paths.isAbsolute(localAppData)) {
      throw new Error(`LOCALAPPDATA is required to locate the runtime cache; set ${RUNTIME_CACHE_ENV} to an absolute path instead.`);
    }
    return paths.join(localAppData, 'xr-collector', 'runtime');
  }
  return paths.join(home, '.cache', 'xr-collector', 'runtime');
}

/** The command that fills the runtime cache for one target. */
export function prepareRuntimeCommand(target) {
  return `npm run prepare:runtime -- ${target.startsWith('win32') ? 'win' : 'mac'}`;
}

export function runtimeCacheMiss(description, location, target) {
  return new Error(`${description} is missing from the runtime cache or does not match its pinned identity (${location}). Packaging only reads the cache; run ${prepareRuntimeCommand(target)} first.`);
}
