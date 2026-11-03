import { existsSync } from 'node:fs';
import { beforeEach } from 'vitest';
import { bundledMeilisearch, REAL_ENGINE_TAG } from './real-engine.js';

// A real-engine test fails, rather than skips, when this checkout has no Meilisearch runtime.
beforeEach(({ task }) => {
  if (!task.tags?.includes(REAL_ENGINE_TAG) || existsSync(bundledMeilisearch)) return;
  throw new Error(`Meilisearch runtime is missing at ${bundledMeilisearch}. Run \`npm run download:runtime\`, then run the tests again.`);
});
