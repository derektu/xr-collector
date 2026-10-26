// Recorded regression flows: the status sequences they judge, the checks they write to
// results.json, and the feature map naming, for each feature, the flows that cover it.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEntry, failureHint, recorder } from '../../../.claude/skills/verify/scripts/lib/drive.mjs';
import { listFlows, selectFlows, writeProvisioningFailure } from '../../../.claude/skills/verify/scripts/lib/flows.mjs';
import { distinct, jobSectionChecks, subscriptionPhase, subscriptionSequenceChecks } from '../../../.claude/skills/verify/flows/lib/status-sequence.mjs';

const FEATURES = path.resolve(import.meta.dirname, '../../../.claude/skills/verify/features');

type Check = { id: string; ok: boolean; actual: unknown };
const failed = (checks: Check[]) => checks.filter((check) => !check.ok).map((check) => check.id);
const sequence = (...values: string[]) => subscriptionSequenceChecks('A', values, { total: 5 }) as Check[];

describe('CI flow selection', () => {
  const flows = [
    { name: 'web-a', desktop: false },
    { name: 'native-a', desktop: true },
    { name: 'web-b', desktop: false },
  ] as Awaited<ReturnType<typeof listFlows>>;

  it('discovers every Web flow without maintaining a second fixed list', () => {
    expect(selectFlows(flows, { layer: 'web' }).map((flow) => flow.name)).toEqual(['web-a', 'web-b']);
    expect(selectFlows(flows, { layer: 'desktop' }).map((flow) => flow.name)).toEqual(['native-a']);
  });

  it('keeps explicit names strict and combines them with the requested layer', () => {
    expect(selectFlows(flows, { names: ['web-b'], layer: 'web' }).map((flow) => flow.name)).toEqual(['web-b']);
    expect(() => selectFlows(flows, { names: ['missing'], layer: 'web' })).toThrow(/Unknown flow missing/u);
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

describe('subscription status sequence', () => {
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

/** The H2 section `title` of a feature file, up to the next H2. */
function section(markdown: string, title: string) {
  const start = markdown.indexOf(`\n## ${title}\n`);
  if (start < 0) return '';
  const rest = markdown.slice(start + title.length + 5);
  const end = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}
const ticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

describe('feature map and recorded flows', () => {
  const files = readdirSync(FEATURES).filter((file) => file.endsWith('.md') && file !== 'README.md');
  const features = files.map((file) => {
    const markdown = readFileSync(path.join(FEATURES, file), 'utf8');
    const subFeatures = section(markdown, 'Sub-features').split('\n').filter((line) => line.startsWith('- `')).map((line) => ticked(line)[0]);
    const listed = Object.fromEntries(section(markdown, 'Regression flows').split('\n').filter((line) => line.startsWith('- `'))
      .map((line) => { const [flow, ...ids] = ticked(line); return [flow, ids.sort()]; }));
    return { file, subFeatures, listed };
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
