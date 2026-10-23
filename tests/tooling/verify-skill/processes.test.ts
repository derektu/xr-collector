// Which processes belong to a verify run. Only server.mts under node and an app's main executable
// (development Electron or a packaged app) carrying the run marker, and Meilisearch with its data in
// the run, count; stop and sweep end those and nothing else, even processes whose command line
// mentions the marker or the run directory. On Windows the app is the executable run.json records as
// the run's target, and stop ends each run process with the processes it started.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { alive, cleanUp, deadPid, isolateHome, mentioning, repository, start, temp, until } from './support.js';

const home = isolateHome();
const { isRunProcess, isUnmarkedAppInstance, runMarker, runsRoot, SLOT_LOCKS, windowsArgs } = await import('../../../.claude/skills/verify/scripts/lib/paths.mjs');
const { runProcesses, stopRun, sweepStale } = await import('../../../.claude/skills/verify/scripts/lib/instance.mjs');

beforeAll(() => expect(SLOT_LOCKS).toBe(path.join(home, '.xr-collector', 'verify-slots')));
afterEach(cleanUp);
afterAll(() => rmSync(home, { recursive: true, force: true }));

const RUN = '/work/xr/.local/verify-runs/111-2026-10-22T10-00-00-123';
const NODE = '/Users/me/.nvm/versions/node/v22.22.3/bin/node';
const ELECTRON = '/work/xr/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
const PACKAGED = '/work/xr/release/mac-arm64/XR Collector.app/Contents/MacOS/XR Collector';

// macOS and Linux rules, checked on every platform.
const POSIX = { platform: 'darwin' };

describe('isRunProcess', () => {
  it('counts the Web server, Electron, the packaged app and Meilisearch of the run', () => {
    expect(isRunProcess(`${NODE} /work/xr/node_modules/.bin/tsx /work/xr/.claude/skills/verify/scripts/server.mts ${runMarker(RUN)}`, RUN, NODE, POSIX)).toBe(true);
    expect(isRunProcess(`${ELECTRON} /work/xr ${runMarker(RUN)}`, RUN, ELECTRON, POSIX)).toBe(true);
    expect(isRunProcess(`${PACKAGED} ${runMarker(RUN)}`, RUN, PACKAGED, POSIX)).toBe(true);
    expect(isRunProcess(`/work/xr/release/mac-arm64/XR Collector.app/Contents/Resources/bin/meilisearch --db-path ${RUN}/profile/search/data.ms`, RUN, '/work/xr/release/mac-arm64/XR Collector.app/Contents/Resources/bin/meilisearch', POSIX)).toBe(true);
    expect(isRunProcess(`/work/xr/resources/bin/mac/meilisearch --http-addr 127.0.0.1:7251 --db-path ${RUN}/profile/search/data.ms`, RUN, '/work/xr/resources/bin/mac/meilisearch', POSIX)).toBe(true);
  });

  it('does not count other programs that mention the marker or the run directory', () => {
    const server = `${NODE} /work/xr/node_modules/.bin/tsx /work/xr/.claude/skills/verify/scripts/server.mts ${runMarker(RUN)}`;
    expect(isRunProcess(`pgrep -f ${server}`, RUN, '/usr/bin/pgrep', POSIX)).toBe(false);
    expect(isRunProcess(`tail -f ${RUN}/server.log`, RUN, '/usr/bin/tail', POSIX)).toBe(false);
    expect(isRunProcess(`${NODE} .claude/skills/verify/scripts/verify.mjs stop --run ${RUN}`, RUN, NODE, POSIX)).toBe(false);
    expect(isRunProcess(`${NODE} flow.mjs ${runMarker(RUN)}`, RUN, NODE, POSIX)).toBe(false);
    expect(isRunProcess(`/bin/zsh -c cd ${RUN} && meilisearch --db-path ${RUN}/profile/x`, RUN, '/bin/zsh', POSIX)).toBe(false);
  });

  it('does not count a process without the marker or one of another run', () => {
    expect(isRunProcess(`${NODE} /work/xr/.claude/skills/verify/scripts/server.mts`, RUN, NODE, POSIX)).toBe(false);
    expect(isRunProcess(`${NODE} /work/xr/.claude/skills/verify/scripts/server.mts ${runMarker(`${RUN}-2`)}`, RUN, NODE, POSIX)).toBe(false);
    expect(isRunProcess(`${NODE} /work/xr/.claude/skills/verify/scripts/server.mts --xr-verify-run=${RUN}`, RUN, NODE, POSIX)).toBe(false);
    expect(isRunProcess(`/opt/meilisearch --db-path ${RUN}-2/profile/search`, RUN, '/opt/meilisearch', POSIX)).toBe(false);
    expect(isRunProcess(`/opt/meilisearch --db-path /elsewhere/profile/search`, RUN, '/opt/meilisearch', POSIX)).toBe(false);
    expect(isRunProcess(`/Applications/XR Collector.app/Contents/MacOS/Electron ${runMarker(RUN)}`, RUN, 'Electron', POSIX)).toBe(false);
    expect(isRunProcess(PACKAGED, RUN, PACKAGED, POSIX)).toBe(false);
    expect(isRunProcess(`${PACKAGED} ${runMarker(`${RUN}-2`)}`, RUN, PACKAGED, POSIX)).toBe(false);
    const helper = '/work/xr/release/mac-arm64/XR Collector.app/Contents/Frameworks/XR Collector Helper.app/Contents/MacOS/XR Collector Helper';
    expect(isRunProcess(`${helper} --type=renderer`, RUN, helper, POSIX)).toBe(false);
  });

  it('tells the user\'s App from the same program that verify started', () => {
    const installed = '/Applications/XR Collector.app/Contents/MacOS/XR Collector';
    expect(isUnmarkedAppInstance(installed, installed, 'XR Collector', POSIX)).toBe(true);
    expect(isUnmarkedAppInstance(`${PACKAGED} ${runMarker(RUN)}`, PACKAGED, 'XR Collector', POSIX)).toBe(false);
    expect(isUnmarkedAppInstance(`${ELECTRON} /work/xr`, ELECTRON, 'XR Collector', POSIX)).toBe(false);
    const helper = '/Applications/XR Collector.app/Contents/Frameworks/XR Collector Helper.app/Contents/MacOS/XR Collector Helper';
    expect(isUnmarkedAppInstance(`${helper} --type=renderer`, helper, 'XR Collector', POSIX)).toBe(false);
  });

  it('matches a run directory with spaces only as a whole', () => {
    const spaced = '/Users/me/My Runs/111-a';
    expect(isRunProcess(`${NODE} /x/server.mts ${runMarker(spaced)}`, spaced, NODE, POSIX)).toBe(true);
    expect(isRunProcess(`${NODE} /x/server.mts ${runMarker(spaced)}`, '/Users/me/My', NODE, POSIX)).toBe(false);
  });
});

