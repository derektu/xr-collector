// Where a verification run keeps things. The checkout under test is the Git worktree the command
// runs in (or --checkout). Evidence belongs to the worktree the command runs in, next to the ticket's
// flow scripts, whichever checkout is under test. Scratch state of runs lives in the main checkout's
// .local/, so sweep sees the runs of every worktree.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/** The top of the Git worktree containing `from`. */
export function checkoutRoot(from = process.cwd()) {
  return git(from, ['rev-parse', '--show-toplevel']);
}

/** The main checkout that every worktree of this repository shares. */
export function mainCheckout(from = process.cwd()) {
  return path.dirname(path.resolve(from, git(from, ['rev-parse', '--git-common-dir'])));
}

/**
 * Evidence of one issue in the worktree the command runs in: screenshots, results.json, server logs.
 * A label (baseline, ticket, …) keeps the runs of one issue in their own subfolders. Never removed by
 * cleanup.
 */
export function evidenceDir(issue, label) {
  checkLabel(label);
  return path.join(checkoutRoot(), '.local', 'ticket-artifacts', String(issue), ...(label ? [String(label)] : []));
}

/**
 * Claims the evidence folder of one labelled run and returns { evidence, label }. The first run of a
 * label gets `<label>/`; when that folder exists, the next free `<label>-2/`, `<label>-3/`… is
 * created, so an earlier run's results.json and screenshots are never overwritten. `label` is the
 * folder name actually used. Without a label the evidence is the issue folder itself, shared by
 * every unlabelled run of the issue.
 */
export function claimEvidence(issue, label) {
  if (!label) {
    const evidence = evidenceDir(issue);
    mkdirSync(evidence, { recursive: true });
    return { evidence, label: null };
  }
  mkdirSync(evidenceDir(issue), { recursive: true });
  for (let number = 1; ; number += 1) {
    const candidate = number === 1 ? String(label) : `${label}-${number}`;
    const evidence = evidenceDir(issue, candidate);
    try {
      // Without `recursive`, mkdir fails on an existing folder, which also keeps two launches of one
      // label from sharing a folder.
      mkdirSync(evidence);
      return { evidence, label: candidate };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

/** A label becomes one folder name: letters, digits, dot, dash and underscore. */
export function checkLabel(label) {
  if (label !== undefined && !/^[\w.-]+$/.test(String(label))) throw new Error(`Label ${label} must be one folder name: letters, digits, ., - or _`);
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
 * When a process started, as `ps` reports it; null when it is not running. A PID plus its start time
 * names one process even after the PID is reused.
 */
export function processStart(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The argument that marks a process the run started (its Web server or Electron). The trailing slash
 * ends the path, so a run directory never matches the start of another one, spaces included.
 */
export const runMarker = (runDir) => `--xr-verify-run=${runDir}/`;

/**
 * Whether a process is one of the run's own programs, by its executable and command line: node
 * running server.mts or Electron, carrying the run marker, or meilisearch with its data in the run's
 * profile. Any other program that mentions the marker or the directory (a `pgrep -f` with the whole
 * server command line as its pattern, a `tail` of the log, `verify.mjs stop --run`) does not count.
 */
export function isRunProcess(command, runDir, executable) {
  const program = path.basename(executable ?? '');
  const padded = ` ${command} `;
  if (padded.includes(` ${runMarker(runDir)} `)) {
    return (program === 'node' && padded.includes('server.mts ')) || (program === 'Electron' && executable.endsWith('/Contents/MacOS/Electron'));
  }
  return program === 'meilisearch' && padded.includes(` --db-path ${runDir}/profile/`);
}

/** The copy of the environment a run's processes start with: the shell's XR_COLLECTOR_* settings removed. */
export function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('XR_COLLECTOR_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
