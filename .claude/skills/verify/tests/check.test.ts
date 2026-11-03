// Guards the developer, not the user.
// Whether evidence proves the code as it is now: a results.json counts while it is a run of this
// checkout and the checkout still has the recorded commit and uncommitted changes, or, from another machine, when it tested this commit
// from a clean checkout and this checkout has no uncommitted changes either. Counted results complete the evidence only when every scenario passed on
// every required platform; a failure is never hidden by a pass, a run that failed as a whole and an
// expected scenario no run recorded keep it incomplete. The CLI exits 2 while incomplete.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEvidence } from '../scripts/lib/check.mjs';
import { commitOf } from '../scripts/lib/paths.mjs';
import { cleanUp, repository } from './support.js';

afterEach(cleanUp);

const CLI = path.resolve(import.meta.dirname, '../scripts/verify.mjs');

/** A checkout with the given results.json files under its issue 118 evidence: name → fields. */
function evidence(files: Record<string, (now: ReturnType<typeof commitOf>, checkout: string) => Record<string, unknown>>) {
  const checkout = repository();
  const now = commitOf(checkout);
  const written = Object.entries(files).map(([name, fields]) => {
    const folder = path.join(checkout, '.local', 'ticket-artifacts', '118', name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'results.json'), JSON.stringify(fields(now, checkout)));
    return path.join(folder, 'results.json');
  });
  return { checkout, now, files: written };
}

/** A results.json from `platform` of this checkout, each scenario passing unless listed in `failed`. */
const run = (platform: string, ids: string[], { failed = [] as string[] } = {}) => (now: ReturnType<typeof commitOf>, checkout: string) => ({
  checkout, commit: now.commit, sourceHash: now.sourceHash, dirty: now.dirty, environment: { platform }, passed: failed.length === 0,
  results: ids.map((id) => ({ id, pass: !failed.includes(id), checks: [{ ok: !failed.includes(id), text: id }] })),
});
const status = (report: ReturnType<typeof checkEvidence>, id: string) => report.scenarios.find((scenario: { id: string }) => scenario.id === id)?.checks;
const reasons = (report: ReturnType<typeof checkEvidence>) => report.ignored.map((entry: { reason: string }) => entry.reason);

describe('checkEvidence', () => {
  it('counts a result of the current code and ignores one of another commit or other uncommitted changes', () => {
    const { checkout, files } = evidence({
      current: run('darwin', ['A']),
      'other-commit': (now, at) => ({ ...run('darwin', ['B'])(now, at), commit: 'a'.repeat(40) }),
      'other-changes': (now, at) => ({ ...run('darwin', ['C'])(now, at), sourceHash: '0123456789abcdef' }),
    });
    const report = checkEvidence(files, { checkout });
    expect(report.scenarios.map((scenario: { id: string }) => scenario.id)).toEqual(['A']);
    expect(report.complete).toBe(true);
    expect(reasons(report)).toEqual([expect.stringContaining('commit differs: aaaaaaaaaaaa recorded'), expect.stringContaining('uncommitted changes differ')]);
  });

  it('ignores a run of another checkout on this machine, such as a baseline of the main checkout', () => {
    const main = repository();
    const { checkout, files } = evidence({ baseline: () => run('darwin', ['A'])(commitOf(main), main) });
    const report = checkEvidence(files, { checkout });
    expect(report.complete).toBe(false);
    expect(reasons(report)).toEqual([`another checkout: ${main}`]);
  });

  it('stops counting a result once a source line changes', () => {
    const { checkout, files } = evidence({ run: run('darwin', ['A']) });
    writeFileSync(path.join(checkout, 'source.ts'), 'export const value = 2;\n');
    const report = checkEvidence(files, { checkout });
    expect(report.complete).toBe(false);
    expect(reasons(report)).toEqual([expect.stringContaining('uncommitted changes differ')]);
  });

  it('counts a result from another machine only when it tested this commit and neither checkout has uncommitted changes', () => {
    const elsewhere = 'C:\\checkout-on-another-machine';
    const { checkout, files } = evidence({
      clean: (now, at) => ({ ...run('win32', ['A'])(now, at), checkout: elsewhere, dirty: false }),
      dirty: (now, at) => ({ ...run('win32', ['B'])(now, at), checkout: elsewhere, dirty: true }),
      older: (now, at) => ({ ...run('win32', ['C'])(now, at), checkout: elsewhere, dirty: false, commit: 'b'.repeat(40) }),
    });
    const report = checkEvidence(files, { checkout, platforms: ['win32'] });
    expect(report.scenarios.map((scenario: { id: string }) => scenario.id)).toEqual(['A']);
    expect(reasons(report)).toEqual([expect.stringContaining('uncommitted changes'), expect.stringContaining('from another machine: commit bbbbbbbbbbbb')]);

    // The other machine tested the commit, not the change that is still uncommitted here.
    writeFileSync(path.join(checkout, 'source.ts'), 'export const value = 2;\n');
    const changed = checkEvidence(files, { checkout, platforms: ['win32'] });
    expect(changed.complete).toBe(false);
    expect(reasons(changed)[0]).toContain('without the uncommitted changes in this checkout');
  });

  it('keeps a scenario pending on a required platform with no results and lets a failure stand against a pass', () => {
    const { checkout, files } = evidence({ pass: run('darwin', ['A', 'B']), fail: run('darwin', ['B'], { failed: ['B'] }) });
    const report = checkEvidence(files, { checkout, platforms: ['darwin', 'win32'] });
    expect(report.complete).toBe(false);
    expect(status(report, 'A')).toEqual([{ platform: 'darwin', status: 'pass' }, { platform: 'win32', status: 'pending' }]);
    expect(status(report, 'B')).toEqual([{ platform: 'darwin', status: 'fail' }, { platform: 'win32', status: 'pending' }]);
  });

  it('keeps a run that failed as a whole incomplete even when each of its scenarios passed', () => {
    const { checkout, files } = evidence({ errored: (now, at) => ({ ...run('darwin', ['A'])(now, at), error: 'Error: app did not exit\n    at close' }) });
    const report = checkEvidence(files, { checkout });
    expect(report.complete).toBe(false);
    expect(report.failedRuns).toEqual([{ file: files[0], reason: 'Error: app did not exit' }]);
  });

  it('reports an expected scenario that no run recorded as pending', () => {
    const { checkout, files } = evidence({ partial: run('darwin', ['A']) });
    const report = checkEvidence(files, { checkout, scenarios: ['A', 'B'] });
    expect(report.complete).toBe(false);
    expect(status(report, 'B')).toEqual([{ platform: 'any', status: 'pending' }]);
  });
});

describe('verify.mjs check', () => {
  it('exits 2 while a required platform is missing and 0 once it is there', async () => {
    const { checkout } = evidence({ mac: run('darwin', ['A']) });
    const check = (...args: string[]) => promisify(execFile)(process.execPath, [CLI, 'check', '--issue', '118', '--platform', 'darwin', ...args], { cwd: checkout })
      .then(() => 0, (failed) => failed.code as number);
    expect(await check('--platform', 'win32')).toBe(2);
    expect(await check()).toBe(0);
  });
});
