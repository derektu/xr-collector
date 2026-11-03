// The verify skill's own tests, apart from `npm test`: they guard the skill's scripts, so CI runs
// them (npm run test:verify-skill) only when a change touches .claude/skills/verify/scripts or these tests.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../../..', import.meta.url)),
    include: ['.claude/skills/verify/tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
