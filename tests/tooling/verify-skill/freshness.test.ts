// Whether an issue's evidence matches the code: each results.json is current while its checkout
// has the recorded commit and sourceHash, and STALE with the difference otherwise. Evidence whose
// checkout does not exist on this machine is compared with the checkout doctor runs in. doctor
// --issue lists the result without changing its exit code.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { evidenceFreshness } from '../../../.claude/skills/verify/scripts/lib/freshness.mjs';
import { commitOf } from '../../../.claude/skills/verify/scripts/lib/paths.mjs';
import { cleanUp, repository, temp } from './support.js';

afterEach(cleanUp);

const CLI = path.resolve(import.meta.dirname, '../../../.claude/skills/verify/scripts/verify.mjs');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=verify-test', '-c', 'user.email=verify-test@example.com', ...args], { cwd, encoding: 'utf8' });

/** A worktree with a tracked source file and .local/ ignored, as in the repository; its issue 118 evidence root. */
function checkout() {
  const { worktree } = repository();
  writeFileSync(path.join(worktree, '.gitignore'), '.local/\n');
  writeFileSync(path.join(worktree, 'source.ts'), 'export const value = 1;\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'source');
  return { worktree, root: path.join(worktree, '.local', 'ticket-artifacts', '118') };
}

function results(root: string, folder: string, fields: Record<string, unknown>) {
  mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, folder, 'results.json'), JSON.stringify({ issue: '118', passed: true, results: [], ...fields }));
}

const byFolder = (report: { folders: Array<{ results: string }> }) => Object.fromEntries(report.folders.map((folder) => [path.dirname(folder.results), folder]));

describe('evidenceFreshness', () => {
  it('tells current evidence from STALE and names the difference', () => {
    const { worktree, root } = checkout();
    const now = commitOf(worktree);
    results(root, 'same', { checkout: worktree, commit: now.commit, sourceHash: now.sourceHash });
    results(root, 'other-commit', { checkout: worktree, commit: 'a'.repeat(40), sourceHash: now.sourceHash });
    results(root, 'other-changes', { checkout: worktree, commit: now.commit, sourceHash: '0123456789abcdef' });
    results(root, 'elsewhere', { checkout: path.join(worktree, 'checkout-that-does-not-exist'), commit: now.commit, sourceHash: now.sourceHash });

    const report = evidenceFreshness(root, { local: worktree });
    const folders = byFolder(report);

    expect(report.stale).toBe(2);
    expect(folders.same).toMatchObject({ status: 'current', comparedWith: worktree, reasons: [] });
    expect(folders['other-commit']).toMatchObject({ status: 'STALE', reasons: [expect.stringContaining('commit differs: aaaaaaaaaaaa recorded')] });
    expect(folders['other-changes']).toMatchObject({ status: 'STALE', reasons: [expect.stringMatching(/sourceHash differs: 0123456789abcdef recorded.*uncommitted changes differ/u)] });
    expect(folders.elsewhere).toMatchObject({ status: 'current', comparedWith: worktree, reasons: [expect.stringContaining(`compared with this checkout (${worktree})`)] });
  });

  it('turns STALE when a source line changes and current again when it is restored', () => {
    const { worktree, root } = checkout();
    const now = commitOf(worktree);
    results(root, 'run', { checkout: worktree, commit: now.commit, sourceHash: now.sourceHash });
    const source = path.join(worktree, 'source.ts');
    const original = readFileSync(source, 'utf8');

    writeFileSync(source, 'export const value = 2;\n');
    const edited = evidenceFreshness(root, { local: worktree }).folders[0];
    writeFileSync(source, original);
    const restored = evidenceFreshness(root, { local: worktree }).folders[0];

    expect(edited).toMatchObject({ status: 'STALE', reasons: [expect.stringContaining('sourceHash differs')] });
    expect(restored).toMatchObject({ status: 'current', reasons: [] });
  });

  it('reports a results.json that does not parse and an issue without evidence', () => {
    const { worktree, root } = checkout();
    mkdirSync(path.join(root, 'broken'), { recursive: true });
    writeFileSync(path.join(root, 'broken', 'results.json'), '{');

    expect(evidenceFreshness(root, { local: worktree }).folders).toEqual([{ results: path.join('broken', 'results.json'), status: 'unreadable', reasons: [expect.any(String)] }]);
    expect(evidenceFreshness(path.join(worktree, 'none'), { local: worktree })).toEqual({ root: path.join(worktree, 'none'), stale: 0, folders: [] });
  });
});

describe('doctor --issue', () => {
  it('lists the evidence and leaves the exit code alone', async () => {
    const { worktree, root } = checkout();
    results(root, 'old', { checkout: worktree, commit: 'b'.repeat(40), sourceHash: commitOf(worktree).sourceHash });
    const home = temp('home');
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [CLI, 'doctor', ...args], { cwd: worktree, env: { ...process.env, HOME: home, USERPROFILE: home } })
      .then((done) => ({ code: 0, stdout: done.stdout }), (failed) => ({ code: failed.code as number, stdout: failed.stdout as string }));

    const plain = await run();
    const withIssue = await run('--issue', '118');
    const report = JSON.parse(withIssue.stdout);

    expect(withIssue.code).toBe(plain.code);
    expect(report.healthy).toBe(JSON.parse(plain.stdout).healthy);
    expect(report.evidence).toMatchObject({ issue: '118', root, stale: 1, folders: [{ status: 'STALE' }] });
  });
});
