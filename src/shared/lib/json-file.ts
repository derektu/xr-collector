import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { waitUntil } from './time.js';

// External: On Windows, renaming over a target that another process holds open without delete sharing fails
// with EPERM; antivirus and indexing scans open a file just written this way for a short time.
const REPLACE_RETRY = { interval: 50, timeout: 1_270 };

/** The parsed JSON of a file, or undefined when the file does not exist. */
export async function readJsonFile(filePath: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(contents);
}

/** Replaces the file with pretty-printed JSON, creating missing folders; readers see the old file or the new one, never part of it. */
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

/** Renames a finished temporary file over its target, retrying on EPERM for a bounded time and then throwing that EPERM. */
export async function replaceFile(temporaryPath: string, filePath: string): Promise<void> {
  await waitUntil(async () => {
    await rename(temporaryPath, filePath);
    return true;
  }, { ...REPLACE_RETRY, label: `${filePath} to be replaceable`, retryOn: (error) => (error as NodeJS.ErrnoException).code === 'EPERM' });
}
