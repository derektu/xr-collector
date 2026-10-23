// Which processes belong to a verify run. Only server.mts under node and an app's main executable
// (development Electron or a packaged app) carrying the run marker, and Meilisearch with its data in the run, count; stop and sweep end those and nothing else,
// even processes whose command line mentions the marker or the run directory.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { alive, cleanUp, deadPid, isolateHome, mentioning, repository, start, temp, until } from './support.js';

const home = isolateHome();
const { isRunProcess, isUnmarkedAppInstance, runMarker, runsRoot, SLOT_LOCKS } = await import('../../../.claude/skills/verify/scripts/lib/paths.mjs');
const { runProcesses, stopRun, sweepStale } = await import('../../../.claude/skills/verify/scripts/lib/instance.mjs');

beforeAll(() => expect(SLOT_LOCKS).toBe(path.join(home, '.xr-collector', 'verify-slots')));
afterEach(cleanUp);
afterAll(() => rmSync(home, { recursive: true, force: true }));

const RUN = '/work/xr/.local/verify-runs/111-2026-10-22T10-00-00-123';
const NODE = '/Users/me/.nvm/versions/node/v22.22.3/bin/node';
const ELECTRON = '/work/xr/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
const PACKAGED = '/work/xr/release/mac-arm64/XR Collector.app/Contents/MacOS/XR Collector';

describe('isRunProcess', () => {
  it('counts the Web server, Electron, the packaged app and Meilisearch of the run', () => {
    expect(isRunProcess(`${NODE} /work/xr/node_modules/.bin/tsx /work/xr/.claude/skills/verify/scripts/server.mts ${runMarker(RUN)}`, RUN, NODE)).toBe(true);
    expect(isRunProcess(`${ELECTRON} /work/xr ${runMarker(RUN)}`, RUN, ELECTRON)).toBe(true);
    expect(isRunProcess(`${PACKAGED} ${runMarker(RUN)}`, RUN, PACKAGED)).toBe(true);
    expect(isRunProcess(`/work/xr/release/mac-arm64/XR Collector.app/Contents/Resources/bin/meilisearch --db-path ${RUN}/profile/search/data.ms`, RUN, '/work/xr/release/mac-arm64/XR Collector.app/Contents/Resources/bin/meilisearch')).toBe(true);
    expect(isRunProcess(`/work/xr/resources/bin/mac/meilisearch --http-addr 127.0.0.1:7251 --db-path ${RUN}/profile/search/data.ms`, RUN, '/work/xr/resources/bin/mac/meilisearch')).toBe(true);
  });

  it('does not count other programs that mention the marker or the run directory', () => {
    const server = `${NODE} /work/xr/node_modules/.bin/tsx /work/xr/.claude/skills/verify/scripts/server.mts ${runMarker(RUN)}`;
    expect(isRunProcess(`pgrep -f ${server}`, RUN, '/usr/bin/pgrep')).toBe(false);
    expect(isRunProcess(`tail -f ${RUN}/server.log`, RUN, '/usr/bin/tail')).toBe(false);
    expect(isRunProcess(`${NODE} .claude/skills/verify/scripts/verify.mjs stop --run ${RUN}`, RUN, NODE)).toBe(false);
    expect(isRunProcess(`${NODE} flow.mjs ${runMarker(RUN)}`, RUN, NODE)).toBe(false);
    expect(isRunProcess(`/bin/zsh -c cd ${RUN} && meilisearch --db-path ${RUN}/profile/x`, RUN, '/bin/zsh')).toBe(false);
  });

  it('does not count a process without the marker or one of another run', () => {
    expect(isRunProcess(`${NODE} /work/xr/.claude/skills/verify/scripts/server.mts`, RUN, NODE)).toBe(false);
    expect(isRunProcess(`${NODE} /work/xr/.claude/skills/verify/scripts/server.mts ${runMarker(`${RUN}-2`)}`, RUN, NODE)).toBe(false);
    expect(isRunProcess(`${NODE} /work/xr/.claude/skills/verify/scripts/server.mts --xr-verify-run=${RUN}`, RUN, NODE)).toBe(false);
    expect(isRunProcess(`/opt/meilisearch --db-path ${RUN}-2/profile/search`, RUN, '/opt/meilisearch')).toBe(false);
    expect(isRunProcess(`/opt/meilisearch --db-path /elsewhere/profile/search`, RUN, '/opt/meilisearch')).toBe(false);
    expect(isRunProcess(`/Applications/XR Collector.app/Contents/MacOS/Electron ${runMarker(RUN)}`, RUN, 'Electron')).toBe(false);
    expect(isRunProcess(PACKAGED, RUN, PACKAGED)).toBe(false);
    expect(isRunProcess(`${PACKAGED} ${runMarker(`${RUN}-2`)}`, RUN, PACKAGED)).toBe(false);
    const helper = '/work/xr/release/mac-arm64/XR Collector.app/Contents/Frameworks/XR Collector Helper.app/Contents/MacOS/XR Collector Helper';
    expect(isRunProcess(`${helper} --type=renderer`, RUN, helper)).toBe(false);
  });

  it('tells the user\'s App from the same program that verify started', () => {
    const installed = '/Applications/XR Collector.app/Contents/MacOS/XR Collector';
    expect(isUnmarkedAppInstance(installed, installed, 'XR Collector')).toBe(true);
    expect(isUnmarkedAppInstance(`${PACKAGED} ${runMarker(RUN)}`, PACKAGED, 'XR Collector')).toBe(false);
    expect(isUnmarkedAppInstance(`${ELECTRON} /work/xr`, ELECTRON, 'XR Collector')).toBe(false);
    const helper = '/Applications/XR Collector.app/Contents/Frameworks/XR Collector Helper.app/Contents/MacOS/XR Collector Helper';
    expect(isUnmarkedAppInstance(`${helper} --type=renderer`, helper, 'XR Collector')).toBe(false);
  });

  it('matches a run directory with spaces only as a whole', () => {
    const spaced = '/Users/me/My Runs/111-a';
    expect(isRunProcess(`${NODE} /x/server.mts ${runMarker(spaced)}`, spaced, NODE)).toBe(true);
    expect(isRunProcess(`${NODE} /x/server.mts ${runMarker(spaced)}`, '/Users/me/My', NODE)).toBe(false);
  });
});

