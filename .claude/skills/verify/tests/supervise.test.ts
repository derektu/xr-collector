// Guards the developer: broken, a stuck flows run never ends, and the servers and Meilisearch its
// flows launched keep running after it is killed.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { alive, cleanUp, isolateHome, temp } from './support.js';

const home = isolateHome();
const { runMarker } = await import('../scripts/lib/paths.mjs');
const { superviseFlows } = await import('../scripts/lib/supervise.mjs');

afterEach(cleanUp);
afterAll(() => rmSync(home, { recursive: true, force: true }));

function stuckFlowsRun(runs: string, evidence: string, state: string) {
  return `
    const { spawn } = require('node:child_process');
    const { mkdirSync, writeFileSync } = require('node:fs');
    const path = require('node:path');
    const runDir = path.join(${JSON.stringify(runs)}, '382-stuck-2026-11-26T10-00-00-' + process.pid);
    mkdirSync(runDir, { recursive: true });
    const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'server.mts', ${JSON.stringify(runMarker('RUN'))}.replace('RUN', runDir)],
      { detached: true, stdio: 'ignore' });
    writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ kind: 'web', issue: '382', runDir,
      evidence: path.join(${JSON.stringify(evidence)}, 'stuck-flow'), ports: { slot: 0 }, pid: server.pid }));
    writeFileSync(${JSON.stringify(state)}, JSON.stringify({ runDir, flows: process.pid, server: server.pid }));
    for (;;) {}
  `;
}

describe.skipIf(process.platform === 'win32')('flows run past its limit', () => {
  it('ends the flows run and stops the runs it launched, their detached servers included', async () => {
    const runs = temp('runs');
    const state = path.join(temp('state'), 'state.json');
    const lines: string[] = [];
    const error = console.error;
    console.error = (line: string) => { lines.push(line); };
    let code: number;
    try {
      code = await superviseFlows(['-e', stuckFlowsRun(runs, temp('evidence'), state)], { limit: 3_000, runs });
    } finally {
      console.error = error;
    }

    const { runDir, flows, server } = JSON.parse(readFileSync(state, 'utf8')) as { runDir: string; flows: number; server: number };
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^flows run ran past its limit of 3000 ms/u);
    expect(lines).toContain(`flow stuck-flow was still running; stopped its run (server ${server})`);
    expect(alive(flows)).toBe(false);
    expect(alive(server)).toBe(false);
    expect(existsSync(runDir)).toBe(false);
  });
});
