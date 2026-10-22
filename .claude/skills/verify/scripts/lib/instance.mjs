// Launching, attaching to and stopping one verification instance (Web mode): server.mts on a slot
// of reserved ports, with its own profile, Vault and Web build under .local/verify-runs/<issue>-<time>-<pid>/.
// A run's processes are found by their command line (the run marker, or Meilisearch's data path in the
// run), not by a recorded PID. stop signals a whole process group only when its leader is one of
// them, so the user's own App, terminals and other agents' runs are never touched.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutRoot, cleanEnv, commitOf, evidenceDir, isRunProcess, processStart, runMarker, runsRoot, SLOT_LOCKS, SLOTS, stamp } from './paths.mjs';
import { defaultCatalog, syntheticAddresses } from './synthetic.mjs';
import { sleep, waitFor } from './wait.mjs';

const OWN_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mts');

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commandOf = (pid) => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } };

/** Every process on the machine: { pid, pgid, command }. */
function processTable() {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return table.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)).filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }));
}

const groupMembers = (pgids) => processTable().filter((entry) => pgids.has(entry.pgid));

/** Processes the run started: its Web server or Electron (run marker) and Meilisearch. */
function runMembers(runDir) {
  return processTable().filter((entry) => entry.pid !== process.pid && isRunProcess(entry.command, runDir));
}

/** Writes JSON through a temporary file and a rename, so readers never see a partial file. */
export function writeJsonAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
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

const writeLock = (slot, content) => writeJsonAtomic(lockPath(slot), content);

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
      // A claim takes well under a second; an older mutex was left by a crashed claim. The holder
      // may release it between mkdir and stat, which just means trying again.
      let heldSince = null;
      try { heldSince = statSync(mutex).mtimeMs; } catch { /* released meanwhile */ }
      if (heldSince !== null && Date.now() - heldSince > 15_000) rmSync(mutex, { recursive: true, force: true });
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

/** Releases the slot if its lock names `runDir`; an unreadable lock is released too. */
export function releaseSlot(slot, runDir) {
  const lock = readLock(slot);
  if (lock?.runDir === runDir || lock?.unreadable) rmSync(lockPath(slot), { force: true });
}

// ---- runs --------------------------------------------------------------------------------------

/**
 * Creates a new run directory and claims a slot for it; the PID in its name keeps simultaneous
 * launches of one issue apart. When no slot is free the directory is removed again.
 */
export async function createRun(issue, checkout, suffix = '') {
  const root = runsRoot(checkout);
  await mkdir(root, { recursive: true });
  const runDir = path.join(root, `${issue}-${stamp()}-${process.pid}${suffix}`);
  await mkdir(runDir);
  try {
    return { runDir, ports: await claimSlot(runDir) };
  } catch (error) {
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
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
  const { runDir, ports } = await createRun(issue, checkout);
  const evidence = evidenceDir(issue, checkout);
  await mkdir(path.join(runDir, 'profile'), { recursive: true });
  await mkdir(evidence, { recursive: true });
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
    // server.mts does not read the marker; it is how stop and sweep find the run's processes.
    server = spawn(path.join(checkout, 'node_modules', '.bin', 'tsx'), [script, runMarker(runDir)], {
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
    writeJsonAtomic(path.join(runDir, 'run.json'), record);
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
    if (server?.pid) {
      try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    releaseSlot(ports.slot, runDir);
    throw error;
  }
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
      writeJsonAtomic(catalogFile, edit(current) ?? current);
    },
    stop: (options) => stopRun(record.runDir, options),
  };
}

/** Whether the flow process that launched an Electron run is still running. */
const holderLive = (record) => record.kind === 'electron' && Boolean(record.start) && processStart(record.pid) === record.start;

/**
 * The live processes of a run, found by their command line: the Web server or Electron with the run
 * marker, and Meilisearch with its data in the run. An Electron run also counts its flow process
 * while that flow is running.
 */
export function runProcesses(record) {
  const members = runMembers(record.runDir);
  if (holderLive(record)) members.push({ pid: record.pid, pgid: null, command: commandOf(record.pid), holder: true });
  return members;
}

/**
 * Ends the run's processes through their own SIGTERM shutdown, with SIGKILL after 30 seconds. A
 * process group is signalled as a whole only when its leader is one of the run's processes (the
 * detached Web server or Electron), which takes helpers such as esbuild and Electron's helpers
 * along; any other run process, such as a Meilisearch whose leader died, is signalled on its own.
 */
export async function terminateRun(runDir) {
  const members = runMembers(runDir);
  if (!members.length) return;
  const groups = new Set(members.filter((member) => member.pid === member.pgid).map((member) => member.pgid));
  const loose = members.filter((member) => !groups.has(member.pgid)).map((member) => member.pid);
  const signal = (name) => {
    for (const pgid of groups) { try { process.kill(-pgid, name); } catch { /* group gone */ } }
    for (const pid of loose) { try { process.kill(pid, name); } catch { /* gone */ } }
  };
  const gone = () => groupMembers(groups).length === 0 && loose.every((pid) => !alive(pid));
  signal('SIGTERM');
  if (await waitFor(gone, 'run exit', { timeout: 30_000 }).then(() => true, () => false)) return;
  signal('SIGKILL');
  await waitFor(gone, 'run kill', { timeout: 10_000 });
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
  if (holderLive(record)) throw new Error(`Electron run ${runDir} is held by flow PID ${record.pid}; close it from that flow`);
  await terminateRun(runDir);
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
 * crashed flows, failed launches, runs stopped with --keep. Left alone: a folder a live slot lock
 * names, one with live processes (an Electron a crashed flow left behind counts), one without
 * run.json younger than ten minutes (a launch still building), and one whose run.json cannot be
 * read, which is reported in `unreadable`.
 */
export function sweepStale(from) {
  const holders = slotHolders();
  for (const lock of holders) if (!lock.live) rmSync(lockPath(lock.slot), { force: true });
  const root = runsRoot(from);
  const result = { removed: [], live: [], unreadable: [] };
  if (!existsSync(root)) return result;
  const held = new Set(holders.filter((lock) => lock.live).map((lock) => lock.runDir));
  for (const name of readdirSync(root)) {
    const runDir = path.join(root, name);
    if (held.has(runDir)) continue;
    const record = readRecord(runDir);
    if (record?.unreadable) { result.unreadable.push(name); continue; }
    if (record && runProcesses(record).length) { result.live.push(name); continue; }
    if (!record && runMembers(runDir).length) { result.live.push(name); continue; }
    if (!record && Date.now() - statSync(runDir).mtimeMs < 10 * 60_000) continue;
    rmSync(runDir, { recursive: true, force: true });
    result.removed.push(name);
  }
  return result;
}
