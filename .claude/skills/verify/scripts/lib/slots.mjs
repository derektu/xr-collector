// Port slots shared by every checkout on the machine. A pool is a fixed list of slots, each a group
// of ports reserved in the port registry, and a lock folder under ~/.xr-collector. A slot's lock file
// names the PID that keeps the slot and the owner (a verify run folder, or a worktree for a dev
// instance). It is created whole and exclusively by a hard link, so two claims never both take it; a
// lock whose PID no longer runs is stale and taken over. Every tool that opens sessions on these
// worktrees shares the same locks, so no session owns a fixed port.
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { alive } from './platform.mjs';
import { sleep } from './wait.mjs';

/** Whether nothing listens on `port` at 127.0.0.1. */
export function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** The lock in `file`; null when there is none, {} when it cannot be read. */
function readLock(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return error.code === 'ENOENT' ? null : {};
  }
}

/**
 * A pool of `slots` ({ slot, ...ports }) locked in `dir`. `claim` waits up to `waitMs` while every
 * slot is busy; `busyHint` ends the error it throws after that.
 */
export function slotPool({ name, dir, slots, waitMs, busyHint }) {
  const lockPath = (slot) => path.join(dir, `${slot}.json`);
  const portsOf = (slot) => Object.entries(slot).filter(([key]) => key !== 'slot').map(([, port]) => port);

  /** Takes the slot's lock for `owner` unless a running process holds it. */
  function tryLock(slot, owner) {
    mkdirSync(dir, { recursive: true });
    const temporary = `${lockPath(slot)}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, owner }));
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          linkSync(temporary, lockPath(slot));
          return true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const holder = readLock(lockPath(slot));
          if (holder && alive(holder.pid)) return false;
          // The dead holder's lock moves aside before the slot is taken. When another claim took the
          // slot between the read and the move, the moved lock is that claim's and goes back.
          const aside = `${lockPath(slot)}.${randomUUID()}.stale`;
          try {
            renameSync(lockPath(slot), aside);
          } catch (moveError) {
            if (moveError.code === 'ENOENT') continue;
            throw moveError;
          }
          const moved = readLock(aside);
          if (moved?.pid !== holder?.pid || moved?.owner !== holder?.owner) {
            try { linkSync(aside, lockPath(slot)); } catch { /* a third claim holds the slot now */ }
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

  /** Records `pid` as the holder of the slot `owner` holds. */
  function hold(slot, owner, pid) {
    const temporary = `${lockPath(slot)}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid, owner }), { flag: 'wx' });
    renameSync(temporary, lockPath(slot));
  }

  /** The slot's lock ({ pid, owner }); null when nobody holds it, {} when it cannot be read. */
  const holder = (slot) => readLock(lockPath(slot));

  /** Releases the slot if its lock names `owner`. */
  function release(slot, owner) {
    if (readLock(lockPath(slot))?.owner === owner) rmSync(lockPath(slot), { force: true });
  }

  /**
   * Takes a slot whose lock is free and whose ports are all free, held by this process for `owner`;
   * `prefer` is tried first, so a worktree keeps the slot, and the URL, it had last time.
   */
  async function claim(owner, { prefer } = {}) {
    const order = [...slots].sort((a, b) => (b.slot === prefer) - (a.slot === prefer));
    const deadline = Date.now() + waitMs;
    for (;;) {
      for (const ports of order) {
        if (!tryLock(ports.slot, owner)) continue;
        if ((await Promise.all(portsOf(ports).map(portFree))).every(Boolean)) return ports;
        release(ports.slot, owner);
      }
      if (Date.now() >= deadline) {
        throw new Error(`All ${slots.length} ${name} slots are busy. Each lock in ${dir} names its PID and owner; ${busyHint}`);
      }
      await sleep(1_000);
    }
  }

  return { name, dir, slots, tryLock, hold, holder, release, claim };
}

const LOCKS = path.join(os.homedir(), '.xr-collector');

/**
 * Verify runs: ports 7250–7289 in the port registry (xr-collector — verify slot N), four per slot:
 * UI/API, Meilisearch, Agent API, synthetic feeds. Ten slots let two or three tickets each run flows
 * with --jobs 3 and still leave one for a manual launch. A launch waits up to ten minutes for a slot.
 */
export const VERIFY_POOL = slotPool({
  name: 'verify',
  dir: path.join(LOCKS, 'verify-slots'),
  slots: Array.from({ length: 10 }, (_, slot) => 7250 + slot * 4).map((base, slot) => ({
    slot, ui: base, search: base + 1, agent: base + 2, feeds: base + 3,
  })),
  waitMs: 10 * 60_000,
  busyHint: 'end a leftover run with verify.mjs stop --run <runDir>',
});

/**
 * Dev instances that a person opens to try a ticket (scripts/dev.mjs): six slots of three ports in
 * the port registry (xr-collector — dev slot N): UI/API, Meilisearch, Agent API. A start never
 * waits: a busy pool means some worktree left an instance running.
 */
export const DEV_POOL = slotPool({
  name: 'dev',
  dir: path.join(LOCKS, 'dev-slots'),
  slots: [7311, 7314, 7317, 7330, 7333, 7336].map((base, slot) => ({ slot, ui: base, search: base + 1, agent: base + 2 })),
  waitMs: 0,
  busyHint: 'stop an instance a worktree no longer needs with node scripts/dev.mjs stop in that worktree',
});