describe('stop and sweep with real processes', () => {
  const IDLE = 'setInterval(() => {}, 1000)';

  const SLOW = 20_000;

  /** A run folder under the main checkout's verify-runs, with run.json naming slot 0 and a PID that has exited. */
  async function makeRun(main: string, name: string, { record = true } = {}) {
    const runDir = path.join(runsRoot(main), name);
    mkdirSync(path.join(runDir, 'profile'), { recursive: true });
    writeFileSync(path.join(runDir, 'server.log'), 'server output\n');
    const evidence = temp('evidence');
    if (record) writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ kind: 'web', issue: '111', runDir, evidence, ports: { slot: 0 }, pid: await deadPid() }));
    return { runDir, evidence };
  }

  /** A stand-in for the run's Web server, leading its own process group: node running a server.mts path with the run marker. */
  const fakeServer = (runDir: string) =>
    start(process.execPath, ['-e', IDLE, path.join(runDir, '..', 'server.mts'), runMarker(runDir)], { detached: true });

  /**
   * Processes that mention the run but are not its own: pgrep-style shell, a flow script, a tail.
   * Resolves once `ps` shows each with its own command line, not the one inherited before exec.
   */
  async function decoys(runDir: string) {
    const before = mentioning(runDir).length;
    const started = [
      start('sh', ['-c', 'sleep 60; :', 'pgrep', runMarker(runDir), 'server.mts'], { detached: true }),
      start(process.execPath, ['-e', IDLE, 'flow.mjs', runMarker(runDir)], { detached: true }),
      start('tail', ['-f', path.join(runDir, 'server.log')], { detached: true }),
    ];
    await until(() => mentioning(runDir).length === before + started.length);
    return started;
  }

  it('finds only the run\'s own process', async () => {
    const { main } = repository();
    const { runDir } = await makeRun(main, '111-find');
    const server = fakeServer(runDir);
    const others = await decoys(runDir);
    await until(() => runProcesses({ runDir }).length === 1);

    expect(runProcesses({ runDir }).map((member: { pid: number }) => member.pid)).toEqual([server.pid]);
    for (const decoy of others) expect(alive(decoy.pid!)).toBe(true);
  }, SLOW);

  it('stop ends the run\'s server, keeps the other processes and the evidence', async () => {
    const { main } = repository();
    const { runDir, evidence } = await makeRun(main, '111-stop');
    const server = fakeServer(runDir);
    const others = await decoys(runDir);
    await until(() => runProcesses({ runDir }).length === 1);

    const result = await stopRun(runDir);

    expect(result).toEqual({ runDir, removed: true, evidence });
    expect(alive(server.pid!)).toBe(false);
    for (const decoy of others) expect(alive(decoy.pid!), decoy.spawnargs.join(' ')).toBe(true);
    expect(runProcesses({ runDir })).toEqual([]);
  }, SLOW);

  it('stop signals only the run\'s process when it is not its group\'s leader', async () => {
    const { main } = repository();
    const { runDir } = await makeRun(main, '111-member');
    // A shell leads the group and keeps running; the server is a member, as a Meilisearch whose
    // leader died is. Signalling the group would end the shell too.
    const leader = start('sh', ['-c', `"${process.execPath}" -e '${IDLE}' '${path.join(runDir, '..', 'server.mts')}' '${runMarker(runDir)}' & sleep 60`], { detached: true });
    await until(() => runProcesses({ runDir }).length === 1);
    const [server] = runProcesses({ runDir });
    expect(server.pgid).toBe(leader.pid);
    expect(server.pid).not.toBe(leader.pid);

    await stopRun(runDir);

    expect(alive(server.pid)).toBe(false);
    expect(alive(leader.pid!)).toBe(true);
  }, SLOW);

  it('sweep removes runs with no process of their own and keeps the rest', async () => {
    const { main } = repository();
    const idle = await makeRun(main, '111-idle');
    const running = await makeRun(main, '111-running');
    const building = await makeRun(main, '111-building', { record: false });
    const broken = await makeRun(main, '111-broken');
    writeFileSync(path.join(broken.runDir, 'run.json'), '{');
    const server = fakeServer(running.runDir);
    const others = await decoys(idle.runDir);
    await until(() => runProcesses({ runDir: running.runDir }).length === 1);

    const result = sweepStale(main);

    expect(result).toEqual({ removed: ['111-idle'], live: ['111-running'], unreadable: ['111-broken'] });
    expect(alive(server.pid!)).toBe(true);
    for (const decoy of others) expect(alive(decoy.pid!)).toBe(true);
    expect(existsSync(building.runDir)).toBe(true);
    expect(existsSync(broken.runDir)).toBe(true);
    expect(existsSync(idle.runDir)).toBe(false);
  }, SLOW);
});
