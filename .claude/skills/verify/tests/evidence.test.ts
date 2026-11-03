// Guards the developer, not the user.
// Where a verify run keeps its evidence: every run gets a new folder in the worktree the command runs
// in, so an earlier run's results never mix with a later one, and an explicit folder must be empty.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimEvidence } from '../scripts/lib/paths.mjs';
import { cleanUp, repository, temp } from './support.js';

const original = process.cwd();
afterEach(() => {
  process.chdir(original);
  cleanUp();
});

describe('claimEvidence', () => {
  it('gives every run of a label a new folder in the worktree and leaves earlier ones as they are', () => {
    const checkout = repository();
    process.chdir(checkout);
    const first = claimEvidence(111, 'baseline');
    writeFileSync(path.join(first.evidence, 'results.json'), '{"run":1}');
    const second = claimEvidence(111, 'baseline');
    const unlabelled = claimEvidence(111);

    const issue = path.join(checkout, '.local', 'ticket-artifacts', '111');
    expect([first, second, unlabelled].map((claimed) => path.dirname(claimed.evidence))).toEqual([issue, issue, issue]);
    expect(path.basename(first.evidence)).toMatch(/^baseline-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/u);
    expect(path.basename(second.evidence)).toMatch(/^baseline-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(-2)?$/u);
    expect(second.evidence).not.toBe(first.evidence);
    expect([first.label, second.label, unlabelled.label]).toEqual(['baseline', 'baseline', null]);
    expect(readdirSync(second.evidence)).toEqual([]);
    expect(readFileSync(path.join(first.evidence, 'results.json'), 'utf8')).toBe('{"run":1}');
  });

  it('writes to an explicit folder only when it is missing or empty', () => {
    const missing = path.join(temp('evidence'), 'new');
    expect(claimEvidence(111, undefined, { evidence: missing })).toEqual({ evidence: missing, label: null });
    writeFileSync(path.join(missing, 'results.json'), '{"owner":"previous run"}');
    expect(() => claimEvidence(111, undefined, { evidence: missing })).toThrow(/is not empty; give a new or empty folder/u);
    expect(readFileSync(path.join(missing, 'results.json'), 'utf8')).toBe('{"owner":"previous run"}');
  });
});
