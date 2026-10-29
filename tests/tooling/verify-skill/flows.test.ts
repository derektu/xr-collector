// Recorded regression flows: the status sequences they judge, the checks they write to
// results.json, and the feature map naming, for each feature, the flows that cover it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEntry, failureHint, recorder } from '../../../.claude/skills/verify/scripts/lib/drive.mjs';
import { FEATURES_DIR, findFeature, parseFeature, readFeatures } from '../../../.claude/skills/verify/scripts/lib/features.mjs';
import { listFlows, runPool, selectFlows, startable, TIERS, timingTable, writeProvisioningFailure } from '../../../.claude/skills/verify/scripts/lib/flows.mjs';
import { failureCause, flowHistory, historyTable, readFlowResults } from '../../../.claude/skills/verify/scripts/lib/history.mjs';
import { checkRecordForJob } from '../../../.claude/skills/verify/flows/subscription-failures.mjs';
import { distinct, jobSectionChecks, subscriptionPhase, subscriptionSequenceChecks } from '../../../.claude/skills/verify/flows/lib/status-sequence.mjs';

type Check = { id: string; ok: boolean; actual: unknown };
const failed = (checks: Check[]) => checks.filter((check) => !check.ok).map((check) => check.id);
const sequence = (...values: string[]) => subscriptionSequenceChecks('A', values, { total: 5 }) as Check[];

