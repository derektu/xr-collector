import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the developer, not the user: a test that waits with its own bound fails on a busy machine
// although the product works, and one that sleeps before asserting that something did not happen
// passes on a busy machine although the product breaks. Tests wait for a state through `eventually`
// in tests/support/wait.ts, whose one bound says when a missing state is reported, await a promise
// the product or a test double resolves at the moment itself, or prove that something did not
// happen with a later step the product orders after it. No test sets its own time limit: Vitest's one
// `testTimeout` reports a test that hangs.

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

const sources = filesUnder('tests').filter((file) => /\.tsx?$/u.test(file) && file !== 'tests/support/wait.ts');
const using = (pattern: RegExp) => sources.filter((file) => pattern.test(readFileSync(file, 'utf8'))).sort();

/**
 * Whether the file gives a test or suite its own time limit: a number after the body of an `it`,
 * `test` or `describe` (`}, 30_000);` closing it, matched to its opening line by indentation), or a
 * `timeout` option.
 */
function ownsTimeLimit(file: string): boolean {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
  return lines.some((line, index) => {
    if (/^\s*(it|test|describe)\b.*\{\s*timeout:/u.test(line)) return true;
    const closing = /^(\s*)\}, *\d[\d_]*\);/u.exec(line);
    if (!closing) return false;
    const indent = closing[1]!;
    for (let at = index - 1; at >= 0; at -= 1) {
      const opening = lines[at]!;
      if (!opening.startsWith(indent) || /^\s/u.test(opening.slice(indent.length)) || opening.trim() === '') continue;
      return /^(it|test|describe)\b/u.test(opening.slice(indent.length));
    }
    return false;
  });
}

describe('waits in tests', () => {
  it('waits for a state only through the shared helper', () => {
    expect(sources).toContain('tests/jobs/job-manager.test.ts');
    expect(using(/vi\.waitFor\(|expect\.poll\(/u)).toEqual([]);
  });

  it('sleeps only to stand for the work a test double does', () => {
    expect(using(/setTimeout\(resolve/u)).toEqual([
      'tests/packaging/mac-signing.test.ts', // signing work that overlaps, for the concurrency bound
      'tests/tooling/verify-skill/flows.test.ts', // flow runs that overlap, for the job limit
    ]);
  });

  it('gives no test a time limit of its own', () => {
    expect(sources.filter(ownsTimeLimit)).toEqual([]);
  });
});
