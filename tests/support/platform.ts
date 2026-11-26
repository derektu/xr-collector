import { it } from 'vitest';

/** A test that needs POSIX permissions, processes or signals; skipped on Windows. */
export const itOnPosix = it.skipIf(process.platform === 'win32');
