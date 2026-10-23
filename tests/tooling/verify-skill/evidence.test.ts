// Where a verify run keeps its evidence and scratch state: claimEvidence never reuses a labelled
// folder, labels are single folder names, and the locations follow the worktree the command runs in.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLabel, claimEvidence, evidenceDir, runsRoot } from '../../../.claude/skills/verify/scripts/lib/paths.mjs';
import { cleanUp, LIB, repository } from './support.js';

const original = process.cwd();
afterEach(() => {
  process.chdir(original);
  cleanUp();
});

/** A worktree to run in, and the evidence root of its issue 111. */
function inWorktree() {
  const { main, worktree } = repository();
  process.chdir(worktree);
  return { main, worktree, issue: path.join(worktree, '.local', 'ticket-artifacts', '111') };
}

describe('claimEvidence', () => {
  it('gives each run of one label its own folder and leaves earlier ones as they are', () => {
    const { issue } = inWorktree();
    const first = claimEvidence(111, 'baseline');
    writeFileSync(path.join(first.evidence, 'results.json'), '{"run":1}');
    const second = claimEvidence(111, 'baseline');
    const third = claimEvidence(111, 'baseline');

    expect([first, second, third]).toEqual([
      { evidence: path.join(issue, 'baseline'), label: 'baseline' },
      { evidence: path.join(issue, 'baseline-2'), label: 'baseline-2' },
      { evidence: path.join(issue, 'baseline-3'), label: 'baseline-3' },
    ]);
    expect(readFileSync(path.join(first.evidence, 'results.json'), 'utf8')).toBe('{"run":1}');
  });

  it('skips a label folder that already exists on disk', () => {
    const { issue } = inWorktree();
    mkdirSync(path.join(issue, 'ticket'), { recursive: true });
    writeFileSync(path.join(issue, 'ticket', 'shot.png'), 'earlier');

    expect(claimEvidence(111, 'ticket')).toEqual({ evidence: path.join(issue, 'ticket-2'), label: 'ticket-2' });
    expect(readFileSync(path.join(issue, 'ticket', 'shot.png'), 'utf8')).toBe('earlier');
  });

  it('never hands one folder to launches of the same label that start together', async () => {
    const { worktree } = inWorktree();
    const script = `const { claimEvidence } = await import(${JSON.stringify(pathToFileURL(path.join(LIB, 'paths.mjs')).href)});
      console.log(claimEvidence(111, 'parallel').label);`;
    const launches = Array.from({ length: 6 }, () =>
      promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: worktree }));
    const labels = (await Promise.all(launches)).map((result) => result.stdout.trim());

    expect(new Set(labels).size).toBe(6);
    expect(labels.sort()).toEqual(['parallel', 'parallel-2', 'parallel-3', 'parallel-4', 'parallel-5', 'parallel-6']);
  }, 20_000);

  it('shares the issue folder between runs without a label', () => {
    const { issue } = inWorktree();
    expect(claimEvidence(111)).toEqual({ evidence: issue, label: null });
    expect(claimEvidence(111)).toEqual({ evidence: issue, label: null });
    expect(existsSync(issue)).toBe(true);
  });
});

describe('checkLabel', () => {
  it('accepts a single folder name', () => {
    for (const label of [undefined, 'baseline', 'ticket-2', 'v1.2', 'run_3']) expect(() => checkLabel(label)).not.toThrow();
  });

  it('rejects labels that are not one folder name', () => {
    for (const label of ['', 'a/b', '../escape', '.', '..', 'with space', '基準', 'a\\b']) {
      expect(() => checkLabel(label), JSON.stringify(label)).toThrow('one folder name');
    }
  });

  it('is applied before any folder is made', () => {
    const { issue } = inWorktree();
    expect(() => claimEvidence(111, '..')).toThrow('one folder name');
    expect(() => claimEvidence(111, 'a/b')).toThrow('one folder name');
    expect(existsSync(issue)).toBe(false);
  });
});

describe('locations', () => {
  it('keep evidence in the worktree the command runs in and scratch runs in the main checkout', () => {
    const { main, worktree } = inWorktree();
    expect(evidenceDir(111, 'smoke')).toBe(path.join(worktree, '.local', 'ticket-artifacts', '111', 'smoke'));
    expect(runsRoot()).toBe(path.join(main, '.local', 'verify-runs'));

    process.chdir(main);
    expect(evidenceDir(111, 'smoke')).toBe(path.join(main, '.local', 'ticket-artifacts', '111', 'smoke'));
    expect(runsRoot()).toBe(path.join(main, '.local', 'verify-runs'));
  });
});
