// Guards the developer, not the user.
// What makes a recorded flow pass: the recorder passes a scenario only with at least one check, all
// of them ok, and a run only when no driver or cleanup error and no uncaught page exception was reported; a flow that cannot start
// still writes a failed results.json. Flows run side by side up to the job limit, a Desktop flow
// alone, and one failing flow never stops the others.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recorder } from '../scripts/lib/drive.mjs';
import { runPool, startable, writeProvisioningFailure } from '../scripts/lib/flows.mjs';

let evidence: string;
afterEach(async () => { if (evidence) await rm(evidence, { recursive: true, force: true }); });
const results = async () => JSON.parse(await readFile(path.join(evidence, 'results.json'), 'utf8'));

describe('recorder', () => {
  it('fails a scenario that recorded no check, and the run with it', async () => {
    evidence = await mkdtemp(path.join(os.tmpdir(), 'xr-recorder-empty-'));
    const record = recorder({ issue: '233', evidence, checkout: '/test', data: 'synthetic' }, {});
    expect(await record.scenario('EMPTY-1', 'no checks', async () => undefined)).toBe(false);
    expect(await record.finish()).toBe(false);
    expect(await results()).toMatchObject({ passed: false, results: [{ id: 'EMPTY-1', pass: false, checks: [] }] });
  });

  it('fails a run with no scenario, and a run whose driver or cleanup reports an error after passing scenarios', async () => {
    evidence = await mkdtemp(path.join(os.tmpdir(), 'xr-recorder-cleanup-'));
    expect(await recorder({ issue: '233', evidence, checkout: '/test', data: 'synthetic' }, {}).finish()).toBe(false);
    const record = recorder({ issue: '233', evidence, checkout: '/test', data: 'synthetic' }, {});
    await record.scenario('CLEANUP-1', 'cleanup failure', async ({ expect: check }) => check(true, 'scenario passed', { id: 'x.y', expected: true, actual: true }));
    expect(await record.finish({ error: 'app did not exit' })).toBe(false);
    expect(await results()).toMatchObject({ passed: false, error: 'app did not exit',
      results: [{ id: 'CLEANUP-1', pass: true, checks: [{ id: 'x.y', ok: true, text: 'scenario passed', expected: true, actual: true }] }] });
  });

  it('fails a run whose cleanup failed or whose page threw, though every scenario passed', async () => {
    evidence = await mkdtemp(path.join(os.tmpdir(), 'xr-recorder-after-'));
    for (const extra of [{ cleanupError: 'The app exited with Meilisearch still running' }, { pageErrors: ['TypeError: x is undefined'] }]) {
      const record = recorder({ issue: '235', evidence, checkout: '/test', data: 'synthetic' }, {});
      await record.scenario('AFTER-1', 'scenario passed', async ({ expect: check }) => check(true, 'scenario passed', { id: 'x.y', expected: true, actual: true }));
      expect(await record.finish(extra)).toBe(false);
      expect(await results()).toMatchObject({ passed: false, ...extra, results: [{ id: 'AFTER-1', pass: true }] });
    }
  });

  it('keeps a failed result when provisioning stops before the recorder exists', async () => {
    evidence = await mkdtemp(path.join(os.tmpdir(), 'xr-flow-provisioning-'));
    await writeProvisioningFailure({ issue: '119', label: 'ci-web', evidence, checkout: path.resolve(import.meta.dirname, '../../../..'),
      flow: 'web-a', error: new Error('browser did not start') });
    const result = await results();
    expect(result).toMatchObject({ issue: '119', label: 'ci-web', flow: 'web-a', passed: false, phase: 'provisioning', results: [] });
    expect(result.error).toContain('browser did not start');
  });
});

describe('parallel flow runs', () => {
  type Flow = { name: string; desktop: boolean };
  const web = (name: string): Flow => ({ name, desktop: false });
  const native = (name: string): Flow => ({ name, desktop: true });
  const names = (flows: Flow[]) => flows.map((flow) => flow.name);

  it('runs a Desktop flow alone and keeps the flows after it waiting', () => {
    expect(names(startable([web('a'), web('b'), web('c'), web('d')], [], 3))).toEqual(['a', 'b', 'c']);
    expect(names(startable([native('n'), web('b')], [web('a')], 3))).toEqual([]);
    expect(names(startable([native('n'), web('b')], [], 3))).toEqual(['n']);
    expect(names(startable([web('b')], [native('n')], 3))).toEqual([]);
  });

  it('never runs more than the job limit and finishes every flow when one fails or throws', async () => {
    const flows = ['a', 'b', 'c', 'd', 'e'].map(web);
    let running = 0;
    let peak = 0;
    const outcomes = await runPool(flows, 3, async (flow: Flow) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, flow.name === 'b' ? 30 : 5));
      running -= 1;
      if (flow.name === 'c') throw new Error('driver crashed');
      return { name: flow.name, passed: flow.name !== 'a' };
    });
    expect(peak).toBe(3);
    expect(outcomes).toEqual([
      { name: 'a', passed: false }, { name: 'b', passed: true }, { name: 'c', passed: false, error: 'driver crashed' },
      { name: 'd', passed: true }, { name: 'e', passed: true },
    ]);
  });
});
