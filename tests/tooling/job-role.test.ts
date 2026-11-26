// Guards the developer, not the user: a second copy of a job-role rule drifts from the first, and two
// spellings of one work key stop deduplicating jobs.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { productFiles } from '../support/source-imports.js';

const ROLE_MODULE = 'src/shared/jobs/job-role.ts';

const ROLE_READ = /\bjobRole\(/u;
const WORK_KEY = /:(?:item|check|add):/u;

function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/gu, '$1');
}

function codeLines(pattern: RegExp): string[] {
  return productFiles().flatMap((file) => withoutComments(readFileSync(file, 'utf8')).split('\n')
    .map((line, index) => pattern.test(line) ? `${file}:${index + 1}: ${line.trim()}` : null)
    .filter((line): line is string => line !== null));
}

const outsideRoleModule = (lines: string[]) => lines.filter((line) => !line.startsWith(`${ROLE_MODULE}:`));

describe('job roles', () => {
  it('reads the role of a job kind only in the role module', () => {
    const reads = codeLines(ROLE_READ);
    expect(reads.some((line) => line.startsWith(`${ROLE_MODULE}:`))).toBe(true);
    expect(outsideRoleModule(reads)).toEqual([]);
  });

  it('spells work keys only in the role module', () => {
    expect(readFileSync(ROLE_MODULE, 'utf8')).toMatch(/export function workKey\(/u);
    expect(outsideRoleModule(codeLines(WORK_KEY))).toEqual([]);
  });
});
