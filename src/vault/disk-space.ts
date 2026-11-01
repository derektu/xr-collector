import { lstat } from 'node:fs/promises';
import path from 'node:path';

/** Space kept free on top of the bytes a Vault operation writes: 5% of them, and at least 16 MiB. */
export const SPACE_MARGIN_RATIO = 0.05;
export const SPACE_MARGIN_MIN_BYTES = 16 * 1024 * 1024;

export function spaceMargin(bytes: number): number {
  return Math.max(Math.ceil(bytes * SPACE_MARGIN_RATIO), SPACE_MARGIN_MIN_BYTES);
}

/** Free space of the volume holding `folder`, as `fs.statfs` reports it. */
export type StatFs = (folder: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/** The path itself or its nearest ancestor that exists. */
export async function nearestExisting(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
