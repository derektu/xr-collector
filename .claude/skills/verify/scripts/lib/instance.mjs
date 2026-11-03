// Launching, attaching to and stopping one verification instance (Web mode): server.mts on a slot
// of reserved ports, with its own profile, Vault and Web build under .local/verify-runs/<issue>-<time>-<pid>/.
// stop ends the PID run.json records, and only while its command line carries the run marker, so the
// user's own App, terminals and other agents' runs are never touched. Web mode runs on macOS; slots
// and stop also serve Desktop runs on Windows.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { checkoutRoot, claimEvidence, cleanEnv, dropUnusedEvidence, commitOf, hasMarker, runMarker, runsRoot, SLOT_LOCKS, SLOTS, stamp } from './paths.mjs';
import { commandOf, endWindowsTree, processTable, programName, WINDOWS } from './platform.mjs';
import { readState } from './state.mjs';
import { runtimeBin } from './target.mjs';
import { defaultCatalog, syntheticAddresses } from './synthetic.mjs';
import { sleep, waitFor } from './wait.mjs';

/** Whether a process runs; EPERM is a process of another user. */
export const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** Whether any process of the group remains; EPERM is a member owned by another user. */
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** Writes JSON through a temporary file and a rename, so readers never see a partial file. */
export function writeJsonAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  // Run metadata can contain profile-local paths. The renamed destination keeps this mode on POSIX;
  // Windows continues to rely on the containing user's ACL.
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

/** A run's run.json; null when missing, { unreadable: true } when it cannot be parsed. */
export function readRecord(runDir) {
  const file = path.join(runDir, 'run.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { unreadable: true, runDir };
  }
}

export function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

// ---- slot locks --------------------------------------------------------------------------------
// A slot's lock file names the PID that keeps the slot (the run's server, or the flow process that
// drives an Electron run) and the run folder. It is created whole and exclusively by a hard link, so
// two launches never both take it; a lock whose PID no longer runs is stale and taken over.

/** How long a launch waits for a slot while all of them are busy, such as with flows of other worktrees. */
const SLOT_WAIT_MS = 10 * 60_000;

const lockPath = (slot) => path.join(SLOT_LOCKS, `${slot}.json`);

/** The lock in `file`; null when there is none, {} when it cannot be read. */
function readLock(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return error.code === 'ENOENT' ? null : {};
  }
}

