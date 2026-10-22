// Launching, attaching to and stopping one verification instance (Web mode): server.mts on a slot
// of reserved ports, with its own profile, Vault and Web build under .local/verify-runs/<issue>-<time>-<pid>/.
// An instance is identified by its run directory; stop only signals a process group whose members
// name that directory on their command line, so the user's own App and other agents' runs are never touched.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutRoot, cleanEnv, commitOf, evidenceDir, namesRun, processStart, runsRoot, SLOT_LOCKS, SLOTS, stamp } from './paths.mjs';
import { defaultCatalog, syntheticAddresses } from './synthetic.mjs';
import { sleep, waitFor } from './wait.mjs';

const OWN_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mts');

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commandOf = (pid) => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } };

/** Every process in group `pgid`: { pid, command }. */
function groupMembers(pgid) {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return table.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)).filter(Boolean)
    .filter((match) => Number(match[2]) === pgid).map((match) => ({ pid: Number(match[1]), command: match[3] }));
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

// ---- slot locks --------------------------------------------------------------------------------
// A lock names its holder by PID and start time, so a reused PID never keeps a slot. Claiming runs
// under a directory mutex; lock contents are written to a temporary file and renamed into place, so
// readers never see a partial lock.

const lockPath = (slot) => path.join(SLOT_LOCKS, `${slot}.json`);

function readLock(slot) {
  const file = lockPath(slot);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { slot, unreadable: true, runDir: null, writtenAt: statSync(file).mtimeMs };
  }
}

/** Whether the lock's holder is the process that wrote it. An unreadable lock counts as held for a minute. */
export const lockLive = (lock) => Boolean(lock) && (lock.unreadable
  ? Date.now() - lock.writtenAt < 60_000
  : Boolean(lock.start) && processStart(lock.pid) === lock.start);

