import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the developer, not the user: a test sits at the path of the src file it tests, so the tests
// of a file are found next to its path and a renamed or moved src file shows which tests went with
// it. Without this rule tests drift into folders named after behavior or after files that no longer
// exist, and a reader cannot tell what a test covers or whether a file has any test at all.
// `tests/<dir>/<name>.test.ts` tests `src/<dir>/<name>.<ext>`; a file with several tests names each
// `<name>.<aspect>.test.ts`. Only tests/tooling (repo rules), tests/packaging (the scripts/ tools)
// and tests/support (helpers) hold files that test no single src file, and fixtures/ folders hold
// what a test runs or compiles.

const EXEMPT_ROOTS = ['tests/tooling/', 'tests/packaging/', 'tests/support/'];

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

/** The name a src file goes by in a test path: its file name without the last extension. */
const srcName = (file: string): string => path.posix.basename(file).replace(/\.[^.]+$/u, '');

/** Each test file outside the exempt folders whose src file is not in `srcFiles`, with the path it expected. */
function misplacedTests(testFiles: readonly string[], srcFiles: readonly string[]): Array<{ test: string; expected: string }> {
  const known = new Set(srcFiles.filter((file) => !file.endsWith('.d.ts')).map((file) => path.posix.join(path.posix.dirname(file), srcName(file))));
  return testFiles
    .filter((file) => /\.test\.tsx?$/u.test(file))
    .filter((file) => !EXEMPT_ROOTS.some((root) => file.startsWith(root)) && !file.split('/').includes('fixtures'))
    .flatMap((test) => {
      const directory = path.posix.dirname(test).replace(/^tests(\/|$)/u, 'src$1');
      const name = path.posix.basename(test).split('.')[0]!;
      const target = path.posix.join(directory, name);
      return known.has(target) ? [] : [{ test, expected: `${target}.ts(x)` }];
    });
}

describe('test paths', () => {
  it('name a src file for every test outside tests/tooling, tests/packaging and tests/support', () => {
    const misplaced = misplacedTests(filesUnder('tests'), filesUnder('src'));
    expect(misplaced.map(({ test, expected }) => `${test} -> expected ${expected}`)).toEqual([]);
  });

  it('match a test to its src file, also an aspect of it, and report the path a stray test expected', () => {
    const src = ['src/domain/jobs/job-queue.ts', 'src/transport/server/app.ts', 'src/transport/web/MarkdownBody.tsx', 'src/transport/web/electron.d.ts'];
    expect(misplacedTests([
      'tests/domain/jobs/job-queue.test.ts',
      'tests/transport/server/app.masking.test.ts',
      'tests/transport/web/MarkdownBody.test.ts',
      'tests/transport/web/electron.test.ts',
      'tests/transport/server/server-close.test.ts',
      'tests/tooling/import-layers.test.ts',
      'tests/domain/search/fixtures/killed-engine.test.ts',
      'tests/support/wait.ts',
    ], src)).toEqual([
      { test: 'tests/transport/web/electron.test.ts', expected: 'src/transport/web/electron.ts(x)' },
      { test: 'tests/transport/server/server-close.test.ts', expected: 'src/transport/server/server-close.ts(x)' },
    ]);
  });
});