describe('isRunProcess on Windows', () => {
  const WIN = { platform: 'win32' };
  const RUN_W = 'C:\\work\\xr\\.local\\verify-runs\\113-2026-10-23T10-00-00-123-electron';
  const NODE_W = 'C:\\nvm4w\\nodejs\\node.exe';
  const ELECTRON_W = 'C:\\work\\xr\\node_modules\\electron\\dist\\electron.exe';
  const PACKAGED_W = 'C:\\work\\xr\\release\\win-unpacked\\XR Collector.exe';
  const MEILI_W = 'C:\\work\\xr\\release\\win-unpacked\\resources\\bin\\meilisearch.exe';
  const marker = runMarker(RUN_W);

  it('splits a command line the way Windows does', () => {
    expect(windowsArgs(`"${PACKAGED_W}" --inspect=0 "${marker}"`)).toEqual([PACKAGED_W, '--inspect=0', marker]);
    expect(windowsArgs('a "b c" d\\\\"e f"\\"g')).toEqual(['a', 'b c', 'd\\e f"g']);
  });

  it('counts the run\'s recorded app, the Web server and Meilisearch of the run', () => {
    expect(isRunProcess(`"${ELECTRON_W}" --inspect=0 --remote-debugging-port=0 . ${marker}`, RUN_W, ELECTRON_W, { ...WIN, apps: [ELECTRON_W] })).toBe(true);
    expect(isRunProcess(`"${PACKAGED_W}" "${marker}"`, RUN_W, PACKAGED_W, { ...WIN, apps: [PACKAGED_W] })).toBe(true);
    // Windows paths compare without case.
    expect(isRunProcess(`"${PACKAGED_W}" ${marker}`, RUN_W, PACKAGED_W.toUpperCase(), { ...WIN, apps: [PACKAGED_W] })).toBe(true);
    expect(isRunProcess(`"${NODE_W}" C:\\work\\xr\\.claude\\skills\\verify\\scripts\\server.mts ${marker}`, RUN_W, NODE_W, WIN)).toBe(true);
    expect(isRunProcess(`"${MEILI_W}" --http-addr 127.0.0.1:7251 --db-path ${RUN_W}\\profile\\search\\data.ms`, RUN_W, MEILI_W, WIN)).toBe(true);
    expect(isRunProcess(`"${MEILI_W}" --db-path "${RUN_W}\\profile\\search"`, RUN_W, MEILI_W, WIN)).toBe(true);
  });

  it('matches the run marker without case, as `stop --run` may name the folder in another case', () => {
    const lower = RUN_W.toLowerCase();
    expect(isRunProcess(`"${PACKAGED_W}" "${marker}"`, lower, PACKAGED_W, { ...WIN, apps: [PACKAGED_W] })).toBe(true);
    expect(isRunProcess(`"${NODE_W}" server.mts ${marker}`, lower, NODE_W, WIN)).toBe(true);
    expect(isRunProcess(`"${PACKAGED_W}" "${runMarker(`${lower}-2`)}"`, RUN_W, PACKAGED_W, { ...WIN, apps: [PACKAGED_W] })).toBe(false);
  });

  it('does not count other programs that mention the marker or the run directory', () => {
    expect(isRunProcess(`cmd.exe /c ping -n 60 127.0.0.1 & rem ${marker} server.mts`, RUN_W, 'C:\\Windows\\System32\\cmd.exe', { ...WIN, apps: [ELECTRON_W] })).toBe(false);
    expect(isRunProcess(`powershell.exe -Command "Get-Content -Wait ${RUN_W}\\server.log"`, RUN_W, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', WIN)).toBe(false);
    expect(isRunProcess(`"${NODE_W}" flow.mjs ${marker}`, RUN_W, NODE_W, { ...WIN, apps: [ELECTRON_W] })).toBe(false);
    // Electron without a recorded target is not counted: on Windows the executable alone says nothing.
    expect(isRunProcess(`"${ELECTRON_W}" . ${marker}`, RUN_W, ELECTRON_W, WIN)).toBe(false);
    expect(isRunProcess(`"${ELECTRON_W}" . ${runMarker(`${RUN_W}-2`)}`, RUN_W, ELECTRON_W, { ...WIN, apps: [ELECTRON_W] })).toBe(false);
    expect(isRunProcess(`"${PACKAGED_W}"`, RUN_W, PACKAGED_W, { ...WIN, apps: [PACKAGED_W] })).toBe(false);
    expect(isRunProcess(`"${PACKAGED_W}" --type=renderer`, RUN_W, PACKAGED_W, { ...WIN, apps: [PACKAGED_W] })).toBe(false);
    expect(isRunProcess(`"${MEILI_W}" --db-path ${RUN_W}-2\\profile\\search`, RUN_W, MEILI_W, WIN)).toBe(false);
    expect(isRunProcess(`cmd.exe /c meilisearch.exe --db-path ${RUN_W}\\profile\\x`, RUN_W, 'C:\\Windows\\System32\\cmd.exe', WIN)).toBe(false);
    expect(isRunProcess(`"${PACKAGED_W}" ${marker}`, RUN_W, null, { ...WIN, apps: [PACKAGED_W] })).toBe(false);
  });

  it('tells the user\'s App from the same program that verify started or its helpers', () => {
    const installed = 'C:\\Users\\me\\AppData\\Local\\Programs\\XR Collector\\XR Collector.exe';
    expect(isUnmarkedAppInstance(`"${installed}"`, installed, 'XR Collector.exe', WIN)).toBe(true);
    expect(isUnmarkedAppInstance(`"${PACKAGED_W}" ${marker}`, PACKAGED_W, 'XR Collector.exe', WIN)).toBe(false);
    expect(isUnmarkedAppInstance(`"${installed}" --type=gpu-process`, installed, 'XR Collector.exe', WIN)).toBe(false);
    expect(isUnmarkedAppInstance(`"${ELECTRON_W}" .`, ELECTRON_W, 'XR Collector.exe', WIN)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('stop and sweep with real processes', () => {
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

describe.runIf(process.platform === 'win32')('stop and sweep with real Windows processes', () => {
  // Node reads options after `-e <script>` too; `--` passes the run marker on as an argument.
  const IDLE = 'setInterval(() => {}, 1000)';
  const SLOW = 60_000;

  /** A copy of this Node under another name, standing in for an app or Meilisearch. */
  function program(name: string) {
    const file = path.join(temp('program'), name);
    copyFileSync(process.execPath, file);
    return file;
  }

  /** An Electron run folder whose run.json records `app` as its target and a flow that has exited. */
  async function makeRun(main: string, name: string, app: string) {
    const runDir = path.join(runsRoot(main), name);
    mkdirSync(path.join(runDir, 'profile'), { recursive: true });
    writeFileSync(path.join(runDir, 'server.log'), 'app output\n');
    const evidence = temp('evidence');
    writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      kind: 'electron', issue: '113', runDir, evidence, ports: { slot: 0 }, pid: await deadPid(), start: null, target: { executable: app },
    }));
    return { runDir, evidence };
  }

  /** The app of the run: it starts a child of its own, as Electron starts its helpers. */
  const CHILD = `require('node:child_process').spawn(process.execPath, ['-e', '${IDLE}', 'helper'], { stdio: 'ignore' }); ${IDLE}`;
  const startApp = (app: string, runDir: string) => start(app, ['-e', CHILD, '--', runMarker(runDir)]);

  it('stop ends the recorded app with what it started and Meilisearch, and nothing else', async () => {
    const { main } = repository();
    const app = program('Fake App.exe');
    const meilisearch = program('meilisearch.exe');
    const { runDir, evidence } = await makeRun(main, '113-stop-electron', app);
    const appProcess = startApp(app, runDir);
    const search = start(meilisearch, ['-e', IDLE, '--', '--db-path', path.join(runDir, 'profile', 'search')]);
    const before = mentioning(runDir).length;
    const decoys = [
      // Mentions the marker and server.mts, but is cmd.
      start('cmd.exe', ['/d', '/c', `ping -n 120 127.0.0.1 > nul & rem ${runMarker(runDir)} server.mts`]),
      // Node, not the recorded app, with the marker: a flow script.
      start(process.execPath, ['-e', IDLE, '--', 'flow.mjs', runMarker(runDir)]),
      // The same program as the app without the marker: the user's App.
      start(app, ['-e', IDLE]),
      // The same program with the marker of another run.
      start(app, ['-e', IDLE, '--', runMarker(`${runDir}-2`)]),
    ];
    await until(() => runProcesses({ runDir }).length === 2, 30_000);
    await until(() => mentioning(runDir).length >= before + 2, 30_000);
    const helper = () => mentioning(' helper').length;
    await until(() => helper() === 1, 30_000);

    const result = await stopRun(runDir);

    expect(result).toEqual({ runDir, removed: true, evidence });
    expect(alive(appProcess.pid!)).toBe(false);
    expect(alive(search.pid!)).toBe(false);
    expect(helper()).toBe(0);
    for (const decoy of decoys) expect(alive(decoy.pid!), decoy.spawnargs.join(' ')).toBe(true);
    expect(runProcesses({ runDir })).toEqual([]);
  }, SLOW);

  it('sweep keeps a run whose app is alive and removes one with no process', async () => {
    const { main } = repository();
    const app = program('Fake App.exe');
    const running = await makeRun(main, '113-running', app);
    const idle = await makeRun(main, '113-idle', app);
    const appProcess = startApp(app, running.runDir);
    const decoy = start(process.execPath, ['-e', IDLE, '--', 'flow.mjs', runMarker(idle.runDir)]);
    await until(() => runProcesses({ runDir: running.runDir }).length === 1, 30_000);

    const result = sweepStale(main);

    expect(result).toEqual({ removed: ['113-idle'], live: ['113-running'], unreadable: [] });
    expect(alive(appProcess.pid!)).toBe(true);
    expect(alive(decoy.pid!)).toBe(true);
    expect(existsSync(idle.runDir)).toBe(false);
  }, SLOW);
});
