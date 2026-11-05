// Guards the user's processes and the developer.
// stop ends only the run's own program: the PID run.json records, with the processes of its group
// (Meilisearch is one), and only while that PID's command line carries the run marker. Processes
// that merely mention the marker or the run folder keep running, and a recorded PID that now
// belongs to another program is refused.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { alive, cleanUp, isolateHome, start, temp } from './support.js';

const home = isolateHome();
const { runMarker } = await import('../scripts/lib/paths.mjs');
const { stopRun } = await import('../scripts/lib/instance.mjs');

afterEach(cleanUp);
afterAll(() => rmSync(home, { recursive: true, force: true }));

const IDLE = 'setInterval(() => {}, 1000)';

/** A run folder with run.json recording `pid` as its server. */
function makeRun(pid: number) {
  const runDir = path.join(temp('runs'), '111-run');
  mkdirSync(path.join(runDir, 'profile'), { recursive: true });
  writeFileSync(path.join(runDir, 'server.log'), 'server output\n');
  const evidence = temp('evidence');
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ kind: 'web', issue: '111', runDir, evidence, ports: { slot: 0 }, pid }));
  return { runDir, evidence };
}

/** Resolves once `ps` shows the process with its own command line, not the one inherited before exec. */
const started = async (pid: number, text: string) => {
  const { commandOf } = await import('../scripts/lib/platform.mjs');
  for (let tries = 0; !commandOf(pid).includes(text); tries += 1) {
    if (tries > 100) throw new Error(`PID ${pid} never showed ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe.skipIf(process.platform === 'win32')('stop with real processes', () => {
  it('ends the run\'s server with its group and leaves processes that mention the run alone', async () => {
    const runDir = path.join(temp('runs'), '111-run');
    // The log exists before `tail -f` opens it; a missing file would end `tail` on its own.
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'server.log'), '');
    // The server leads its group and starts a child, as server.mts starts Meilisearch.
    const server = start('sh', ['-c', `"${process.execPath}" -e '${IDLE}' & sleep 60`, 'server.mts', runMarker(runDir)], { detached: true });
    const decoys = [
      start(process.execPath, ['-e', IDLE, 'flow.mjs', runMarker(runDir)], { detached: true }),
      start('tail', ['-f', path.join(runDir, 'server.log')], { detached: true }),
    ];
    const evidence = temp('evidence');
    writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ kind: 'web', issue: '111', runDir, evidence, ports: { slot: 0 }, pid: server.pid }));
    await started(server.pid!, runMarker(runDir));

    const result = await stopRun(runDir);

    expect(result).toEqual({ runDir, removed: true, evidence });
    expect(alive(server.pid!)).toBe(false);
    expect(() => process.kill(-server.pid!, 0)).toThrow();
    for (const decoy of decoys) expect(alive(decoy.pid!), decoy.spawnargs.join(' ')).toBe(true);
  });
});

describe('stop with a recorded PID that is not the run\'s', () => {
  it('refuses to signal a running program whose command line lacks the run marker', async () => {
    const other = start(process.execPath, ['-e', IDLE], { detached: process.platform !== 'win32' });
    const { runDir } = makeRun(other.pid!);
    await started(other.pid!, IDLE);

    await expect(stopRun(runDir)).rejects.toThrow(/is no longer this run's program/u);
    expect(alive(other.pid!)).toBe(true);
  });
});
