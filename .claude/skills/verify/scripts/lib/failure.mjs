import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { environment } from './platform.mjs';

/** A machine-readable result for failures that happen before a recorder can be created. */
export async function writeFailureResult({ evidence, record, error, phase, extra = {} }) {
  await mkdir(evidence, { recursive: true });
  const result = {
    ...record, environment: environment(), finishedAt: new Date().toISOString(), passed: false,
    results: [], shots: [], error: String(error.stack ?? error), phase, ...extra,
  };
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2));
  return result;
}
