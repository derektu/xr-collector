// Where a verification run keeps things. The checkout under test is the Git worktree the command
// runs in (or --checkout); scratch state and evidence live in the main checkout's .local/, so runs
// from every ticket worktree land in one place the user reviews.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The top of the Git worktree containing `from`. */
export function checkoutRoot(from = process.cwd()) {
  return git(from, ['rev-parse', '--show-toplevel']);
}

/** The main checkout that every worktree of this repository shares. */
export function mainCheckout(from = process.cwd()) {
  return path.dirname(path.resolve(from, git(from, ['rev-parse', '--git-common-dir'])));
}

/** Evidence of one issue: screenshots, results.json, server logs. Never removed by cleanup. */
export function evidenceDir(issue, from = process.cwd()) {
  return path.join(mainCheckout(from), '.local', 'ticket-artifacts', String(issue));
}

/** Scratch folders of runs: profile, Vault, the run's Web build, run.json. Removed by stop. */
export function runsRoot(from = process.cwd()) {
  return path.join(mainCheckout(from), '.local', 'verify-runs');
}

/** Slot locks are per machine, so worktrees and main checkout never hand out the same ports. */
export const SLOT_LOCKS = path.join(os.homedir(), '.xr-collector', 'verify-slots');

/**
 * Ports reserved in the port registry for this skill (xr-collector — verify slot N). Each slot is
 * four consecutive ports: UI/API, Meilisearch, Agent API, synthetic feeds.
 */
export const SLOTS = [7250, 7254, 7258, 7262].map((base, slot) => ({
  slot, ui: base, search: base + 1, agent: base + 2, feeds: base + 3,
}));

export function commitOf(checkout) {
  return { commit: git(checkout, ['rev-parse', 'HEAD']), dirty: git(checkout, ['status', '--porcelain']) !== '' };
}
