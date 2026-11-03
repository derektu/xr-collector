// Where a verification run keeps things. The checkout under test is the Git worktree the command
// runs in (or --checkout). Evidence and the runs' scratch folders belong to the worktree the command
// runs in, next to the ticket's flow scripts, whichever checkout is under test.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Git's stderr is captured, so its line-ending warnings on Windows checkouts stay out of a command's
// output; a failing command still throws with it.
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The top of the Git worktree containing `from`. */
export function checkoutRoot(from = process.cwd()) {
  return git(from, ['rev-parse', '--show-toplevel']);
}

/**
 * Evidence of one issue in the worktree the command runs in: screenshots, results.json, server logs.
 * Never removed by cleanup.
 */
export function evidenceDir(issue) {
  return path.join(checkoutRoot(), '.local', 'ticket-artifacts', String(issue));
}

/**
 * Creates the evidence folder of one run and returns { evidence, label }. Each run gets a new folder,
 * `<issue>/<label>-<local time>/` (`<issue>/<local time>/` without a label), so an earlier run's
 * results.json and screenshots never mix with this one; a second run in the same second gets `-2`.
 * An explicit `evidence` folder (for a run whose evidence is collected from another machine) is used
 * as given and must be missing or empty.
 */
export function claimEvidence(issue, label, { evidence: explicit } = {}) {
  checkLabel(label);
  const named = label === undefined ? null : String(label);
  if (explicit) {
    const evidence = path.resolve(explicit);
    if (existsSync(evidence) && readdirSync(evidence).length) throw new Error(`Evidence folder ${evidence} is not empty; give a new or empty folder`);
    mkdirSync(evidence, { recursive: true });
    return { evidence, label: named };
  }
  const base = path.join(evidenceDir(issue), named ? `${named}-${stamp()}` : stamp());
  mkdirSync(path.dirname(base), { recursive: true });
  for (let number = 1; ; number += 1) {
    const evidence = number === 1 ? base : `${base}-${number}`;
    try {
      // Without `recursive`, mkdir fails on an existing folder, so two runs never share one.
      mkdirSync(evidence);
      return { evidence, label: named };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

/** Removes an evidence folder a failed launch left empty. */
export function dropUnusedEvidence({ evidence }) {
  try { rmdirSync(evidence); } catch { /* has files, or already gone */ }
}

/** A label becomes part of one folder name: letters, digits, dot, dash and underscore, other than `.` and `..`. */
export function checkLabel(label) {
  if (label === undefined) return;
  const name = String(label);
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error(`Label ${label} must be one folder name: letters, digits, ., - or _`);
}

/** Scratch folders of runs: profile, Vault, the run's Web build, run.json. Removed by stop. */
export function runsRoot(from = process.cwd()) {
  return path.join(checkoutRoot(from), '.local', 'verify-runs');
}

/** Slot locks are per machine, so worktrees and main checkout never hand out the same ports. */
export const SLOT_LOCKS = path.join(os.homedir(), '.xr-collector', 'verify-slots');

/**
 * Ports reserved in the port registry for this skill (xr-collector — verify slot N), 7250–7289. Each
 * slot is four consecutive ports: UI/API, Meilisearch, Agent API, synthetic feeds. Ten slots let two
 * or three tickets each run flows with --jobs 3 and still leave one for a manual launch.
 */
export const SLOTS = Array.from({ length: 10 }, (_, slot) => 7250 + slot * 4).map((base, slot) => ({
  slot, ui: base, search: base + 1, agent: base + 2, feeds: base + 3,
}));

/**
 * The checkout's commit and its uncommitted state. `sourceHash` covers `git status`, the diff
 * against HEAD and the contents of untracked files that are not ignored, so any edit after launch
 * shows up even without a new commit.
 */
export function commitOf(checkout) {
  const status = git(checkout, ['status', '--porcelain']);
  const hash = createHash('sha256').update(status).update('\0').update(git(checkout, ['diff', 'HEAD']));
  for (const file of git(checkout, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    hash.update(`\0${file}\0`);
    try { hash.update(readFileSync(path.join(checkout, file))); } catch { /* removed meanwhile */ }
  }
  return { commit: git(checkout, ['rev-parse', 'HEAD']), dirty: status !== '', sourceHash: hash.digest('hex').slice(0, 16) };
}

/** Local time to the second, file-name safe: 2026-10-22T10-58-03. */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/**
 * The argument that marks a process the run started (its Web server or Electron). The trailing slash
 * ends the path, so a run directory never matches the start of another one, spaces included. stop
 * signals a recorded PID only while its command line carries the marker.
 */
export const runMarker = (runDir) => `--xr-verify-run=${runDir}/`;

/** Whether a command line carries the run's marker; Windows paths, and so the marker, ignore case. */
export const hasMarker = (command, runDir) => (process.platform === 'win32'
  ? command.toLowerCase().includes(runMarker(runDir).toLowerCase()) : command.includes(runMarker(runDir)));

/** The copy of the environment a run's processes start with: the shell's XR_COLLECTOR_* settings removed. */
export function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('XR_COLLECTOR_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
