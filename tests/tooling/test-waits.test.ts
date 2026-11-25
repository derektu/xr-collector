import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the developer, not the user: a test that waits with its own bound fails on a busy machine
// although the product works. Tests wait for a state through `eventually` in tests/support/wait.ts,
// whose one bound says when a missing state is reported, or await a promise the product or a test
// double resolves at the moment itself. No test sets its own time limit: Vitest's one `testTimeout`
// reports a test that hangs. Direct timers and sleeps are lint errors (docs/code-guidelines.md).

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
    expect(sources).toContain('tests/domain/jobs/job-manager.test.ts');
    expect(using(/vi\.waitFor\(|expect\.poll\(/u)).toEqual([]);
  });

  it('gives no test a time limit of its own', () => {
    expect(sources.filter(ownsTimeLimit)).toEqual([]);
  });
});
