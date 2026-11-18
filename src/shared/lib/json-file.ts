import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Waits between rename attempts while Windows refuses to replace a target another process holds open
 * without delete sharing (an antivirus or indexing scan of a file just written). About 1.3 seconds in
 * all, so a target that stays locked fails the write instead of blocking it.
 */
const REPLACE_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640];

/** The parsed JSON of a file, or undefined when the file does not exist. */
export async function readJsonFile(filePath: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(contents) as unknown;
}

/** Writes pretty-printed JSON through a temporary file and a rename, so readers never see half a file. */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await replaceFile(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** Renames a finished temporary file over its target, retrying a bounded number of times on EPERM. */
export async function replaceFile(temporaryPath: string, filePath: string): Promise<void> {
  for (const delay of REPLACE_RETRY_DELAYS_MS) {
    try {
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await sleep(delay);
  }
  await rename(temporaryPath, filePath);
}
