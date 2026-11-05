import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { productFiles } from '../support/source-imports.js';

// Guards the developer, not the user: a rule that depends on what a job does (which subscription it
// belongs to, its work key, whether it is in a step of its own) lives in one module. A file that reads
// the role off the job kind itself, or spells a work key such as `youtube:item:<key>` by hand, writes
// such a rule again, and its copy drifts from the others: two spellings of one key stop deduplicating.

const ROLE_MODULE = 'src/core/job-role.ts';

/** A role read off a job kind. */
const ROLE_READ = /\bjobRole\(/u;
/** A work key spelled out: a role name between colons, as in `${type}:item:${key}` or 'youtube:check:'. */
const WORK_KEY = /:(?:item|check|add):/u;

/** Comments removed, keeping line breaks so line numbers stay; a `//` right after `:` is a URL and stays. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/gu, '$1');
}

/** Lines of product files whose code matches `pattern`, as `file:line: text`. */
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
