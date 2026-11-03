// Guards the developer, not the user.
// The verify slots: ten groups of four ports inside the registry's 7250–7289, never overlapping. A
// launch takes a slot whose lock names a PID that no longer runs and passes over a slot whose holder
// still runs, whatever the language or time zone of the shell that wrote the lock.
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cleanUp, deadPid, isolateHome, temp } from './support.js';

const home = isolateHome();
const { SLOT_LOCKS, SLOTS } = await import('../scripts/lib/paths.mjs');
const { releaseSlot, tryLock } = await import('../scripts/lib/instance.mjs');

afterEach(() => {
  rmSync(SLOT_LOCKS, { recursive: true, force: true });
  cleanUp();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('verify slots', () => {
  it('stay inside 7250–7289 without sharing a port', () => {
    const ports = SLOTS.flatMap((slot: Record<string, number>) => [slot.ui, slot.search, slot.agent, slot.feeds]);
    expect(new Set(ports).size).toBe(ports.length);
    expect(Math.min(...ports)).toBe(7250);
    expect(Math.max(...ports)).toBe(7289);
  });

  it('take over a lock whose PID no longer runs and pass over one whose holder runs', async () => {
    mkdirSync(SLOT_LOCKS, { recursive: true });
    const lock = (slot: number) => path.join(SLOT_LOCKS, `${slot}.json`);
    // Slot 0's holder is this test's own process; slot 1's has exited.
    writeFileSync(lock(0), JSON.stringify({ pid: process.pid, runDir: '/elsewhere/live' }));
    writeFileSync(lock(1), JSON.stringify({ pid: await deadPid(), runDir: '/elsewhere/gone' }));
    const runDir = temp('run');

    expect(tryLock(0, runDir)).toBe(false);
    expect(tryLock(1, runDir)).toBe(true);
    expect(tryLock(1, '/elsewhere/second')).toBe(false);
    expect(JSON.parse(readFileSync(lock(1), 'utf8'))).toEqual({ pid: process.pid, runDir });
    expect(JSON.parse(readFileSync(lock(0), 'utf8')).runDir).toBe('/elsewhere/live');
    releaseSlot(1, runDir);
    releaseSlot(0, runDir);
    expect(() => readFileSync(lock(1))).toThrow();
    expect(JSON.parse(readFileSync(lock(0), 'utf8')).runDir).toBe('/elsewhere/live');
  });
});
