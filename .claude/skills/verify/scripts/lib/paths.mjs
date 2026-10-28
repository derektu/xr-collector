// Where a verification run keeps things. The checkout under test is the Git worktree the command
// runs in (or --checkout). Evidence belongs to the worktree the command runs in, next to the ticket's
// flow scripts, whichever checkout is under test. Scratch state of runs lives in the main checkout's
// .local/, so sweep sees the runs of every worktree.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Git's stderr is captured, so its line-ending warnings on Windows checkouts stay out of a command's
// output; a failing command still throws with it.
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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

/** The file that marks an explicit evidence folder as taken by one run. */
const CLAIM_FILE = '.claimed';

/**
 * Claims the evidence folder of one run and returns { evidence, label, created }. An explicit
 * `evidence` folder (a path from the command line, for a run whose evidence is collected from
 * another machine) is used as given; it must be missing or empty, so a run never mixes with an
 * earlier one, and the run marks it with a `.claimed` file, so two runs given the same folder at
 * once never share it. Otherwise the first run of a label gets `<label>/`; when that folder exists, the next
 * free `<label>-2/`, `<label>-3/`… is created, so an earlier run's results.json and screenshots are
 * never overwritten. `label` is the folder name actually used, or the label as given with an explicit
 * folder. Without either, the evidence is the issue folder itself, shared by every unlabelled run of
 * the issue. `created` tells whether this call made the folder.
 */
export function claimEvidence(issue, label, { evidence: explicit } = {}) {
  checkLabel(label);
  if (explicit) {
    const evidence = path.resolve(explicit);
    if (existsSync(evidence) && readdirSync(evidence).length) throw new Error(`Evidence folder ${evidence} is not empty; give a new or empty folder`);
    const created = !existsSync(evidence);
    mkdirSync(evidence, { recursive: true });
    try {
      closeSync(openSync(path.join(evidence, CLAIM_FILE), 'wx'));
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Evidence folder ${evidence} is not empty; give a new or empty folder`);
      throw error;
    }
    return { evidence, label: label === undefined ? null : String(label), created };
  }
  if (!label) {
    const evidence = evidenceDir(issue);
    mkdirSync(evidence, { recursive: true });
    return { evidence, label: null, created: false };
  }
  mkdirSync(evidenceDir(issue), { recursive: true });
  for (let number = 1; ; number += 1) {
    const candidate = number === 1 ? String(label) : `${label}-${number}`;
    const evidence = evidenceDir(issue, candidate);
    try {
      // Without `recursive`, mkdir fails on an existing folder, which also keeps two launches of one
      // label from sharing a folder.
      mkdirSync(evidence);
      return { evidence, label: candidate, created: true };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

/** Removes an evidence folder a failed launch made and never wrote to; its claim file does not count. */
export function dropUnusedEvidence({ evidence, created }) {
  if (!created) return;
  try {
    if (readdirSync(evidence).every((file) => file === CLAIM_FILE)) rmSync(evidence, { recursive: true });
  } catch { /* already gone */ }
}

/** A label becomes one folder name: letters, digits, dot, dash and underscore, other than `.` and `..`. */
export function checkLabel(label) {
  if (label === undefined) return;
  const name = String(label);
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error(`Label ${label} must be one folder name: letters, digits, ., - or _`);
}

/** Scratch folders of runs: profile, Vault, the run's Web build, run.json. Removed by stop. */
export function runsRoot(from = process.cwd()) {
  return path.join(mainCheckout(from), '.local', 'verify-runs');
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

export { processStart } from './platform.mjs';

/**
 * The argument that marks a process the run started (its Web server or Electron). The trailing slash
 * ends the path, so a run directory never matches the start of another one, spaces included.
 */
export const runMarker = (runDir) => `--xr-verify-run=${runDir}/`;

/** The main executable of a macOS app bundle: development Electron or a packaged app. */
const isAppExecutable = (executable) => /\.app\/Contents\/MacOS\/[^/]+$/u.test(executable);

/**
 * The arguments of a Windows command line, split the way CommandLineToArgvW splits them: whitespace
 * outside double quotes separates arguments, quotes group, and backslashes escape only a quote.
 */
export function windowsArgs(command) {
  const args = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at];
    if (char === '\\') {
      let count = 0;
      while (command[at] === '\\') { count += 1; at += 1; }
      if (command[at] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) current += '"'; else quoted = !quoted;
      } else {
        current += '\\'.repeat(count);
        at -= 1;
      }
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/u.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/**
 * Whether a process is one of the run's own programs, by its executable and command line: node
 * running server.mts or the run's app (development Electron or the packaged app), carrying the run
 * marker, or meilisearch with its data in the run's profile. Any other program that mentions the
 * marker or the directory (a `pgrep -f` with the whole server command line as its pattern, a `tail`
 * of the log, `verify.mjs stop --run`) does not count.
 *
 * On macOS an app is any app bundle's main executable. A Windows executable says nothing about
 * being an app, so there the app is the executable the run recorded as its target (`apps`), compared
 * case-insensitively, and the command line is read as Windows arguments, quotes included.
 */
export function isRunProcess(command, runDir, executable, { platform = process.platform, apps = [] } = {}) {
  if (platform === 'win32') return isWindowsRunProcess(command, runDir, executable, apps);
  const program = path.basename(executable ?? '');
  const padded = ` ${command} `;
  if (padded.includes(` ${runMarker(runDir)} `)) {
    return (program === 'node' && padded.includes('server.mts ')) || isAppExecutable(executable ?? '');
  }
  return program === 'meilisearch' && padded.includes(` --db-path ${runDir}/profile/`);
}

function isWindowsRunProcess(command, runDir, executable, apps) {
  if (!executable) return false;
  const fold = (value) => path.win32.resolve(value).toLowerCase();
  const program = path.win32.basename(executable).toLowerCase();
  const args = windowsArgs(command ?? '');
  // Windows paths ignore case, so the marker naming the run folder does too.
  const marker = runMarker(runDir).toLowerCase();
  if (args.some((arg) => arg.toLowerCase() === marker)) {
    return (program === 'node.exe' && args.some((arg) => arg.toLowerCase().endsWith('server.mts')))
      || apps.some((app) => fold(app) === fold(executable));
  }
  if (program !== 'meilisearch.exe') return false;
  const database = args[args.indexOf('--db-path') + 1];
  return args.includes('--db-path') && Boolean(database) && database.toLowerCase().startsWith(`${path.win32.join(runDir, 'profile').toLowerCase()}\\`);
}

/**
 * Whether a process is an instance of the app whose main executable is named `name` that verify did
 * not start (no run marker): the user's installed App, or any other copy of the same program. On
 * Windows `name` includes `.exe`, and Chromium's helper processes run the same executable with
 * `--type=…`, so those are left out.
 */
export function isUnmarkedAppInstance(command, executable, name, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    const args = windowsArgs(command ?? '');
    return path.win32.basename(executable ?? '').toLowerCase() === name.toLowerCase()
      && !args.some((arg) => arg.startsWith('--type=') || arg.startsWith('--xr-verify-run='));
  }
  return (executable ?? '').endsWith(`.app/Contents/MacOS/${name}`) && !` ${command} `.includes(' --xr-verify-run=');
}

/** The copy of the environment a run's processes start with: the shell's XR_COLLECTOR_* settings removed. */
export function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('XR_COLLECTOR_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
