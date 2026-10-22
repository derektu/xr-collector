import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Jobs and subscriptions meet at one seam, the subscription port: the job manager never reaches
// the subscription files, and the subscription services compose a status from the work facts the
// job manager reports, without running any of its code. Types from src/jobs are part of the seam.

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

/** Lines of the TypeScript files under `directory` that match `pattern`, as `file:line: text`. */
function matching(directory: string, pattern: RegExp): string[] {
  return filesUnder(directory).filter((file) => file.endsWith('.ts')).flatMap((file) => readFileSync(file, 'utf8').split('\n')
    .map((line, index) => pattern.test(line) ? `${file}:${index + 1}: ${line.trim()}` : null)
    .filter((line): line is string => line !== null));
}

describe('the seam between jobs and subscriptions', () => {
  it('keeps the subscription store out of src/jobs', () => {
    expect(filesUnder('src/jobs')).toContain('src/jobs/job-manager.ts');
    expect(matching('src/jobs', /SubscriptionStore|subscription-store/u)).toEqual([]);
  });

  it('keeps the jobs page rules out of src/subscriptions', () => {
    expect(filesUnder('src/subscriptions')).toContain('src/subscriptions/subscription-service.ts');
    expect(matching('src/subscriptions', /job-board/u)).toEqual([]);
  });

  it('imports only types from src/jobs into src/subscriptions', () => {
    expect(matching('src/subscriptions', /from '\.\.\/jobs\//u)).not.toEqual([]);
    expect(matching('src/subscriptions', /from '\.\.\/jobs\//u).filter((line) => !/: import type \{/u.test(line))).toEqual([]);
  });
});
