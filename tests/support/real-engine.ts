import path from 'node:path';

// Real-engine tests carry the `real-engine` tag (vitest.config.ts) and run the Meilisearch that
// `npm run download:runtime` installs for Mac arm64, the one platform with a pinned test binary.
export const REAL_ENGINE_TAG = 'real-engine';
export const realEngineSupported = process.platform === 'darwin' && process.arch === 'arm64';
export const bundledMeilisearch = path.resolve('resources/bin/mac/meilisearch');
