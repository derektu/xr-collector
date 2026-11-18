#!/usr/bin/env node
// The worktree's dev instance: the built Web server (dist/node/transport/server/main.js) on a slot of
// DEV_POOL, with the worktree's own profile (.data) and the Vault a person tries tickets on. Any
// number of worktrees, opened from any tool, share the pool, so no session owns a fixed port. Run
// from the worktree:
//   node scripts/dev.mjs start|stop|status [options]
//
// start builds, takes a free dev slot (the one this worktree used last when it is free), starts the
// server detached and prints the URL once /api/health answers. An instance already running for this
// worktree stops first, so start also restarts after a rebuild. The instance outlives the command;
// stop ends it. .local/dev.json records the instance; .local/dev-server.log is its output. stop
// signals only the PID dev.json records, and only while its command line carries this worktree's
// marker. macOS only: stop ends the server's process group, Meilisearch included.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cleanEnv } from '../.claude/skills/verify/scripts/lib/paths.mjs';
import { alive, commandOf, groupAlive } from '../.claude/skills/verify/scripts/lib/platform.mjs';
import { DEV_POOL, portFree } from '../.claude/skills/verify/scripts/lib/slots.mjs';
import { waitFor } from '../.claude/skills/verify/scripts/lib/wait.mjs';

/** Every ticket is tried on the same Vault, so what a person collected carries over between tickets. */
const DEFAULT_VAULT = path.join(os.homedir(), 'Downloads', 'XRData');

const USAGE = `dev.mjs <command>
  start [--vault <dir>] [--no-build]
         builds (npm run build), starts the Web server on a free dev slot and prints the URL;
         the Vault defaults to ${DEFAULT_VAULT}, the profile is the worktree's .data;
         an instance already running for this worktree stops first
  stop   ends this worktree's dev instance (SIGTERM, SIGKILL after 30 s) and frees its slot
  status prints .local/dev.json and whether the instance runs`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, '.local');
const RECORD = path.join(LOCAL, 'dev.json');
const LOG = path.join(LOCAL, 'dev-server.log');
/** Meilisearch starts with the server and can take a while on a large Vault. */
const READY_TIMEOUT_MS = 120_000;
const EXIT_TIMEOUT_MS = 30_000;

/** The argument that marks this worktree's dev server; main.js ignores it, stop checks it. */
const MARKER = `--xr-dev=${ROOT}/`;

function readRecord() {
  try { return JSON.parse(readFileSync(RECORD, 'utf8')); } catch { return null; }
}

function writeRecord(value) {
  mkdirSync(LOCAL, { recursive: true });
  writeFileSync(`${RECORD}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${RECORD}.tmp`, RECORD);
}

/** Whether the recorded PID still runs this worktree's dev server. */
const running = (record) => Boolean(record?.pid) && alive(record.pid) && commandOf(record.pid).includes(MARKER);

async function stop() {
  const record = readRecord();
  if (!record) return { stopped: false };
  let killed = false;
  if (record.pid && groupAlive(record.pid)) {
    if (alive(record.pid) && !running(record)) {
      throw new Error(`PID ${record.pid} in ${RECORD} is no longer this worktree's dev server; end it by hand`);
    }
    const signal = (name) => { try { process.kill(-record.pid, name); } catch { /* group gone */ } };
    signal('SIGTERM');
    try {
      await waitFor(() => !groupAlive(record.pid), 'dev server exits', { timeout: EXIT_TIMEOUT_MS });
    } catch {
      signal('SIGKILL');
      killed = true;
    }
  }
  if (Number.isInteger(record.slot)) DEV_POOL.release(record.slot, ROOT);
  writeRecord({ ...record, pid: null, url: null, stoppedAt: new Date().toISOString() });
  return { stopped: true, killed };
}

async function start({ vault, build }) {
  if (process.platform !== 'darwin') throw new Error('dev.mjs runs on macOS');
  const last = readRecord();
  await stop();
  if (build) execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 2, 2] });

  const ports = await DEV_POOL.claim(ROOT, { prefer: last?.slot });
  mkdirSync(LOCAL, { recursive: true });
  const log = openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'node', 'transport', 'server', 'main.js'), MARKER], {
    cwd: ROOT, detached: true, stdio: ['ignore', log, log],
    env: {
      ...cleanEnv(),
      XR_COLLECTOR_PORT: String(ports.ui),
      XR_COLLECTOR_MEILISEARCH_PORT: String(ports.search),
      XR_COLLECTOR_AGENT_PORT: String(ports.agent),
      XR_COLLECTOR_VAULT: vault,
    },
  });
  child.once('error', () => undefined);
  child.unref();
  closeSync(log);
  DEV_POOL.hold(ports.slot, ROOT, child.pid);

  const url = `http://127.0.0.1:${ports.ui}`;
  const record = { url, ports, slot: ports.slot, pid: child.pid, vault, log: LOG, startedAt: new Date().toISOString() };
  writeRecord(record);
  const exited = new Error(`dev server exited; see ${LOG}`);
  try {
    await waitFor(async () => {
      if (!alive(child.pid)) throw exited;
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { return false; }
    }, 'dev server answers /api/health', { timeout: READY_TIMEOUT_MS, fatal: (error) => error === exited });
  } catch (error) {
    await stop();
    throw error;
  }
  return record;
}

async function main() {
  const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
    vault: { type: 'string' }, 'no-build': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  if (o.help || !command) return console.log(USAGE);
  if (command === 'start') return print(await start({ vault: path.resolve(o.vault ?? DEFAULT_VAULT), build: !o['no-build'] }));
  if (command === 'stop') return print(await stop());
  if (command === 'status') {
    const record = readRecord();
    return print({ ...record, running: running(record), portFree: record?.ports ? await portFree(record.ports.ui) : null });
  }
  throw new Error(`Unknown command ${command}\n${USAGE}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