/** Takes the slot's lock for `runDir` unless a running process holds it. */
export function tryLock(slot, runDir) {
  const temporary = `${lockPath(slot)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, runDir }));
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(temporary, lockPath(slot));
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const holder = readLock(lockPath(slot));
        if (holder && alive(holder.pid)) return false;
        // The dead holder's lock moves aside before the slot is taken. When another launch took the
        // slot between the read and the move, the moved lock is that launch's and goes back.
        const aside = `${lockPath(slot)}.${randomUUID()}.stale`;
        try {
          renameSync(lockPath(slot), aside);
        } catch (moveError) {
          if (moveError.code === 'ENOENT') continue;
          throw moveError;
        }
        const moved = readLock(aside);
        if (moved?.pid !== holder?.pid || moved?.runDir !== holder?.runDir) {
          try { linkSync(aside, lockPath(slot)); } catch { /* a third launch holds the slot now */ }
          rmSync(aside, { force: true });
          return false;
        }
        rmSync(aside, { force: true });
      }
    }
    return false;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Records `pid` as the holder of the slot the run holds. */
export function holdSlot(slot, runDir, pid) {
  writeJsonAtomic(lockPath(slot), { pid, runDir });
}

/**
 * Takes the first slot whose lock is free and whose four ports are free, held by this process for
 * `runDir`. While every slot is busy it waits for one, up to SLOT_WAIT_MS.
 */
export async function claimSlot(runDir) {
  mkdirSync(SLOT_LOCKS, { recursive: true });
  const deadline = Date.now() + SLOT_WAIT_MS;
  for (;;) {
    for (const ports of SLOTS) {
      if (!tryLock(ports.slot, runDir)) continue;
      if ((await Promise.all([ports.ui, ports.search, ports.agent, ports.feeds].map(portFree))).every(Boolean)) return ports;
      releaseSlot(ports.slot, runDir);
    }
    if (Date.now() > deadline) {
      throw new Error(`All ${SLOTS.length} verify slots stayed busy for ${SLOT_WAIT_MS / 60_000} minutes. Each lock in ${SLOT_LOCKS} names its PID and run folder; end a leftover run with verify.mjs stop --run <runDir>`);
    }
    await sleep(1_000);
  }
}

/** Releases the slot if its lock names `runDir`. */
export function releaseSlot(slot, runDir) {
  if (readLock(lockPath(slot))?.runDir === runDir) rmSync(lockPath(slot), { force: true });
}

// ---- runs --------------------------------------------------------------------------------------

/**
 * Creates a new run directory and claims a slot for it; the PID in its name keeps launches from
 * different processes apart, and a counter (`-2`, `-3`…) the launches one process makes in the same
 * second, such as flows run side by side. When no slot is free the directory is removed again.
 */
export async function createRun(issue, { label, suffix = '' } = {}) {
  const root = runsRoot();
  await mkdir(root, { recursive: true });
  const base = path.join(root, `${issue}${label ? `-${label}` : ''}-${stamp()}-${process.pid}`);
  let runDir;
  for (let number = 1; !runDir; number += 1) {
    const candidate = `${base}${number === 1 ? '' : `-${number}`}${suffix}`;
    try {
      await mkdir(candidate);
      runDir = candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  try {
    return { runDir, ports: await claimSlot(runDir) };
  } catch (error) {
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Ends a launch that failed: the run's log goes to the evidence folder for diagnosis, the slot is
 * released and the scratch folder removed; an evidence folder left empty is removed too.
 */
export function abandonRun({ runDir, ports, evidence }) {
  const log = path.join(runDir, 'server.log');
  if (existsSync(log)) {
    mkdirSync(evidence, { recursive: true });
    copyFileSync(log, path.join(evidence, `${path.basename(runDir)}-server.log`));
  }
  releaseSlot(ports.slot, runDir);
  rmSync(runDir, { recursive: true, force: true });
  dropUnusedEvidence({ evidence });
}

/**
 * Starts a Web instance and waits until the UI answers and search is ready. Options: issue
 * (required), label (names the run's new evidence folder, see claimEvidence), evidence (an explicit
 * evidence folder, missing or empty), checkout, data ('synthetic' | 'real'), vault ('selected' |
 * 'fixed' | 'none'), catalog (synthetic catalog; defaultCatalog() otherwise). The Web UI is built
 * from the checkout into the run every time, and the checkout's own server.mts serves it.
 */
export async function launchWeb({ issue, label, evidence, checkout = checkoutRoot(), data = 'synthetic', vault = 'selected', catalog } = {}) {
  if (!issue) throw new Error('launchWeb needs an issue (number or label) for the evidence folder');
  if (process.platform !== 'darwin') throw new Error(`Web mode runs on macOS; on ${process.platform} use the Desktop runs (launchElectron)`);
  checkout = path.resolve(checkout);
  // server.mts runs the checkout's Meilisearch; without it search never becomes ready, so the run
  // fails here, before it holds an evidence folder or a slot.
  const meilisearch = path.join(runtimeBin(checkout), 'meilisearch');
  if (!existsSync(meilisearch)) throw new Error(`${meilisearch} is missing; run npm run download:runtime in ${checkout}`);
  const claimed = claimEvidence(issue, label, { evidence });
  let run;
  try {
    run = await createRun(issue, { label: claimed.label ?? undefined });
  } catch (error) {
    dropUnusedEvidence(claimed);
    throw error;
  }
  const { runDir, ports } = run;
  await mkdir(path.join(runDir, 'profile'), { recursive: true });
  let pid = null;
  try {
    const initial = data === 'synthetic' ? (catalog ?? defaultCatalog()) : { youtube: { channels: [] }, feeds: {} };
    await writeFile(path.join(runDir, 'catalog.json'), JSON.stringify(initial, null, 2));
    execFileSync(path.join(checkout, 'node_modules', '.bin', 'vite'), ['build', '--outDir', path.join(runDir, 'web'), '--emptyOutDir', '--logLevel', 'warn'],
      { cwd: checkout, stdio: ['ignore', 'inherit', 'inherit'] });
    const record = {
      kind: 'web', issue: String(issue), ...(claimed.label ? { label: claimed.label } : {}), runDir, evidence: claimed.evidence,
      checkout, ...commitOf(checkout), data, vault, ports, pid: null, url: `http://127.0.0.1:${ports.ui}`,
      feedsOrigin: `http://127.0.0.1:${ports.feeds}`, server: path.join(checkout, '.claude', 'skills', 'verify', 'scripts', 'server.mts'),
      startedAt: new Date().toISOString(),
    };
    if (data === 'synthetic') record.synthetic = syntheticAddresses(initial, record.feedsOrigin);
    pid = spawnServer(record);
    record.pid = pid;
    writeJsonAtomic(path.join(runDir, 'run.json'), record);
    await serverReady(record);
    return instance(record);
  } catch (error) {
    // The server is this launch's own: it leads its own process group, Meilisearch included.
    if (pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    abandonRun({ runDir, ports, evidence: claimed.evidence });
    throw error;
  }
}

