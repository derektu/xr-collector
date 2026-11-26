import { runWithinLimit } from './lib/time-limited-process.mjs';
import { VERIFY_STEPS } from './lib/time-limits.mjs';

// External: npm sets npm_execpath to its own CLI script in the environment of the scripts it runs
// (https://github.com/npm/cli/blob/v10.9.8/workspaces/config/lib/set-envs.js), and Node refuses to
// spawn npm.cmd on Windows without a shell (https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2).
const npm = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath]] : ['npm', []];

for (const { step, limit } of VERIFY_STEPS) {
  try {
    const code = await runWithinLimit(step, npm[0], [...npm[1], 'run', step], { limit });
    if (code !== 0) { process.exitCode = code; break; }
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
    break;
  }
}