function writeLock(slot, content) {
  const temporary = `${lockPath(slot)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(content, null, 2));
  renameSync(temporary, lockPath(slot));
}

/** Records `pid` as the holder of the slot the run holds. */
export function holdSlot(slot, runDir, pid) {
  writeLock(slot, { slot, runDir, pid, start: processStart(pid) });
}

async function withClaimMutex(body) {
  const mutex = path.join(SLOT_LOCKS, 'claim.lock');
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(mutex);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A claim takes well under a second; an older mutex was left by a crashed claim.
      if (Date.now() - statSync(mutex).mtimeMs > 15_000) rmSync(mutex, { recursive: true, force: true });
      if (Date.now() > deadline) throw new Error(`Slot claim mutex ${mutex} is held; remove it if no launch is running`);
      await sleep(100);
    }
  }
  try { return await body(); } finally { rmSync(mutex, { recursive: true, force: true }); }
}

/** The state of each slot lock: { slot, runDir, pid, live }. */
export function slotHolders() {
  return SLOTS.map((ports) => readLock(ports.slot)).filter(Boolean).map((lock) => ({ ...lock, live: lockLive(lock) }));
}

/** Takes the first slot with no live lock and all four ports free, held by this process for `runDir`. */
export async function claimSlot(runDir) {
  await mkdir(SLOT_LOCKS, { recursive: true });
  return withClaimMutex(async () => {
    for (const ports of SLOTS) {
      const lock = readLock(ports.slot);
      if (lockLive(lock)) continue;
      const free = await Promise.all([ports.ui, ports.search, ports.agent, ports.feeds].map(portFree));
      if (!free.every(Boolean)) continue;
      holdSlot(ports.slot, runDir, process.pid);
      return ports;
    }
    throw new Error(`All ${SLOTS.length} verify slots are busy; run "verify.mjs doctor" to see who holds them`);
  });
}

export function releaseSlot(slot, runDir) {
  const lock = readLock(slot);
  if (lock?.runDir === runDir) rmSync(lockPath(slot), { force: true });
}

// ---- runs --------------------------------------------------------------------------------------

/** Creates a new run directory; the PID in its name keeps simultaneous launches of one issue apart. */
export async function createRunDir(issue, checkout, suffix = '') {
  const root = runsRoot(checkout);
  await mkdir(root, { recursive: true });
  const runDir = path.join(root, `${issue}-${stamp()}-${process.pid}${suffix}`);
  await mkdir(runDir);
  return runDir;
}

/**
 * Starts a Web instance and waits until the UI answers and search is ready. Options: issue
 * (required), checkout, data ('synthetic' | 'real'), vault ('selected' | 'fixed' | 'none'),
 * catalog (synthetic catalog; defaultCatalog() otherwise), build (false copies the checkout's
 * existing dist/web instead of building). The server is the checkout's own copy of server.mts, so
 * it matches the src/ it loads.
 */
export async function launchWeb({ issue, checkout = checkoutRoot(), data = 'synthetic', vault = 'selected', catalog, build = true } = {}) {
  if (!issue) throw new Error('launchWeb needs an issue (number or label) for the evidence folder');
  checkout = path.resolve(checkout);
  const runDir = await createRunDir(issue, checkout);
  const evidence = evidenceDir(issue, checkout);
  await mkdir(path.join(runDir, 'profile'), { recursive: true });
  await mkdir(evidence, { recursive: true });
  const ports = await claimSlot(runDir);
  let server = null;
  try {
    const initial = data === 'synthetic' ? (catalog ?? defaultCatalog()) : { youtube: { channels: [] }, feeds: {} };
    await writeFile(path.join(runDir, 'catalog.json'), JSON.stringify(initial, null, 2));
    const web = path.join(runDir, 'web');
    if (build) {
      execFileSync(path.join(checkout, 'node_modules', '.bin', 'vite'), ['build', '--outDir', web, '--emptyOutDir', '--logLevel', 'warn'],
        { cwd: checkout, stdio: ['ignore', 'inherit', 'inherit'] });
    } else {
      const built = path.join(checkout, 'dist', 'web');
      if (!existsSync(path.join(built, 'index.html'))) throw new Error(`--no-build needs ${built}; run npm run build:web first`);
      await cp(built, web, { recursive: true });
    }
    const script = existsSync(path.join(checkout, '.claude', 'skills', 'verify', 'scripts', 'server.mts'))
      ? path.join(checkout, '.claude', 'skills', 'verify', 'scripts', 'server.mts') : OWN_SERVER;
    const log = openSync(path.join(runDir, 'server.log'), 'a');
    // --run is not read by server.mts; it puts the run directory in the command line stop checks.
    server = spawn(path.join(checkout, 'node_modules', '.bin', 'tsx'), [script, '--run', runDir], {
      cwd: checkout, detached: true, stdio: ['ignore', log, log],
      env: {
        ...cleanEnv(), XR_VERIFY_CHECKOUT: checkout, XR_VERIFY_RUN: runDir, XR_VERIFY_DATA: data, XR_VERIFY_VAULT_MODE: vault,
        XR_VERIFY_UI_PORT: String(ports.ui), XR_VERIFY_SEARCH_PORT: String(ports.search),
        XR_VERIFY_AGENT_PORT: String(ports.agent), XR_VERIFY_FEEDS_PORT: String(ports.feeds),
      },
    });
    server.unref();
    closeSync(log);
    holdSlot(ports.slot, runDir, server.pid);
    const url = `http://127.0.0.1:${ports.ui}`;
    const record = {
      kind: 'web', issue: String(issue), runDir, evidence, checkout, ...commitOf(checkout), data, vault, ports, pid: server.pid, url,
      feedsOrigin: `http://127.0.0.1:${ports.feeds}`, server: script, startedAt: new Date().toISOString(),
    };
    if (data === 'synthetic') record.synthetic = syntheticAddresses(initial, record.feedsOrigin);
    await writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2));
    await waitFor(async () => {
      if (!alive(server.pid)) throw new Error(`server exited:\n${tail(path.join(runDir, 'server.log'))}`);
      const health = await fetch(`${url}/api/health`).then((response) => response.ok, () => false);
      if (!health) return false;
      if (vault === 'none') return true;
      const search = await fetch(`${url}/api/search/status`).then((response) => response.json(), () => null);
      return search?.status?.state === 'ready';
    }, 'UI and search ready', { timeout: 120_000, fatal: (error) => error.message.startsWith('server exited') });
    return instance(record);
  } catch (error) {
    // The run directory is this launch's own, so its server is the one to stop. The folder stays
    // for diagnosis until sweep.
    if (server?.pid && groupMembers(server.pid).length) {
      try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    releaseSlot(ports.slot, runDir);
    throw error;
  }
}