/**
 * Starts the run's server.mts detached (leading its own process group), its output appended to the
 * run's server.log, and records the new PID in the slot lock. Returns the PID.
 */
function spawnServer(record) {
  const { checkout, runDir, ports } = record;
  const log = openSync(path.join(runDir, 'server.log'), 'a');
  // server.mts does not read the marker; stop checks it before signalling the recorded PID.
  const server = spawn(path.join(checkout, 'node_modules', '.bin', 'tsx'), [record.server, runMarker(runDir)], {
    cwd: checkout, detached: true, stdio: ['ignore', log, log],
    env: {
      ...cleanEnv(), XR_VERIFY_CHECKOUT: checkout, XR_VERIFY_RUN: runDir, XR_VERIFY_DATA: record.data, XR_VERIFY_VAULT_MODE: record.vault,
      XR_VERIFY_UI_PORT: String(ports.ui), XR_VERIFY_SEARCH_PORT: String(ports.search),
      XR_VERIFY_AGENT_PORT: String(ports.agent), XR_VERIFY_FEEDS_PORT: String(ports.feeds),
    },
  });
  server.unref();
  closeSync(log);
  holdSlot(ports.slot, runDir, server.pid);
  return server.pid;
}

/** Waits until the UI answers and search is ready (health only while no Vault is open). */
function serverReady(record) {
  return waitFor(async () => {
    if (!alive(record.pid)) throw new Error(`server exited:\n${tail(path.join(record.runDir, 'server.log'))}`);
    const health = await fetch(`${record.url}/api/health`).then((response) => response.ok, () => false);
    if (!health) return false;
    const vault = await fetch(`${record.url}/api/vault/status`).then((response) => response.json(), () => null);
    if (record.vault === 'none' && !vault?.vaultPath) return true;
    const search = await fetch(`${record.url}/api/search/status`).then((response) => response.json(), () => null);
    return search?.status?.state === 'ready';
  }, 'UI and search ready', { timeout: 120_000, fatal: (error) => error.message.startsWith('server exited') });
}

const tail = (file, lines = 30) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n') : '';

/** Reads a running instance back from its run directory. */
export function attach(runDir) {
  const record = readRecord(path.resolve(runDir));
  if (!record) throw new Error(`No run.json in ${runDir}`);
  if (record.unreadable) throw new Error(`${runDir}/run.json cannot be read`);
  if (record.kind === 'electron') throw new Error(`${runDir} is an Electron run; it is driven only by the flow that launched it`);
  return instance(record);
}

