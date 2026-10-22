// Launching, attaching to and stopping one verification instance (Web mode): server.mts on a slot
// of reserved ports, with its own profile, Vault and Web build under .local/verify-runs/<issue>-<time>/.
// An instance is identified by its run directory; stop only signals the process whose command line
// names that directory, so the user's own App and other agents' runs are never touched.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutRoot, commitOf, evidenceDir, runsRoot, SLOT_LOCKS, SLOTS } from './paths.mjs';
import { defaultCatalog, syntheticAddresses } from './synthetic.mjs';
import { waitFor } from './wait.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mts');

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commandOf = (pid) => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } };

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** The holder of each slot lock: { slot, runDir, pid, live }. Locks whose process is gone are stale. */
export function slotHolders() {
  if (!existsSync(SLOT_LOCKS)) return [];
  return readdirSync(SLOT_LOCKS).filter((name) => name.endsWith('.json')).map((name) => {
    const lock = JSON.parse(readFileSync(path.join(SLOT_LOCKS, name), 'utf8'));
    return { ...lock, live: alive(lock.pid) };
  });
}

/** Takes the first slot with no live lock and all four ports free; the lock names the run. */
export async function claimSlot(runDir) {
  await mkdir(SLOT_LOCKS, { recursive: true });
  for (const ports of SLOTS) {
    const lockFile = path.join(SLOT_LOCKS, `${ports.slot}.json`);
    if (existsSync(lockFile)) {
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      if (alive(lock.pid)) continue;
      unlinkSync(lockFile);
    }
    const free = await Promise.all([ports.ui, ports.search, ports.agent, ports.feeds].map(portFree));
    if (!free.every(Boolean)) continue;
    try {
      closeSync(openSync(lockFile, 'wx'));
    } catch {
      continue;
    }
    writeFileSync(lockFile, JSON.stringify({ slot: ports.slot, runDir, pid: process.pid }, null, 2));
    return ports;
  }
  throw new Error(`All ${SLOTS.length} verify slots are busy; run "verify.mjs doctor" to see who holds them`);
}

export function releaseSlot(slot, runDir) {
  const lockFile = path.join(SLOT_LOCKS, `${slot}.json`);
  if (!existsSync(lockFile)) return;
  if (JSON.parse(readFileSync(lockFile, 'utf8')).runDir === runDir) unlinkSync(lockFile);
}

const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);

/**
 * Builds the checkout's Web UI into the run, starts server.mts and waits until the UI answers and
 * search is ready. Options: issue (required), checkout, data ('synthetic' | 'real'),
 * vault ('selected' | 'fixed' | 'none'), catalog (synthetic catalog; defaultCatalog() otherwise),
 * build (false reuses an existing <run>/web).
 */
