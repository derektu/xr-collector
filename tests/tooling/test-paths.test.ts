import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the developer, not the user: a test sits at the path of the src file it tests, so the tests
// of a file are found next to its path and a renamed or moved src file shows which tests went with
// it. Without this rule tests drift into folders named after behavior or after files that no longer
// exist, and a reader cannot tell what a test covers or whether a file has any test at all.
// `tests/<dir>/<name>.test.ts` tests `src/<dir>/<name>.<ext>`, and `tests/scripts/<dir>/<name>.test.ts`
// tests `scripts/<dir>/<name>.<ext>`; a file with several tests names each `<name>.<aspect>.test.ts`.
// Only tests/tooling (repo rules) and tests/support (helpers) hold files that test no single file,
// and fixtures/ folders hold what a test runs or compiles.

const EXEMPT_ROOTS = ['tests/tooling/', 'tests/support/'];

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

/** The name a src file goes by in a test path: its file name without the last extension. */
const srcName = (file: string): string => path.posix.basename(file).replace(/\.[^.]+$/u, '');

/** The folder of the file a test covers: `scripts/…` for a test under tests/scripts, `src/…` for any other. */
function testedDirectory(test: string): string {
  const directory = path.posix.dirname(test);
  return /^tests\/scripts(\/|$)/u.test(directory) ? directory.replace(/^tests\//u, '') : directory.replace(/^tests(\/|$)/u, 'src$1');
}

/** Each test file outside the exempt folders whose tested file is not in `testedFiles`, with the path it expected. */
function misplacedTests(testFiles: readonly string[], testedFiles: readonly string[]): Array<{ test: string; expected: string }> {
  const known = new Set(testedFiles.filter((file) => !file.endsWith('.d.ts')).map((file) => path.posix.join(path.posix.dirname(file), srcName(file))));
  return testFiles
    .filter((file) => /\.test\.tsx?$/u.test(file))
    .filter((file) => !EXEMPT_ROOTS.some((root) => file.startsWith(root)) && !file.split('/').includes('fixtures'))
    .flatMap((test) => {
      const name = path.posix.basename(test).split('.')[0]!;
      const target = path.posix.join(testedDirectory(test), name);
      return known.has(target) ? [] : [{ test, expected: `${target}.${target.startsWith('scripts/') ? 'mjs' : 'ts(x)'}` }];
    });
}

describe('test paths', () => {
  it('name a src or scripts file for every test outside tests/tooling and tests/support', () => {
    const misplaced = misplacedTests(filesUnder('tests'), [...filesUnder('src'), ...filesUnder('scripts')]);
    expect(misplaced.map(({ test, expected }) => `${test} -> expected ${expected}`)).toEqual([]);
  });

  it('match a test to its src or scripts file, also an aspect of it, and report the path a stray test expected', () => {
    const tested = ['src/domain/jobs/job-queue.ts', 'src/transport/server/app.ts', 'src/transport/web/documents/MarkdownBody.tsx', 'src/transport/web/electron.d.ts', 'scripts/lib/owned-directory-lock.mjs'];
    expect(misplacedTests([
      'tests/domain/jobs/job-queue.test.ts',
      'tests/transport/server/app.masking.test.ts',
      'tests/transport/web/documents/MarkdownBody.test.ts',
      'tests/scripts/lib/owned-directory-lock.race.test.ts',
      'tests/transport/web/electron.test.ts',
      'tests/transport/server/server-close.test.ts',
      'tests/scripts/package/package-tools.test.ts',
      'tests/tooling/import-layers.test.ts',
      'tests/domain/search/fixtures/killed-engine.test.ts',
      'tests/support/wait.ts',
    ], tested)).toEqual([
      { test: 'tests/transport/web/electron.test.ts', expected: 'src/transport/web/electron.ts(x)' },
      { test: 'tests/transport/server/server-close.test.ts', expected: 'src/transport/server/server-close.ts(x)' },
      { test: 'tests/scripts/package/package-tools.test.ts', expected: 'scripts/package/package-tools.mjs' },
    ]);
  });
});