function instance(record) {
  const catalogFile = path.join(record.runDir, 'catalog.json');
  const self = {
    ...record,
    /**
     * JSON from the same HTTP API the Web UI calls; throws with the body on an error status. A
     * request carries content-type: application/json only when it has a body, as the UI's do.
     */
    async api(pathname, init = {}) {
      const response = await fetch(`${record.url}${pathname}`, {
        ...init, headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} → ${response.status} ${JSON.stringify(body)}`);
      return body;
    },
    async catalog() { return JSON.parse(await readFile(catalogFile, 'utf8')); },
    /** Edits the synthetic catalog; the server reads it again on its next request. */
    async updateCatalog(edit) {
      const current = JSON.parse(await readFile(catalogFile, 'utf8'));
      writeJsonAtomic(catalogFile, edit(current) ?? current);
    },
    /** What the synthetic server holds now, by key (see server.mts): for example { 'capture:<video ID>': 1 }. */
    async held() {
      return JSON.parse(await readFile(path.join(record.runDir, 'held.json'), 'utf8').catch(() => '{}'));
    },
    /**
     * Stops the server and starts it again on the same run: same profile, Vault, catalog, ports and
     * slot. By default the runtime shuts down through SIGTERM, as a user quitting the app does;
     * `crash: true` SIGKILLs the run's processes, so the runtime sees an unclean stop on its next
     * start. Resolves once the restarted server is ready. A `page` given here waits on about:blank
     * meanwhile and loads its route again afterwards. server.log keeps growing: a line
     * `--- verify restart (graceful|crash) <time> ---` separates the runs of the server. A slot whose
     * lock names another run (taken after this run's server died) is refused.
     */
    async restart({ crash = false, page } = {}) {
      const lock = readLock(lockPath(record.ports.slot));
      if (lock?.runDir !== record.runDir) {
        throw new Error(`Slot ${record.ports.slot} is no longer held by ${record.runDir}; launch a new run instead of restarting it`);
      }
      const route = page ? new URL(page.url()).pathname : null;
      if (page) await page.goto('about:blank');
      // Between the old server's exit and the new server's start the lock names this flow, so the
      // slot never looks stale to another launch.
      holdSlot(record.ports.slot, record.runDir, process.pid);
      await terminateRun(record, { kill: crash });
      appendFileSync(path.join(record.runDir, 'server.log'), `\n--- verify restart (${crash ? 'crash' : 'graceful'}) ${new Date().toISOString()} ---\n`);
      record.pid = spawnServer(record);
      self.pid = record.pid;
      writeJsonAtomic(path.join(record.runDir, 'run.json'), record);
      await serverReady(record);
      if (page) await page.goto(`${record.url}${route}`);
    },
    /** The run's data state from the API, the Vault, the profile and the index (see readState). */
    state: () => readState(record.runDir),
    stop: (options) => stopRun(record.runDir, options),
  };
  return self;
}

/** The process that runs the program under test: the Web server, or the app of an Electron run. */
const programPid = (record) => (record.kind === 'electron' ? record.appPid : record.pid);

/**
 * The live processes of a run: its program (the Web server or the app, while its command line
 * carries the run marker) with role 'server', and on macOS its Meilisearch (data in the run's
 * profile) with role 'search'. Windows does not show Meilisearch's key, so its index is never read
 * and its process is not looked up.
 */
export function runProcesses(record) {
  const found = [];
  const pid = programPid(record);
  if (alive(pid) && hasMarker(commandOf(pid), record.runDir)) found.push({ pid, role: 'server' });
  if (!WINDOWS) {
    const database = ` --db-path ${record.profile ?? path.join(record.runDir, 'profile')}/`;
    for (const entry of processTable()) {
      if (programName(entry.executable) === 'meilisearch' && ` ${entry.command} `.includes(database)) found.push({ ...entry, role: 'search' });
    }
  }
  return found;
}

/**
 * Ends the run's program through its own SIGTERM shutdown, with SIGKILL after 30 seconds; `kill:
 * true` sends SIGKILL at once, an unclean stop that skips the runtime's shutdown. The detached
 * server and Playwright's Electron each lead their own process group, which holds Meilisearch and
 * the helpers, so the group is signalled. A group outlives its leader while any member runs, and its
 * ID is not handed to a new process meanwhile, so a group whose leader died still belongs to the run;
 * a live leader is signalled only while its command line carries the run marker.
 *
 * Windows has neither process groups nor a shutdown signal, so there the recorded program is ended
 * with the processes it started (taskkill /T /F) at once. A Desktop flow quits the app through
 * Electron before this, so only what a crashed app or flow left behind is ended this way.
 */
export async function terminateRun(record, { kill = false } = {}) {
  const pid = programPid(record);
  if (!pid) return;
  if (alive(pid) && !hasMarker(commandOf(pid), record.runDir)) {
    throw new Error(`PID ${pid} in ${record.runDir}/run.json is no longer this run's program; end the run's processes by hand`);
  }
  if (WINDOWS) {
    if (!alive(pid)) return;
    endWindowsTree(pid);
    await waitFor(() => !alive(pid), 'run kill', { timeout: 10_000 });
    return;
  }
  if (!groupAlive(pid)) return;
  const signal = (name) => { try { process.kill(-pid, name); } catch { /* group gone */ } };
  if (!kill) {
    signal('SIGTERM');
    if (await waitFor(() => !groupAlive(pid), 'run exit', { timeout: 30_000 }).then(() => true, () => false)) return;
  }
  signal('SIGKILL');
  await waitFor(() => !groupAlive(pid), 'run kill', { timeout: 10_000 });
}

/**
 * Stops the run's processes (terminateRun), copies server.log into the evidence folder, releases
 * the slot and removes the scratch folder unless `keep`. Evidence stays. An Electron run whose flow
 * is still running is refused: the flow closes it. An Electron left behind by a crashed flow is
 * stopped like a server.
 */
export async function stopRun(runDir, { keep = false } = {}) {
  runDir = path.resolve(runDir);
  const record = readRecord(runDir);
  if (!record) throw new Error(`No run.json in ${runDir}`);
  if (record.unreadable) throw new Error(`${runDir}/run.json cannot be read; inspect the folder and its processes by hand`);
  if (record.kind === 'electron' && record.pid !== process.pid && alive(record.pid)) {
    throw new Error(`Electron run ${runDir} is held by flow PID ${record.pid}; close it from that flow`);
  }
  await terminateRun(record);
  await mkdir(record.evidence, { recursive: true });
  if (existsSync(path.join(runDir, 'server.log'))) {
    await copyFile(path.join(runDir, 'server.log'), path.join(record.evidence, `${path.basename(runDir)}-server.log`));
  }
  releaseSlot(record.ports.slot, runDir);
  if (!keep) await rm(runDir, { recursive: true, force: true });
  return { runDir, removed: !keep, evidence: record.evidence };
}