export async function launchWeb({ issue, checkout = checkoutRoot(), data = 'synthetic', vault = 'selected', catalog, build = true } = {}) {
  if (!issue) throw new Error('launchWeb needs an issue (number or label) for the evidence folder');
  checkout = path.resolve(checkout);
  const runDir = path.join(runsRoot(checkout), `${issue}-${stamp()}`);
  const evidence = evidenceDir(issue, checkout);
  await mkdir(path.join(runDir, 'profile'), { recursive: true });
  await mkdir(evidence, { recursive: true });
  const ports = await claimSlot(runDir);
  try {
    const initial = data === 'synthetic' ? (catalog ?? defaultCatalog()) : { youtube: { channels: [] }, feeds: {} };
    await writeFile(path.join(runDir, 'catalog.json'), JSON.stringify(initial, null, 2));
    if (build) {
      execFileSync(path.join(checkout, 'node_modules', '.bin', 'vite'), ['build', '--outDir', path.join(runDir, 'web'), '--emptyOutDir', '--logLevel', 'warn'],
        { cwd: checkout, stdio: ['ignore', 'inherit', 'inherit'] });
    }
    const log = openSync(path.join(runDir, 'server.log'), 'a');
    // --run is not read by server.mts; it puts the run directory in the command line stop checks.
    const server = spawn(path.join(checkout, 'node_modules', '.bin', 'tsx'), [SERVER, '--run', runDir], {
      cwd: checkout, detached: true, stdio: ['ignore', log, log],
      env: {
        ...process.env, XR_VERIFY_CHECKOUT: checkout, XR_VERIFY_RUN: runDir, XR_VERIFY_DATA: data, XR_VERIFY_VAULT_MODE: vault,
        XR_VERIFY_UI_PORT: String(ports.ui), XR_VERIFY_SEARCH_PORT: String(ports.search),
        XR_VERIFY_AGENT_PORT: String(ports.agent), XR_VERIFY_FEEDS_PORT: String(ports.feeds),
      },
    });
    server.unref();
    closeSync(log);
    writeFileSync(path.join(SLOT_LOCKS, `${ports.slot}.json`), JSON.stringify({ slot: ports.slot, runDir, pid: server.pid }, null, 2));
    const url = `http://127.0.0.1:${ports.ui}`;
    const record = {
      issue: String(issue), runDir, evidence, checkout, ...commitOf(checkout), data, vault, ports, pid: server.pid, url,
      feedsOrigin: `http://127.0.0.1:${ports.feeds}`, startedAt: new Date().toISOString(),
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
    await stopRun(runDir, { keep: true }).catch(() => undefined);
    releaseSlot(ports.slot, runDir);
    throw error;
  }
}

const tail = (file, lines = 30) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n') : '';

/** Reads a running instance back from its run directory. */
export function attach(runDir) {
  const file = path.join(path.resolve(runDir), 'run.json');
  if (!existsSync(file)) throw new Error(`No run.json in ${runDir}`);
  return instance(JSON.parse(readFileSync(file, 'utf8')));
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

/** Whether `pid` is the server of `runDir` (its command line names the run directory). */
export function ownsProcess(pid, runDir) {
  return alive(pid) && commandOf(pid).includes(`--run ${runDir}`);
}

/**
 * Stops the run's server through its own SIGTERM shutdown, copies server.log into the evidence
 * folder, releases the slot and removes the scratch folder unless `keep`. Evidence stays.
 */
export async function stopRun(runDir, { keep = false } = {}) {
  runDir = path.resolve(runDir);
  const record = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
  if (alive(record.pid)) {
    if (!ownsProcess(record.pid, runDir)) throw new Error(`PID ${record.pid} is not this run's server (${commandOf(record.pid)}); not stopping it`);
    // The server runs in its own process group (tsx and its node child); signal the group.
    process.kill(-record.pid, 'SIGTERM');
    const stopped = await waitFor(() => !alive(record.pid), 'server exit', { timeout: 30_000 }).then(() => true, () => false);
    if (!stopped) process.kill(-record.pid, 'SIGKILL');
  }
  await mkdir(record.evidence, { recursive: true });
  if (existsSync(path.join(runDir, 'server.log'))) {
    await copyFile(path.join(runDir, 'server.log'), path.join(record.evidence, `${path.basename(runDir)}-server.log`));
  }
  releaseSlot(record.ports.slot, runDir);
  if (!keep) await rm(runDir, { recursive: true, force: true });
  return { runDir, removed: !keep, evidence: record.evidence };
}

/** Removes scratch folders whose server is gone (a crashed flow, a failed launch). */
export function sweepStale(from) {
  const root = runsRoot(from);
  if (!existsSync(root)) return [];
  const removed = [];
  for (const name of readdirSync(root)) {
    const file = path.join(root, name, 'run.json');
    const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (record && alive(record.pid)) continue;
    // A folder without run.json may be a launch still building its Web UI.
    if (!record && Date.now() - statSync(path.join(root, name)).mtimeMs < 10 * 60_000) continue;
    rmSync(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
