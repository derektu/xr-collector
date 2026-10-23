// Another session's `sweep`, timed into a restart: waits until the server with the given PID has
// exited, sweeps the runs of XR_TEST_FROM and writes what it saw to XR_TEST_SWEEP_RESULT.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

process.on('SIGTERM', () => {});
const pid = Number(process.argv[2]);
const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
while (alive()) await new Promise((resolve) => setTimeout(resolve, 5));
const { SLOT_LOCKS } = await import(path.join(process.env.XR_TEST_LIB, 'paths.mjs'));
const { sweepStale } = await import(path.join(process.env.XR_TEST_LIB, 'instance.mjs'));
const lock = () => { try { return JSON.parse(readFileSync(path.join(SLOT_LOCKS, '0.json'), 'utf8')); } catch { return null; } };
const before = lock();
const result = sweepStale(process.env.XR_TEST_FROM);
writeFileSync(process.env.XR_TEST_SWEEP_RESULT, JSON.stringify({ lockBefore: before, result, lockAfter: lock() }));
