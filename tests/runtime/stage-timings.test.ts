import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  appendBuilderTimingEvents, createStageTimer, formatTimingTable, noStageTimer, orderedStages, recordBuilderTimings, runWithTimingReport, timerEvents,
} from '../../scripts/stage-timings.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function manualClock(start = 1_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

it('records nested, counted and failed stages in start order with their wall time', async () => {
  const clock = manualClock();
  const timer = createStageTimer({ now: clock.now });
  await timer.time('build', async () => { clock.advance(1_200); });
  await timer.group('notarize: App', async (child: any) => {
    clock.advance(5);
    await child.time('notarytool submit', async (stage: any) => { stage.bytes = 4096; clock.advance(30_000); });
    await child.time('notarytool wait', async () => { clock.advance(90_000); });
  });
  await timer.time('codesign runtime files', async () => { clock.advance(800); }, { count: 110 });
  await expect(timer.time('verify: ZIP contents', async () => { clock.advance(50); throw new Error('bad seal'); })).rejects.toThrow('bad seal');

  expect(orderedStages(timer)).toEqual([
    { name: 'build', ms: 1_200, status: 'ok', depth: 0, offsetMs: 0 },
    { name: 'notarize: App', ms: 120_005, status: 'ok', depth: 0, offsetMs: 1_200 },
    { name: 'notarize: App / notarytool submit', ms: 30_000, status: 'ok', depth: 1, offsetMs: 1_205, bytes: 4096 },
    { name: 'notarize: App / notarytool wait', ms: 90_000, status: 'ok', depth: 1, offsetMs: 31_205 },
    { name: 'codesign runtime files', ms: 800, status: 'ok', depth: 0, offsetMs: 121_205, count: 110 },
    { name: 'verify: ZIP contents', ms: 50, status: 'failed', depth: 0, offsetMs: 122_005 },
  ]);
  await expect(noStageTimer.group('ignored', async (child: any) => child.time('ignored', async () => 7))).resolves.toBe(7);
  expect(noStageTimer.stages).toEqual([]);
});

it('formats an aligned table with indentation, counts, bytes and the wall total', () => {
  const table = formatTimingTable([
    { name: 'notarize: App', ms: 120_005, status: 'ok', depth: 0, offsetMs: 0 },
    { name: 'notarize: App / notarytool submit', ms: 300, status: 'ok', depth: 1, offsetMs: 0, bytes: 3 * 1024 * 1024 },
    { name: 'codesign runtime files', ms: 800, status: 'failed', depth: 0, offsetMs: 0, count: 110 },
  ], { totalMs: 121_000, title: 'Stage timings: package failed' });
  const lines = table.split('\n');
  expect(lines[0]).toMatch(/^Stage timings: package failed/u);
  expect(lines[1]).toMatch(/^Stage\s+Time\s+Count\s+Bytes\s+Status$/u);
  expect(lines[3]).toMatch(/^notarize: App\s+120\.0s\s+ok$/u);
  expect(lines[4]).toMatch(/^ {2}notarize: App \/ notarytool submit\s+300ms\s+3\.0MiB\s+ok$/u);
  expect(lines[5]).toMatch(/^codesign runtime files\s+800ms\s+110\s+failed$/u);
  expect(lines[6]).toMatch(/^Total \(wall\)\s+121\.0s$/u);
});

it('writes the JSON report and prints the table when the work succeeds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-stage-timings-'));
  roots.push(root);
  const clock = manualClock(Date.parse('2026-10-29T00:00:00.000Z'));
  const timer = createStageTimer({ now: clock.now });
  const output: string[] = [];
  const file = path.join(root, 'nested', 'report.json');
  const result = await runWithTimingReport(timer, () => ({ file, command: 'package', version: '0.1.0', commit: 'a'.repeat(40), target: 'darwin-arm64', variant: 'chinese',
    artifacts: [{ path: 'XR-Collector-0.1.0-chinese-mac-arm64.zip', bytes: 3, sha256: 'b'.repeat(64) }] }), async () => {
    await timer.time('build', async () => { clock.advance(2_000); });
    return 'handoff';
  }, { log: (text: string) => output.push(text) });

  expect(result).toBe('handoff');
  const report = JSON.parse(await readFile(file, 'utf8'));
  expect(report).toEqual({
    schemaVersion: 1, kind: 'xr-collector-stage-timings', command: 'package', version: '0.1.0', commit: 'a'.repeat(40),
    target: 'darwin-arm64', variant: 'chinese', artifacts: [{ path: 'XR-Collector-0.1.0-chinese-mac-arm64.zip', bytes: 3, sha256: 'b'.repeat(64) }],
    status: 'passed', startedAt: '2026-10-29T00:00:00.000Z', totalMs: 2_000,
    stages: [{ name: 'build', ms: 2_000, status: 'ok', depth: 0, offsetMs: 0 }],
  });
  expect(output[0]).toMatch(/Stage timings: package passed/u);
  expect(output[0]).toMatch(/build\s+2\.0s\s+ok/u);
  expect(output[1]).toBe(`Stage timing report: ${file}`);
});

