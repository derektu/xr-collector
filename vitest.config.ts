import { defineConfig } from 'vitest/config';
import { REAL_ENGINE_TAG, realEngineSupported } from './tests/support/real-engine.js';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/support/register-sources.ts', 'tests/support/require-real-engine.ts'],
    tags: [{
      name: REAL_ENGINE_TAG,
      description: 'Runs the bundled Meilisearch; skipped on platforms other than Mac arm64',
      skip: !realEngineSupported,
    }],
    // A test fails on a missing state through its own wait (tests/support/wait.ts) before this bound.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
