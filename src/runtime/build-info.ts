import { readFile } from 'node:fs/promises';
import type { BuildInfo } from '../core/types.js';

const manifestUrl = new URL('../build-info.json', import.meta.url);
let developmentInfo: Promise<BuildInfo> | undefined;

/** Reads the build's own artifact; an installed App never consults Git or its working directory. */
export async function loadBuildInfo(options: { packaged?: boolean } = {}): Promise<BuildInfo> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestUrl, 'utf8'));
  } catch (error) {
    // Source execution has no generated artifact. Compiled code must carry the writer's output.
    if (options.packaged || new URL('../', import.meta.url).pathname.endsWith('/dist/node/')
      || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Build information is missing or invalid; rebuild the application.', { cause: error });
    }
    developmentInfo ??= sourceBuildInfo();
    return developmentInfo;
  }
  if (!options.packaged && value !== null && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'packaged') {
    throw new Error('Packaged build information cannot identify a development launch. Run npm run build before launching the development application.');
  }
  return validateBuildInfo(value, { requirePackaged: options.packaged ?? false });
}

async function sourceBuildInfo(): Promise<BuildInfo> {
  const producer = await import(new URL('../../scripts/write-build-info.mjs', import.meta.url).href);
  return validateBuildInfo(await producer.createBuildInfo({ kind: 'development' }));
}

/** Validates the serialized identity rather than constructing one from launch-time environment flags. */
export function validateBuildInfo(
  value: unknown,
  options: { requirePackaged?: boolean; platform?: NodeJS.Platform; arch?: string } = {},
): BuildInfo {
  const fail = (): never => { throw new Error('Build information does not describe a valid application artifact.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const info = value as Record<string, unknown>;
  if (info.schemaVersion !== 1 || !['development', 'packaged'].includes(String(info.kind))
    || typeof info.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/iu.test(info.version)
    || typeof info.builtAt !== 'string' || !Number.isFinite(Date.parse(info.builtAt))
    || new Date(info.builtAt).toISOString() !== info.builtAt
    || (info.commit !== null && (typeof info.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(info.commit)))
    || typeof info.buildId !== 'string' || info.buildId.length === 0
    || typeof info.target !== 'string' || !/^[a-z\d]+-[a-z\d]+$/u.test(info.target)
    || (info.variant !== null && info.variant !== 'chinese' && info.variant !== 'official')
    || (info.sourceDirty !== null && typeof info.sourceDirty !== 'boolean')
    || (info.commit === null) !== (info.sourceDirty === null)) return fail();
  if (options.requirePackaged && info.kind !== 'packaged') return fail();
  if (info.kind === 'packaged') {
    const target = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
    if (!['darwin-arm64', 'win32-x64'].includes(String(info.target)) || info.target !== target
      || info.commit === null || info.sourceDirty !== false || info.variant === null) return fail();
  }
  return Object.freeze({
    schemaVersion: 1, kind: info.kind, version: info.version, builtAt: info.builtAt,
    commit: info.commit, buildId: info.buildId, target: info.target, variant: info.variant, sourceDirty: info.sourceDirty,
  }) as BuildInfo;
}
