import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobEvent } from '../../src/core/types.js';

/** Every event written under a job store directory, in file and line order: the day files oldest first. */
export async function readEventFiles(directory: string): Promise<JobEvent[]> {
  const segments = path.join(directory, 'events');
  const names = (await readdir(segments).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl')).sort();
  const events: JobEvent[] = [];
  for (const name of names) {
    const text = await readFile(path.join(segments, name), 'utf8');
    events.push(...text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as JobEvent));
  }
  return events;
}
