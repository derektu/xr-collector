// Jobs and subscriptions that reach into each other's files, rules or code can no longer change one without
// breaking the other.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function matchingLines(directory: string, pattern: RegExp): string[] {
  return filesUnder(directory).filter((file) => file.endsWith('.ts')).flatMap((file) => readFileSync(file, 'utf8').split('\n')
    .map((line, index) => pattern.test(line) ? `${file}:${index + 1}: ${line.trim()}` : null)
    .filter((line): line is string => line !== null));
}

describe('the seam between jobs and subscriptions', () => {
  it('keeps the subscription store out of src/domain/jobs', () => {
    expect(filesUnder('src/domain/jobs')).toContain('src/domain/jobs/job-manager.ts');
    expect(matchingLines('src/domain/jobs', /SubscriptionStore|subscription-store/u)).toEqual([]);
  });

  it('keeps the candidate rules and every other subscription module out of src/domain/jobs', () => {
    expect(filesUnder('src/domain/subscriptions')).toContain('src/domain/subscriptions/candidates.ts');
    expect(matchingLines('src/domain/jobs', /from '\.\.\/subscriptions\/|selectCandidates|checkPlan\(/u)).toEqual([]);
  });

  it('keeps the jobs page rules out of src/domain/subscriptions', () => {
    expect(filesUnder('src/domain/subscriptions')).toContain('src/domain/subscriptions/subscription-service.ts');
    expect(matchingLines('src/domain/subscriptions', /job-board/u)).toEqual([]);
  });

  it('imports only types from src/domain/jobs into src/domain/subscriptions', () => {
    expect(matchingLines('src/domain/subscriptions', /from '\.\.\/jobs\//u)).not.toEqual([]);
    expect(matchingLines('src/domain/subscriptions', /from '\.\.\/jobs\//u).filter((line) => !/: import type \{/u.test(line))).toEqual([]);
  });
});
