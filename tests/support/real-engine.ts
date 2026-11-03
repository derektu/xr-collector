import path from 'node:path';

// Real-engine tests carry the `real-engine` tag (vitest.config.ts) and run the Meilisearch that
// `npm run download:runtime` (Mac arm64) or `npm run download:runtime:win` (Windows x64) installs.
// Those are the delivery targets, the only platforms with a pinned binary; elsewhere the tag skips.
const RUNTIMES: Record<string, { binary: string; install: string }> = {
  'darwin-arm64': { binary: 'resources/bin/mac/meilisearch', install: 'npm run download:runtime' },
  'win32-x64': { binary: 'resources/bin/win/meilisearch.exe', install: 'npm run download:runtime:win' },
};
const runtime = RUNTIMES[`${process.platform}-${process.arch}`];

export const REAL_ENGINE_TAG = 'real-engine';
export const realEngineSupported = runtime !== undefined;
/** The pinned Meilisearch of this platform; on an unsupported platform the tagged tests are skipped. */
export const bundledMeilisearch = path.resolve(runtime?.binary ?? 'resources/bin/unsupported/meilisearch');
export const installRuntime = runtime?.install ?? '';
