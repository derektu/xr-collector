// Guards the developer and the user's data: what CI uploads never includes a Vault or a profile, the
// nightly packaging builds exactly the targets that `package:*` delivers, and no `run:` script expands
// text a pull request or a dispatch can set.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[]; strategy?: { matrix?: { include?: Array<{ target?: string }> } } };

const root = path.resolve(import.meta.dirname, '../..');
const workflowDir = path.join(root, '.github/workflows');
const workflows = readdirSync(workflowDir).filter((name) => /\.ya?ml$/u.test(name)).map((name) => ({
  name,
  jobs: Object.entries((parse(readFileSync(path.join(workflowDir, name), 'utf8')) as { jobs: Record<string, Job> }).jobs),
}));
const steps = workflows.flatMap(({ name, jobs }) => jobs.flatMap(([job, { steps: list = [] }]) => list.map((step) => ({ at: `${name} ${job} ${step.name ?? step.uses ?? step.run}`, step }))));
const scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

describe('CI workflows', () => {
  it('uploads no Vault, profile or packaged App', () => {
    const uploads = steps.filter(({ step }) => step.uses?.startsWith('actions/upload-artifact@'));
    for (const { at, step } of uploads) expect(String(step.with?.path), at).not.toMatch(/vault|profile|release\//iu);
  });

  it('packages exactly the targets that package:* delivers', () => {
    const delivered = Object.entries(scripts)
      .filter(([name]) => /^package:/u.test(name))
      .map(([, command]) => /--target (\S+)/u.exec(command)?.[1])
      .sort();
    const packaged = workflows.flatMap(({ jobs }) => jobs)
      .filter(([, job]) => job.steps?.some((step) => step.run?.includes('${{ matrix.package_command }}')))
      .flatMap(([, job]) => job.strategy?.matrix?.include?.map((entry) => entry.target) ?? [])
      .sort();
    expect(packaged).toEqual(delivered);
  });

  it('passes pull request and dispatch text to run scripts only through the environment', () => {
    const untrusted = /\$\{\{[^}]*\b(github\.event\.|github\.head_ref|inputs\.)/u;
    for (const { at, step } of steps) if (step.run) expect(step.run, at).not.toMatch(untrusted);
  });
});
