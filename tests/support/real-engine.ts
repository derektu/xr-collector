// Real-engine tests carry the `real-engine` tag and run the pinned Meilisearch, which exists only for
// Mac arm64 and Windows x64; elsewhere the tag skips.
import path from 'node:path';
import { bundledResources, checkoutRoot } from '../../src/app/runtime/bundled-resources.js';

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
/** The checkout's search lexicon, as the development App finds it. */
export const bundledLexicon = bundledResources({ packaged: false, checkout: checkoutRoot() }, { env: {} }).searchLexicon;
