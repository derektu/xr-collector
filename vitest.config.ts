import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/support/register-sources.ts'],
    // A test fails on a missing state through its own wait (tests/support/wait.ts) before this bound.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
