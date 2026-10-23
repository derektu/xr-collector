// Whether results.json files from several machines complete one version: every scenario passes on
// every required platform, only results of the commit under test from a clean checkout count, and a
// failure is never hidden by a pass. The CLI reads the files and exits 2 while incomplete.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { summarize } from '../../../.claude/skills/verify/scripts/lib/summary.mjs';
import { cleanUp, temp } from './support.js';

afterEach(cleanUp);

const COMMIT = 'a'.repeat(40);
const CLI = path.resolve(import.meta.dirname, '../../../.claude/skills/verify/scripts/verify.mjs');

/** A results.json as the recorder writes it, from `platform`, with each scenario passing unless listed in `failed`. */
function results(platform: string, ids: string[], { failed = [] as string[], commit = COMMIT, dirty = false } = {}) {
  return {
    commit, dirty, environment: { platform },
    results: ids.map((id) => ({ id, pass: !failed.includes(id), checks: [{ ok: !failed.includes(id), text: id }] })),
  };
}
const files = (...list: object[]) => list.map((result, index) => ({ file: `r${index}.json`, result }));
const status = (summary: ReturnType<typeof summarize>, id: string) => summary.scenarios.find((scenario: { id: string }) => scenario.id === id)?.checks;

describe('summarize', () => {
  it('completes with one platform when no platform is required', () => {
    expect(summarize(files(results('win32', ['A', 'B'])), { commit: COMMIT }).complete).toBe(true);
  });

  it('keeps a scenario pending on a required platform with no results', () => {
    const windowsOnly = summarize(files(results('win32', ['A'])), { commit: COMMIT, platforms: ['darwin', 'win32'] });
    expect(windowsOnly.complete).toBe(false);
    expect(status(windowsOnly, 'A')).toEqual([{ platform: 'darwin', status: 'pending' }, { platform: 'win32', status: 'pass' }]);
    expect(summarize(files(results('win32', ['A']), results('darwin', ['A'])), { commit: COMMIT, platforms: ['darwin', 'win32'] }).complete).toBe(true);
  });

  it('does not count results of another commit or of a dirty checkout', () => {
    const summary = summarize(files(results('darwin', ['A'], { commit: 'b'.repeat(40) }), results('darwin', ['A'], { dirty: true })), { commit: COMMIT });
    expect(summary.complete).toBe(false);
    expect(status(summary, 'A')).toEqual([{ platform: 'any', status: 'pending' }]);
    expect(summary.ignored.map((entry: { reason: string }) => entry.reason)).toEqual([expect.stringContaining('commit'), expect.stringContaining('provisional')]);
  });

  it('lets a failure on a platform stand against a pass on the same platform', () => {
    const summary = summarize(files(results('darwin', ['A']), results('darwin', ['A'], { failed: ['A'] }), results('win32', ['A'])), { commit: COMMIT, platforms: ['darwin', 'win32'] });
    expect(summary.complete).toBe(false);
    expect(status(summary, 'A')).toEqual([{ platform: 'darwin', status: 'fail' }, { platform: 'win32', status: 'pass' }]);
  });

  it('reads the platform of a Desktop run from its target and refuses a short commit', () => {
    const desktop = { commit: COMMIT, dirty: false, target: { platform: 'win32' }, results: [{ id: 'D', pass: true, checks: [] }] };
    expect(summarize(files(desktop), { commit: COMMIT, platforms: ['win32'] }).complete).toBe(true);
    expect(() => summarize(files(desktop), { commit: 'abc' })).toThrow('40-character');
  });

  it('keeps a run that failed as a whole incomplete even when each of its scenarios passed', () => {
    const errored = { ...results('darwin', ['A']), error: 'Error: EBUSY: resource busy or locked, rmdir\n    at rm' };
    const summary = summarize(files(errored), { commit: COMMIT });
    expect(summary.complete).toBe(false);
    expect(summary.failedRuns).toEqual([{ file: 'r0.json', reason: 'Error: EBUSY: resource busy or locked, rmdir' }]);
    const notPassed = summarize(files({ ...results('darwin', ['A']), passed: false }), { commit: COMMIT });
    expect(notPassed.complete).toBe(false);
    expect(notPassed.failedRuns).toEqual([{ file: 'r0.json', reason: 'the run did not pass' }]);
  });

  it('reports an expected scenario that no run recorded as pending', () => {
    const partial = summarize(files(results('win32', ['A'])), { commit: COMMIT, scenarios: ['A', 'B'] });
    expect(partial.complete).toBe(false);
    expect(status(partial, 'B')).toEqual([{ platform: 'any', status: 'pending' }]);
    expect(summarize(files(results('win32', ['A', 'B'])), { commit: COMMIT, scenarios: ['A', 'B'] }).complete).toBe(true);
  });

  it('ignores a file with no scenario results instead of failing to read it', () => {
    const empty = { commit: COMMIT, dirty: false, environment: { platform: 'darwin' } };
    const summary = summarize(files(empty, results('darwin', ['A'])), { commit: COMMIT });
    expect(summary.ignored).toEqual([{ file: 'r0.json', reason: 'no scenario results recorded' }]);
    expect(summary.complete).toBe(true);
  });
});

describe('verify.mjs summary', () => {
  it('exits 2 while a required platform is missing and 0 once it is there', async () => {
    const dir = temp('summary');
    const mac = path.join(dir, 'mac.json');
    const windows = path.join(dir, 'windows.json');
    writeFileSync(mac, JSON.stringify(results('darwin', ['A'])));
    writeFileSync(windows, JSON.stringify(results('win32', ['A'])));
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [CLI, 'summary', '--commit', COMMIT, '--platform', 'darwin', '--platform', 'win32', ...args])
      .then(() => 0, (failed) => failed.code as number);

    expect(await run(mac)).toBe(2);
    expect(await run(mac, windows)).toBe(0);
  }, 30_000);
});
