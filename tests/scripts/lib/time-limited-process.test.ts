// Guards the developer, not the user: broken, a stuck npm run verify step runs until someone notices,
// and its processes keep slowing the machine down afterwards.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runWithinLimit, StoppedRun } from '../../../scripts/lib/time-limited-process.mjs';
import { itOnPosix } from '../../support/platform.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

async function stepThatStartsSleepThen(then: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-time-limited-'));
  roots.push(root);
  const pids = path.join(root, 'pids.json');
  const script = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' });
    grandchild.unref();
    require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, grandchild.pid]));
    ${then}
  `;
  return { args: ['-e', script], pids: async () => JSON.parse(await readFile(pids, 'utf8')) as number[] };
}

itOnPosix('ends a step stuck in a synchronous loop at its limit, naming the step and the processes it ended', async () => {
  const step = await stepThatStartsSleepThen('for (;;) {}');

  const stopped = await runWithinLimit('spin', process.execPath, step.args, { limit: 3_000 }).then(() => null, (error: unknown) => error);

  const pids = await step.pids();
  expect(stopped).toBeInstanceOf(StoppedRun);
  expect(stopped).toMatchObject({ exitCode: 1, message: expect.stringMatching(/^spin ran past its limit of 3000 ms/u) });
  for (const pid of pids) {
    expect((stopped as StoppedRun).message).toContain(`\n  ${pid} `);
    expect(gone(pid)).toBe(true);
  }
});

itOnPosix('ends what a step leaves running in its group, warns naming it, and keeps the step\'s own exit code', async () => {
  const step = await stepThatStartsSleepThen('process.exitCode = 4;');
  const warnings: string[] = [];
  const error = console.error;
  console.error = (line: string) => { warnings.push(line); };
  let code: number;
  try {
    code = await runWithinLimit('leaver', process.execPath, step.args, { limit: 30_000 });
  } finally {
    console.error = error;
  }

  const [, grandchild] = await step.pids();
  expect(code).toBe(4);
  expect(warnings).toEqual([expect.stringContaining(`leaver exited with processes of its group still running; ended them:\n  ${grandchild} `)]);
  expect(gone(grandchild!)).toBe(true);
});

it.each([0, 3])('resolves with the exit code %i of a step that finishes on its own', async (code) => {
  await expect(runWithinLimit('exit', process.execPath, ['-e', `process.exit(${code})`], { limit: 30_000 })).resolves.toBe(code);
});