describe('CI flow selection', () => {
  const flows = [
    { name: 'web-a', tier: 'core', desktop: false, covers: ['sub-add'] },
    { name: 'native-a', tier: 'platform', desktop: true, covers: ['tray-menu'] },
    { name: 'web-b', tier: 'feature', desktop: false, covers: ['docs-list', 'sub-status'] },
    { name: 'real-a', tier: 'real', desktop: false, covers: ['collect-add'] },
  ] as Awaited<ReturnType<typeof listFlows>>;
  const names = (selected: typeof flows) => selected.map((flow) => flow.name);
  const feature = (subFeatures: string[]) => ({ file: 'x.md', name: 'x', subFeatures, listed: {}, hasBacklog: true, backlog: [] });

  it('discovers every Web flow without maintaining a second fixed list, leaving real-source flows out', () => {
    expect(names(selectFlows(flows, { layer: 'web' }))).toEqual(['web-a', 'web-b']);
    expect(names(selectFlows(flows, { layer: 'desktop' }))).toEqual(['native-a']);
    expect(names(selectFlows(flows, {}))).toEqual(['web-a', 'native-a', 'web-b', 'real-a']);
  });

  it('keeps explicit names strict and combines them with the requested layer', () => {
    expect(names(selectFlows(flows, { names: ['web-b'], layer: 'web' }))).toEqual(['web-b']);
    expect(() => selectFlows(flows, { names: ['missing'], layer: 'web' })).toThrow(/Unknown flow missing/u);
  });

  it('selects by tier and by the sub-features of a feature file, alone or with the layer', () => {
    expect(names(selectFlows(flows, { tier: 'core' }))).toEqual(['web-a']);
    expect(names(selectFlows(flows, { tier: 'real' }))).toEqual(['real-a']);
    expect(names(selectFlows(flows, { feature: feature(['sub-add', 'sub-status']) }))).toEqual(['web-a', 'web-b']);
    expect(names(selectFlows(flows, { feature: feature(['sub-status']), tier: 'core' }))).toEqual([]);
    expect(names(selectFlows(flows, { feature: feature(['collect-add', 'tray-menu']), layer: 'web' }))).toEqual([]);
    expect(() => selectFlows(flows, { tier: 'smoke' })).toThrow(/Unknown tier smoke; known: core, feature, platform, real/u);
  });

  it('finds a feature file with or without .md and names the known ones otherwise', () => {
    const features = readFeatures();
    expect(findFeature(features, 'subscriptions').subFeatures).toContain('sub-remove');
    expect(findFeature(features, 'subscriptions.md').name).toBe('subscriptions');
    expect(() => findFeature(features, 'missing')).toThrow(/Unknown feature missing; known: .*subscriptions/u);
  });

  it('refuses a flow without a known tier, a Desktop flow outside platform and an empty overBudget', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'xr-flow-tier-'));
    const flow = (extra: string) => `export const name = 'x'; export const title = 'x'; export const covers = []; export async function run() {}\n${extra}\n`;
    try {
      for (const [extra, error] of [
        ['', /must export tier, one of core, feature, platform, real; got undefined/u],
        ["export const tier = 'smoke';", /got smoke/u],
        ["export const tier = 'core'; export const desktop = true;", /Desktop flow, so its tier is platform/u],
        ["export const tier = 'feature'; export const overBudget = ' ';", /overBudget must say why/u],
      ] as const) {
        const file = path.join(dir, `flow-${Math.random().toString(36).slice(2)}.mjs`);
        await writeFile(file, flow(extra));
        await expect(listFlows(dir)).rejects.toThrow(error);
        await rm(file);
      }
      await writeFile(path.join(dir, 'ok.mjs'), flow("export const tier = 'feature'; export const overBudget = '理由';"));
      expect(await listFlows(dir)).toMatchObject([{ name: 'x', tier: 'feature', overBudget: '理由', desktop: false }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives every recorded flow a tier, and every Desktop flow the platform tier', async () => {
    for (const flow of await listFlows()) {
      expect(TIERS, flow.name).toContain(flow.tier);
      if (flow.desktop) expect(flow.tier, flow.name).toBe('platform');
    }
    expect((await listFlows()).filter((flow) => flow.tier === 'core').map((flow) => flow.name).sort()).toEqual(['core-journey', 'subscription-remove']);
  });

  it('keeps a machine-readable failed result when provisioning stops before the recorder', async () => {
    const evidence = await mkdtemp(path.join(os.tmpdir(), 'xr-flow-provisioning-'));
    try {
      await writeProvisioningFailure({ issue: '119', label: 'ci-web', evidence, checkout: path.resolve(import.meta.dirname, '../../..'),
        flow: 'web-a', source: { commit: 'a'.repeat(40) }, error: new Error('browser did not start') });
      const result = JSON.parse(await readFile(path.join(evidence, 'results.json'), 'utf8'));
      expect(result).toMatchObject({ issue: '119', label: 'ci-web', flow: 'web-a', passed: false, phase: 'provisioning' });
      expect(result.error).toContain('browser did not start');
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin')('packaged smoke keeps an existing explicit evidence directory untouched', async () => {
    const evidence = await mkdtemp(path.join(os.tmpdir(), 'xr-smoke-owned-evidence-'));
    const sentinel = '{"owner":"previous run"}\n';
    const script = path.resolve(import.meta.dirname, '../../../.claude/skills/verify/scripts/smoke-packaged-offline.mjs');
    try {
      await writeFile(path.join(evidence, 'results.json'), sentinel);
      const result = spawnSync(process.execPath, [script, '--app', path.join(evidence, 'missing.app'), '--evidence', evidence], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not empty; give a new or empty folder');
      expect(await readFile(path.join(evidence, 'results.json'), 'utf8')).toBe(sentinel);
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });
});

describe('parallel flow runs', () => {
  type Flow = { name: string; desktop: boolean };
  const web = (name: string): Flow => ({ name, desktop: false });
  const native = (name: string): Flow => ({ name, desktop: true });
  const names = (flows: Flow[]) => flows.map((flow) => flow.name);

  it('starts Web flows in order up to the job limit', () => {
    const waiting = [web('a'), web('b'), web('c'), web('d')];
    expect(names(startable(waiting, [], 3))).toEqual(['a', 'b', 'c']);
    expect(names(startable(waiting.slice(2), [web('a'), web('b')], 3))).toEqual(['c']);
    expect(names(startable(waiting, [], 1))).toEqual(['a']);
  });

  it('runs a Desktop flow alone and keeps the flows after it waiting', () => {
    expect(names(startable([native('n'), web('b')], [web('a')], 3))).toEqual([]);
    expect(names(startable([native('n'), web('b')], [], 3))).toEqual(['n']);
    expect(names(startable([web('b')], [native('n')], 3))).toEqual([]);
    expect(names(startable([web('a'), native('n'), web('b')], [], 3))).toEqual(['a']);
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

  it('prints each flow\'s tier, phases and budget mark, and the wall clock', () => {
    const table = timingTable([
      { name: 'vault-transfer', passed: true, tier: 'feature', overBudget: '理由', timings: { prepareMs: 6_100, runMs: 70_300, cleanupMs: 1_000 } },
      { name: 'offline-recover', passed: true, tier: 'feature', timings: { prepareMs: 1_000, runMs: 59_500, cleanupMs: 500 } },
      { name: 'build-info', passed: false, tier: 'feature', timings: { prepareMs: 900 } },
    ], { jobs: 3, wallMs: 80_000 });
    expect(table).toMatch(/vault-transfer +PASSED +feature +6\.1s +70\.3s +1\.0s +77\.4s +over 60s \(declared\)/u);
    expect(table).toMatch(/offline-recover +PASSED +feature +1\.0s +59\.5s +0\.5s +61\.0s +over 60s, no overBudget/u);
    expect(table).toMatch(/build-info +FAILED +feature +0\.9s +- +- +0\.9s$/mu);
    expect(table.split('\n').at(-1)).toBe('3 flows in 80.0s with --jobs 3');
    expect(timingTable([], { jobs: 3, wallMs: 300_100 })).toContain('0 flows in 300.1s with --jobs 3; over the 300s budget for every Web flow');
  });
});

describe('flow history across runs', () => {
  const run = (flow: string, totalSeconds: number, outcome: Record<string, unknown> = { passed: true }) => ({
    flow, timings: { prepareMs: 1_000, runMs: totalSeconds * 1000 - 2_000, cleanupMs: 1_000 }, ...outcome,
  });
  const failedCheck = (scenario: string, id: string) => ({ passed: false, results: [{ id: scenario, checks: [{ id, ok: false, text: 'x' }, { id: 'ok', ok: true, text: 'y' }] }] });

  it('names the cause of a failed run: its error, else its failed checks', () => {
    expect(failureCause({ passed: true })).toBeNull();
    expect(failureCause({ passed: false, error: 'Timed out after 60000 ms waiting for A scheduled\n  at x' })).toBe('error: Timed out after 60000 ms waiting for A scheduled');
    expect(failureCause(failedCheck('CORE-5', 'pause.paused'))).toBe('CORE-5: pause.paused');
    expect(failureCause({ passed: false, results: [] })).toBe('failed without a failed check');
  });

  it('counts runs, failures by cause, median and longest totals and runs over the one-flow budget', () => {
    const history = flowHistory([
      run('core-journey', 25), run('core-journey', 27), run('core-journey', 61, failedCheck('CORE-5', 'pause.paused')),
      run('core-journey', 26, failedCheck('CORE-5', 'pause.paused')), run('vault-transfer', 90, { passed: false, error: 'slot busy' }),
      { passed: true, timings: { runMs: 1 } },
    ]);
    expect(history).toEqual([
      { flow: 'core-journey', runs: 4, failures: 2, causes: { 'CORE-5: pause.paused': 2 }, medianMs: 26_500, maxMs: 61_000, overBudget: 1 },
      { flow: 'vault-transfer', runs: 1, failures: 1, causes: { 'error: slot busy': 1 }, medianMs: 90_000, maxMs: 90_000, overBudget: 1 },
    ]);
    const table = historyTable(history);
    expect(table).toMatch(/core-journey +4 +2 +26\.5s +61\.0s +1 +CORE-5: pause\.paused ×2/u);
  });

  it('reads the results.json of recorded flows under a folder and skips the others', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'xr-flow-history-'));
    try {
      await writeFile(path.join(dir, 'results.json'), JSON.stringify(run('core-journey', 20)));
      await mkdir(path.join(dir, 'run-2', 'ticket'), { recursive: true });
      await writeFile(path.join(dir, 'run-2', 'results.json'), JSON.stringify({ passed: true }));
      await writeFile(path.join(dir, 'run-2', 'ticket', 'results.json'), '{"flow": "cut sho');
      expect(readFlowResults(dir).map((result) => result.flow)).toEqual(['core-journey']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('subscription status sequence', () => {
  it('matches a collection check by job identity when event and job timestamps differ', () => {
    const recordAt = '2026-10-26T03:04:09.841Z';
    const jobFinishedAt = '2026-10-26T03:04:09.840Z';
    const record = checkRecordForJob([
      { kind: 'check', jobId: 'other-job', at: jobFinishedAt },
      { kind: 'check', jobId: 'failed-job', at: recordAt },
    ], 'failed-job');
    expect(record).toMatchObject({ jobId: 'failed-job', at: recordAt });
    expect(record?.at).not.toBe(jobFinishedAt);
  });

  it('classifies the status texts of the status model', () => {
    expect(subscriptionPhase('排隊中')).toEqual({ phase: 'queued' });
    expect(subscriptionPhase('檢查中')).toEqual({ phase: 'checking' });
    expect(subscriptionPhase('下載中 2/5')).toEqual({ phase: 'downloading', done: 2, total: 5 });
    for (const next of ['下次 18:52', '下次 明天 08:00', '下次 10-24 08:00']) expect(subscriptionPhase(next)).toEqual({ phase: 'scheduled' });
    for (const other of ['更新中 2/5', '執行中', '下載中', '下次']) expect(subscriptionPhase(other)).toEqual({ phase: 'unknown' });
  });

  it('passes the full sequence and one that skips 排隊中 and 檢查中', () => {
    expect(failed(sequence('排隊中', '檢查中', '下載中 0/5', '下載中 1/5', '下載中 4/5', '下次 18:52'))).toEqual([]);
    expect(failed(sequence('下載中 0/5', '下載中 3/5', '下次 18:52'))).toEqual([]);
  });

  it('fails a return to 排隊中 after the check started and names the segment', () => {
    const checks = sequence('排隊中', '下載中 1/5', '排隊中', '下載中 2/5', '下次 18:52');
    expect(failed(checks)).toEqual(['A.status.no-requeue', 'A.status.forward']);
    expect(checks.find((check) => check.id === 'A.status.no-requeue')?.actual).toEqual(['下載中 1/5 → 排隊中']);
  });

  it('fails a text outside the status model and lists it', () => {
    const checks = sequence('排隊中', '更新中 1/5', '下載中 2/5', '下次 18:52');
    expect(failed(checks)).toEqual(['A.status.known']);
    expect(checks[0].actual).toEqual(['更新中 1/5']);
  });

  it('fails progress that goes back, a wrong total, no 下載中 and an end other than 下次', () => {
    expect(failed(sequence('下載中 3/5', '下載中 2/5', '下次 18:52'))).toEqual(['A.status.progress']);
    expect(failed(sequence('下載中 1/4', '下次 18:52'))).toEqual(['A.status.progress']);
    expect(failed(sequence('檢查中', '下次 18:52'))).toEqual(['A.status.downloading-seen']);
    expect(failed(sequence('下載中 1/5', '下載中 4/5'))).toEqual(['A.status.final']);
  });

  it('gives every check a value, also when nothing was sampled', () => {
    for (const check of sequence()) expect(check.actual).not.toBeUndefined();
  });

  it('collapses samples into distinct consecutive values', () => {
    expect(distinct([{ value: 'a' }, { value: 'a' }, { value: 'b' }, { value: 'a' }])).toEqual(['a', 'b', 'a']);
  });
});

describe('job sections', () => {
  it('fails a job that returns to 排隊中 after 進行中', () => {
    expect(failed(jobSectionChecks('A', ['queued', 'running']) as Check[])).toEqual([]);
    const checks = jobSectionChecks('B', ['queued', 'running', 'queued', 'running']) as Check[];
    expect(failed(checks)).toEqual(['B.jobs.no-requeue']);
    expect(checks[0].actual).toEqual(['running → queued']);
  });

  it('fails a job never seen on the Jobs page', () => {
    const checks = jobSectionChecks('A', []) as Check[];
    expect(failed(checks)).toEqual(['A.jobs.no-requeue']);
    expect(checks[0].actual).toEqual([]);
  });
});

describe('recorder checks', () => {
  it('keeps the two-argument form and adds id, expected and actual when given', () => {
    expect(checkEntry(true, '文字')).toEqual({ ok: true, text: '文字' });
    expect(checkEntry(0, '文字', { id: 'x.y', expected: 5, actual: 4 })).toEqual({ id: 'x.y', ok: false, text: '文字', expected: 5, actual: 4 });
    expect(failureHint('文字', { id: 'x.y', expected: 5, actual: ['a'] })).toBe('[x.y] 文字\n      預期：5\n      實際：["a"]');
  });

  it('marks a completed scenario failed when driver or cleanup reports an error', async () => {
    const evidence = await mkdtemp(path.join(os.tmpdir(), 'xr-recorder-cleanup-'));
    try {
      const record = recorder({ issue: '119', evidence, checkout: '/test', data: 'fixture' }, {});
      await record.scenario('CI-119-06', 'cleanup failure', async ({ expect }) => expect(true, 'scenario passed'));
      expect(await record.finish({ error: 'app did not exit' })).toBe(false);
      expect(JSON.parse(await readFile(path.join(evidence, 'results.json'), 'utf8'))).toMatchObject({ passed: false, error: 'app did not exit' });
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });
});

describe('feature map and recorded flows', () => {
  const features = readFeatures();

  it('parses a feature file\'s sub-features, flows and backlog', () => {
    const feature = parseFeature('x.md', ['# X', '', '## Sub-features', '', '- `x-a`：A。', '- `x-b`：B。', '',
      '## Regression flows', '', '- `flow-1`：斷言 `x-b`、`x-a`。', '', '## Backlog', '', '- `x-b` 的空狀態：下層測不到。', ''].join('\n'));
    expect(feature).toEqual({ file: 'x.md', name: 'x', subFeatures: ['x-a', 'x-b'], listed: { 'flow-1': ['x-a', 'x-b'] },
      hasBacklog: true, backlog: ['- `x-b` 的空狀態：下層測不到。'] });
  });

  it('lists every feature file in the map\'s table with the flows its Regression flows names', () => {
    const readme = readFileSync(path.join(FEATURES_DIR, 'README.md'), 'utf8');
    const rows = Object.fromEntries(readme.split('\n').map((line) => line.match(/^\| [^|]+ \| \[([^\]]+\.md)\]\([^)]+\) \|[^|]+\| (.+) \|$/u))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1], [...match[2].matchAll(/`([^`]+)`/gu)].map((code) => code[1]).sort()]));
    expect(Object.keys(rows).sort()).toEqual(features.map((feature) => feature.file).sort());
    for (const feature of features) expect(rows[feature.file], feature.file).toEqual(Object.keys(feature.listed).sort());
  });

  it('gives every feature file a Backlog that never claims a recorded flow covers its items', async () => {
    const flows = (await listFlows()).map((flow) => flow.name);
    for (const feature of features) {
      expect(feature.hasBacklog, feature.file).toBe(true);
      for (const item of feature.backlog) {
        expect(feature.subFeatures, `${feature.file}: ${item} starts with one of its sub-feature IDs`).toContain(item.match(/^- `([^`]+)`/u)?.[1]);
        // An item names sub-feature IDs; naming a flow would read as coverage that the flow does not assert.
        expect(item.match(/`([^`]+)`/gu)?.map((code) => code.slice(1, -1)).filter((code) => flows.includes(code)) ?? [], `${feature.file}: ${item}`).toEqual([]);
      }
    }
  });

  it('lets every flow cover only sub-features the feature map defines', async () => {
    const known = features.flatMap((feature) => feature.subFeatures);
    for (const flow of await listFlows()) expect(flow.covers.filter((id: string) => !known.includes(id)), flow.name).toEqual([]);
  });

  it('lists in each feature file exactly the flows covering it, with only that file\'s sub-features each asserts', async () => {
    const flows = await listFlows();
    for (const feature of features) {
      const expected = Object.fromEntries(flows
        .map((flow) => [flow.name, flow.covers.filter((id: string) => feature.subFeatures.includes(id)).sort()] as const)
        .filter(([, ids]) => ids.length > 0));
      expect(feature.listed, feature.file).toEqual(expected);
    }
  });
});
