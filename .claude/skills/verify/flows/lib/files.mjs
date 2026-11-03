// Changing files the app owns while it runs. The app reads a whole file at once and writes it at
// any time, so a flow writes through a temporary file and a rename: the app reads the old file or
// the new one, never part of one.
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

/** Replaces `file` with `text` in one rename. */
export async function writeText(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

/** Replaces `file` with `value` as formatted JSON, in one rename. */
export const writeJson = (file, value) => writeText(file, `${JSON.stringify(value, null, 2)}\n`);

/** Reads a JSON file, applies `edit` (which changes the value in place or returns a new one) and writes it back in one rename; returns what it wrote. */
export async function editJson(file, edit) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  const next = edit(value) ?? value;
  await writeJson(file, next);
  return next;
}
