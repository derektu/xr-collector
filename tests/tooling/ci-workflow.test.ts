import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowPath = path.resolve(import.meta.dirname, '../..', '.github/workflows/ci.yml');
const workflow = parse(await readFile(workflowPath, 'utf8'));

describe('CI UI regression contract', () => {
  it('runs Web regression on a standard Mac runner and dynamically selects Web flows', () => {
    const job = workflow.jobs['web-regression'];
    expect(job['runs-on']).toBe('macos-15');
    expect(job.steps.some((step: { run?: string }) => step.run?.includes('flows run --web'))).toBe(true);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
  });

  it('keeps packaged smoke manual and covers only the two delivery targets', () => {
    const job = workflow.jobs['packaged-smoke'];
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain('inputs.packaged_smoke');
    expect(job.strategy.matrix.include.map((entry: { target: string }) => entry.target).sort())
      .toEqual(['darwin-arm64', 'win32-x64']);
  });

  it('lets manually dispatched clean-main repeats finish independently', () => {
    expect(workflow.concurrency.group).toContain('github.run_id');
    const select = workflow.jobs['web-regression'].steps.find((step: { name?: string }) => step.name === 'Select tested source');
    expect(select.env.REQUESTED_REF).toContain('inputs.tested_ref');
    expect(select.run).toContain('$REQUESTED_REF');
    expect(select.run).not.toContain('${{ inputs.tested_ref }}');
    const validate = workflow.jobs['web-regression'].steps.find((step: { name?: string }) => step.name === 'Validate separately tested commit');
    expect(validate.run).toContain('^[0-9a-f]{40}$');
    const run = workflow.jobs['web-regression'].steps.find((step: { name?: string }) => step.name === 'Run every registered Web flow');
    expect(run.run.match(/rev-parse HEAD/gu)).toHaveLength(2);
  });

  it('uploads only bounded failure evidence for seven days', () => {
    for (const name of ['web-regression', 'packaged-smoke']) {
      const upload = workflow.jobs[name].steps.find((step: { name?: string }) => step.name?.startsWith('Save failed'));
      expect(upload.if).toBe('failure()');
      expect(upload.with['retention-days']).toBe(7);
      expect(upload.with.path).toContain('results.json');
      expect(upload.with.path).toContain('server.log');
      expect(upload.with.path).not.toMatch(/release\/|profile|vault/iu);
    }
  });
});
