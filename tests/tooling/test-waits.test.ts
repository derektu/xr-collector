// Guards the developer, not the user: a test that waits with its own bound fails on a busy machine although
// the product works.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

const sources = filesUnder('tests').filter((file) => /\.tsx?$/u.test(file) && file !== 'tests/support/wait.ts');
const using = (pattern: RegExp) => sources.filter((file) => pattern.test(readFileSync(file, 'utf8'))).sort();

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
