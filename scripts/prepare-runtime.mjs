#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuildEnvironment } from './build-doctor.mjs';
import { prepareMeilisearch } from './prepare-meilisearch.mjs';
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';

const TARGETS = { mac: 'darwin-arm64', win: 'win32-x64' };

export function parsePrepareRuntimeArguments(argv) {
  const [platform, ...rest] = argv;
  const target = TARGETS[platform];
  if (!target) throw new Error('Usage: npm run prepare:runtime -- <mac|win> [--variant chinese|official]');
  const options = { target, variant: 'chinese', cacheOnly: false };
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--variant') {
      const variant = rest[++index];
      if (variant !== 'chinese' && variant !== 'official') throw new Error(`Unsupported Meilisearch variant ${variant ?? 'missing'}; use chinese or official.`);
      options.variant = variant;
    } else if (rest[index] === '--cache-only') options.cacheOnly = true;
    else throw new Error(`Unknown argument ${rest[index]}`);
  }
  return options;
}

/**
 * Fills the per-user runtime cache with the pinned yt-dlp/Deno archives and the requested
 * Meilisearch variant, then installs both into this checkout's `resources/bin`. Packaging runs the
 * same step with `cacheOnly`, which installs from the cache and never downloads or compiles.
 */
export async function prepareRuntime({ target, variant, cacheOnly }, dependencies = {}) {
  await (dependencies.prepareRuntimeDependencies ?? prepareRuntimeDependencies)({ target, cacheOnly });
  await (dependencies.prepareMeilisearch ?? prepareMeilisearch)({ variant, target, cacheOnly });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parsePrepareRuntimeArguments(process.argv.slice(2));
    // Packaging runs the cache-only install after its own environment check.
    if (!options.cacheOnly) await assertBuildEnvironment(options);
    await prepareRuntime(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