it('writes the table and JSON up to the failing stage and rethrows the original error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-stage-timings-'));
  roots.push(root);
  const clock = manualClock();
  const timer = createStageTimer({ now: clock.now });
  const output: string[] = [];
  const failure = new Error('notarytool wait timed out');
  const identity: Record<string, string> = { command: 'package' };
  let later = false;
  await expect(runWithTimingReport(timer, () => ({ file: path.join(root, 'report.json'), ...identity }), async () => {
    await timer.time('build', async () => { clock.advance(10); });
    identity.version = '0.1.0';
    await timer.group('notarize: App', async (child: any) => {
      await child.time('notarytool submit', async () => { clock.advance(20); });
      await child.time('notarytool wait', async () => { clock.advance(30); throw failure; });
    });
    later = true;
  }, { log: (text: string) => output.push(text) })).rejects.toBe(failure);

  expect(later).toBe(false);
  const report = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
  expect(report).toMatchObject({ status: 'failed', error: 'notarytool wait timed out', version: '0.1.0', totalMs: 60 });
  expect(report.stages.map((stage: any) => [stage.name, stage.status])).toEqual([
    ['build', 'ok'], ['notarize: App', 'failed'], ['notarize: App / notarytool submit', 'ok'], ['notarize: App / notarytool wait', 'failed'],
  ]);
  expect(output[0]).toMatch(/Stage timings: package failed/u);
  expect(output[0]).toMatch(/notarytool wait\s+30ms\s+failed/u);
});

it('keeps the original failure when the report cannot be written', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-stage-timings-'));
  roots.push(root);
  const blocker = path.join(root, 'not-a-directory');
  await writeFile(blocker, '');
  const output: string[] = [];
  const failure = new Error('build failed');
  await expect(runWithTimingReport(createStageTimer(), () => ({ file: path.join(blocker, 'report.json'), command: 'package' }),
    async () => { throw failure; }, { log: (text: string) => output.push(text) })).rejects.toBe(failure);
  expect(output.at(-1)).toMatch(/^Unable to write the stage timing report/u);
});

it('turns electron-builder hook events into pack, afterPack, App codesign and artifact stages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-builder-events-'));
  roots.push(root);
  const file = path.join(root, 'events.jsonl');
  const clock = manualClock(10_000);
  const hookTimer = createStageTimer({ now: clock.now });
  await hookTimer.time('codesign --timestamp runtime Mach-O files', async () => { clock.advance(200_000); }, { count: 110 });
  await appendBuilderTimingEvents([{ event: 'mark', name: 'beforePack', at: 1_000 }, { event: 'mark', name: 'afterPack:start', at: 10_000 }], file);
  await appendBuilderTimingEvents([...timerEvents(hookTimer), { event: 'mark', name: 'afterPack:end', at: 210_000 }], file);
  await appendBuilderTimingEvents([
    { event: 'mark', name: 'afterSign', at: 250_000 },
    { event: 'artifact:start', file: '/out/a.zip', at: 250_100 },
    { event: 'artifact:start', file: '/out/a.dmg', at: 250_200 },
    { event: 'artifact:end', file: '/out/a.zip', at: 264_100, bytes: 2048 },
    { event: 'artifact:end', file: '/out/a.dmg', at: 280_200 },
  ], file);
  await appendBuilderTimingEvents([{ event: 'mark', name: 'ignored', at: 0 }], undefined);

  const builderClock = manualClock(0);
  const timer = createStageTimer({ now: builderClock.now });
  await timer.group('electron-builder --mac', async (child: any) => { builderClock.advance(300_000); await recordBuilderTimings(child, file); });
  await recordBuilderTimings(timer, path.join(root, 'missing.jsonl'));

  expect(orderedStages(timer).map(({ name, ms, depth, count, bytes }) => ({ name, ms, depth, count, bytes }))).toEqual([
    { name: 'electron-builder --mac', ms: 300_000, depth: 0, count: undefined, bytes: undefined },
    { name: 'electron-builder --mac / pack App (beforePack to afterPack)', ms: 9_000, depth: 1, count: undefined, bytes: undefined },
    { name: 'electron-builder --mac / afterPack hook', ms: 200_000, depth: 1, count: undefined, bytes: undefined },
    { name: 'electron-builder --mac / afterPack hook / codesign --timestamp runtime Mach-O files', ms: 200_000, depth: 2, count: 110, bytes: undefined },
    { name: 'electron-builder --mac / electron-builder App codesign (afterPack to afterSign)', ms: 40_000, depth: 1, count: undefined, bytes: undefined },
    { name: 'electron-builder --mac / artifact a.zip', ms: 14_000, depth: 1, count: undefined, bytes: 2048 },
    { name: 'electron-builder --mac / artifact a.dmg', ms: 30_000, depth: 1, count: undefined, bytes: undefined },
  ]);
});