const tail = (file, lines = 30) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n') : '';

/** Reads a running instance back from its run directory. */
export function attach(runDir) {
  const file = path.join(path.resolve(runDir), 'run.json');
  if (!existsSync(file)) throw new Error(`No run.json in ${runDir}`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.kind === 'electron') throw new Error(`${runDir} is an Electron run; it is driven only by the flow that launched it`);
  return instance(record);
}

function instance(record) {
  const catalogFile = path.join(record.runDir, 'catalog.json');
  return {
    ...record,
    /** JSON from the same HTTP API the Web UI calls; throws with the body on an error status. */
    async api(pathname, init = {}) {
      const response = await fetch(`${record.url}${pathname}`, {
        ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} → ${response.status} ${JSON.stringify(body)}`);
      return body;
    },
    async catalog() { return JSON.parse(await readFile(catalogFile, 'utf8')); },
    /** Edits the synthetic catalog; the server reads it again on its next request. */
    async updateCatalog(edit) {
      const current = JSON.parse(await readFile(catalogFile, 'utf8'));
      await writeFile(catalogFile, JSON.stringify(edit(current) ?? current, null, 2));
    },
    stop: (options) => stopRun(record.runDir, options),
  };
}

/**
 * The live processes of a run. A Web run is the server's process group (tsx, node, Meilisearch),
 * counted only while a member names the run directory: a group without one is a reused PID. An
 * Electron run is the flow process that holds its slot.
 */
export function runProcesses(record) {
  if (record.kind === 'electron') {
    return lockLive({ pid: record.pid, start: record.start }) ? [{ pid: record.pid, command: commandOf(record.pid) }] : [];
  }
  const members = groupMembers(record.pid);
  return members.some((member) => namesRun(member.command, record.runDir)) ? members : [];
}

/**
 * Stops the run's server group through its own SIGTERM shutdown, copies server.log into the
 * evidence folder, releases the slot and removes the scratch folder unless `keep`. Evidence stays.
 * A live Electron run is refused: its flow closes it.
 */
export async function stopRun(runDir, { keep = false } = {}) {
  runDir = path.resolve(runDir);
  const record = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
  if (runProcesses(record).length) {
    if (record.kind === 'electron') throw new Error(`Electron run ${runDir} is held by flow PID ${record.pid}; close it from that flow`);
    process.kill(-record.pid, 'SIGTERM');
    const stopped = await waitFor(() => groupMembers(record.pid).length === 0, 'server exit', { timeout: 30_000 }).then(() => true, () => false);
    if (!stopped) {
      process.kill(-record.pid, 'SIGKILL');
      await waitFor(() => groupMembers(record.pid).length === 0, 'server kill', { timeout: 10_000 });
    }
  }
  await mkdir(record.evidence, { recursive: true });
  if (existsSync(path.join(runDir, 'server.log'))) {
    await copyFile(path.join(runDir, 'server.log'), path.join(record.evidence, `${path.basename(runDir)}-server.log`));
  }
  releaseSlot(record.ports.slot, runDir);
  if (!keep) await rm(runDir, { recursive: true, force: true });
  return { runDir, removed: !keep, evidence: record.evidence };
}

/**
 * Removes slot locks whose holder is gone, and scratch folders of runs that have no live process:
 * crashed flows, failed launches, runs stopped with --keep. A folder a live slot lock names, or one
 * without run.json younger than ten minutes (a launch still building), is left alone.
 */
export function sweepStale(from) {
  const holders = slotHolders();
  for (const lock of holders) if (!lock.live) rmSync(lockPath(lock.slot), { force: true });
  const root = runsRoot(from);
  if (!existsSync(root)) return [];
  const held = new Set(holders.filter((lock) => lock.live).map((lock) => lock.runDir));
  const removed = [];
  for (const name of readdirSync(root)) {
    const runDir = path.join(root, name);
    if (held.has(runDir)) continue;
    const file = path.join(runDir, 'run.json');
    const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (record) {
      if (runProcesses(record).length) continue;
    } else if (Date.now() - statSync(runDir).mtimeMs < 10 * 60_000) {
      continue;
    }
    rmSync(runDir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
