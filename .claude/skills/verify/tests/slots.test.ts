// Guards the developer, not the user.
// The port slots: verify runs take ten groups of four ports inside the registry's 7250–7289, dev
// instances six groups of three of their own, and no port belongs to both. A claim takes a slot whose
// lock names a PID that no longer runs and passes over a slot whose holder still runs; a dev start
// gets back the slot its worktree had last time while it is free.
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cleanUp, deadPid, isolateHome, temp } from './support.js';

const home = isolateHome();
const { DEV_POOL, VERIFY_POOL } = await import('../scripts/lib/slots.mjs');

type Slot = Record<string, number>;
const portsOf = (pool: { slots: Slot[] }) => pool.slots.flatMap(({ slot, ...ports }) => Object.values(ports));

afterEach(() => {
  rmSync(VERIFY_POOL.dir, { recursive: true, force: true });
  rmSync(DEV_POOL.dir, { recursive: true, force: true });
  cleanUp();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('port slots', () => {
  it('give verify 7250–7289 and dev its own ports, never sharing one', () => {
    const verify = portsOf(VERIFY_POOL);
    expect(verify).toHaveLength(40);
    expect(Math.min(...verify)).toBe(7250);
    expect(Math.max(...verify)).toBe(7289);
    const all = [...verify, ...portsOf(DEV_POOL)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('take over a lock whose PID no longer runs and pass over one whose holder runs', async () => {
    mkdirSync(VERIFY_POOL.dir, { recursive: true });
    const lock = (slot: number) => path.join(VERIFY_POOL.dir, `${slot}.json`);
    // Slot 0's holder is this test's own process; slot 1's has exited.
    writeFileSync(lock(0), JSON.stringify({ pid: process.pid, owner: '/elsewhere/live' }));
    writeFileSync(lock(1), JSON.stringify({ pid: await deadPid(), owner: '/elsewhere/gone' }));
    const runDir = temp('run');

    expect(VERIFY_POOL.tryLock(0, runDir)).toBe(false);
    expect(VERIFY_POOL.tryLock(1, runDir)).toBe(true);
    expect(VERIFY_POOL.tryLock(1, '/elsewhere/second')).toBe(false);
    expect(VERIFY_POOL.holder(1)).toEqual({ pid: process.pid, owner: runDir });
    expect(VERIFY_POOL.holder(0).owner).toBe('/elsewhere/live');
    VERIFY_POOL.release(1, runDir);
    VERIFY_POOL.release(0, runDir);
    expect(() => readFileSync(lock(1))).toThrow();
    expect(VERIFY_POOL.holder(0).owner).toBe('/elsewhere/live');
  });

  it('give a dev start the slot its worktree had last time, and refuse at once when every slot is busy', async () => {
    const worktree = temp('worktree');
    const last = DEV_POOL.slots.at(-1).slot;
    const again = await DEV_POOL.claim(worktree, { prefer: last });
    expect(again.slot).toBe(last);
    DEV_POOL.release(last, worktree);

    for (const { slot } of DEV_POOL.slots) DEV_POOL.hold(slot, `/elsewhere/${slot}`, process.pid);
    const started = Date.now();
    await expect(DEV_POOL.claim(worktree)).rejects.toThrow(/a free dev slot \(all 6 are busy\)/u);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
