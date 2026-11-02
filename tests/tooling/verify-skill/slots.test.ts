// Guards the developer, not the user.
// Slot locks name their holder by PID and process start time: a reused PID or a dead holder frees
// the slot, and sweep removes such locks. The locks live under a throwaway HOME, never the machine's.
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanUp, deadPid, isolateHome, repository, temp } from './support.js';

const home = isolateHome();
const paths = await import('../../../.claude/skills/verify/scripts/lib/paths.mjs');
const { launchWeb, lockLive, slotHolders, sweepStale } = await import('../../../.claude/skills/verify/scripts/lib/instance.mjs');
const { SLOT_LOCKS, processStart } = paths;
const { processStarts } = await import('../../../.claude/skills/verify/scripts/lib/platform.mjs');

const lockFile = (slot: number) => path.join(SLOT_LOCKS, `${slot}.json`);
const writeLock = (slot: number, lock: object) => writeFileSync(lockFile(slot), JSON.stringify({ slot, runDir: `/runs/${slot}`, ...lock }));

beforeAll(() => expect(SLOT_LOCKS).toBe(path.join(home, '.xr-collector', 'verify-slots')));
beforeEach(() => mkdirSync(SLOT_LOCKS, { recursive: true }));
afterEach(() => {
  if (SLOT_LOCKS.startsWith(`${home}${path.sep}`)) rmSync(SLOT_LOCKS, { recursive: true, force: true });
  cleanUp();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('slot ports', () => {
  it('gives ten slots four ports each over the reserved range 7250–7289, without overlap', () => {
    const ports = paths.SLOTS.flatMap((slot: { ui: number; search: number; agent: number; feeds: number }) => [slot.ui, slot.search, slot.agent, slot.feeds]);
    expect(paths.SLOTS.map((slot: { slot: number }) => slot.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ports).toEqual(Array.from({ length: 40 }, (_, index) => 7250 + index));
  });
});

describe('process start times', () => {
  it('reads when this process started, and nothing for one that exited', async () => {
    const pid = await deadPid();
    // One query answers several PIDs; on Windows each query is a PowerShell start of a second or more.
    const starts = processStarts([process.pid, pid]);
    expect([...starts.keys()]).toEqual([process.pid]);
    expect(starts.get(process.pid)).toEqual(expect.any(String));
  });
});

describe('lockLive', () => {
  const startedAt = (start: string | null) => () => start;

  it('holds while the process with that PID and start time runs', () => {
    expect(lockLive({ pid: 41, start: 'Mon Nov  2 09:00:00 2026' }, startedAt('Mon Nov  2 09:00:00 2026'))).toBe(true);
  });

  it('frees a lock whose PID now belongs to a process started at another time', () => {
    expect(lockLive({ pid: 41, start: 'Mon Jan  1 00:00:00 2001' }, startedAt('Mon Nov  2 09:00:00 2026'))).toBe(false);
  });

  it('frees a lock whose holder exited or that records no start time', () => {
    expect(lockLive({ pid: 41, start: 'Mon Jan  1 00:00:00 2001' }, startedAt(null))).toBe(false);
    expect(lockLive({ pid: 41 }, startedAt('Mon Nov  2 09:00:00 2026'))).toBe(false);
    expect(lockLive(null)).toBe(false);
  });

  it('holds an unreadable lock for a minute, then frees it', () => {
    writeFileSync(lockFile(0), '{"slot":0,');
    writeFileSync(lockFile(1), '{"slot":1,');
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(lockFile(1), old, old);

    expect(slotHolders().map(({ slot, unreadable, live }: { slot: number; unreadable: boolean; live: boolean }) => ({ slot, unreadable, live }))).toEqual([
      { slot: 0, unreadable: true, live: true },
      { slot: 1, unreadable: true, live: false },
    ]);
  });
});

describe('sweep', () => {
  it('removes locks whose holder is gone or whose PID was reused, and keeps live ones', async () => {
    const { main } = repository();
    writeLock(0, { pid: process.pid, start: processStart(process.pid) });
    writeLock(1, { pid: process.pid, start: 'Mon Jan  1 00:00:00 2001' });
    writeLock(2, { pid: await deadPid(), start: 'Mon Jan  1 00:00:00 2001' });

    sweepStale(main);

    expect(slotHolders().map(({ slot, live }: { slot: number; live: boolean }) => ({ slot, live }))).toEqual([{ slot: 0, live: true }]);
  });
});

describe.runIf(process.platform === 'darwin')('launch without Meilisearch', () => {
  it('fails at once with the fix, holding no slot and no evidence folder', async () => {
    const checkout = temp('no-runtime');
    const evidence = path.join(checkout, 'evidence');
    await expect(launchWeb({ issue: 'precheck', checkout, evidence })).rejects.toThrow(/resources\/bin\/mac\/meilisearch is missing; run npm run download:runtime/u);
    expect(readdirSync(SLOT_LOCKS)).toEqual([]);
    expect(existsSync(evidence)).toBe(false);
  });
});
