// Guards the developer, not the user.
// What doctor reports when a run cannot start: each missing prerequisite in `missing` with its fix,
// and exit code 2. The rules run in this process on a throwaway checkout that has neither
// resources/bin nor a build, with a throwaway HOME for the slot locks; one case per platform runs the
// real CLI for its exit code and JSON.
import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cleanUp, isolateHome, repository, start, temp } from './support.js';
import { eventually } from '../../support/wait.js';

const CLI = path.resolve(import.meta.dirname, '../../../.claude/skills/verify/scripts/verify.mjs');
// Lives for the whole file; cleanUp after each test removes only what temp() made.
const home = isolateHome();
const { runProcesses } = await import('../../../.claude/skills/verify/scripts/lib/instance.mjs');
const { doctorReport } = await import('../../../.claude/skills/verify/scripts/lib/doctor.mjs');
afterEach(cleanUp);
afterAll(() => rmSync(home, { recursive: true, force: true }));

interface Missing { check: string; required: boolean; path?: string; fix: string }
interface Report {
  healthy: boolean; missing: Missing[]; checks: Record<string, { value?: string }>;
  environment: { platform: string; nodeArch: string; hostArch: string; emulated: boolean };
  instance?: { url: string; uiUrl: string; connection: string; health: boolean };
}
const requiredOf = (report: Report) => report.missing.filter((item) => item.required).map((item) => item.check);

/** Doctor's report for `checkout`; Chromium is present unless `chromiumPath` names a missing file. */
async function doctor(checkout: string, options: { app?: string; electron?: boolean; run?: string; chromiumPath?: string } = {}) {
  const report = await doctorReport({ checkout, chromiumPath: process.execPath, ...options }) as Report;
  return { report, required: requiredOf(report) };
}

/** Runs the doctor command in `cwd` and returns its exit code and report. */
async function doctorCli(cwd: string, ...args: string[]) {
  const result = await promisify(execFile)(process.execPath, [CLI, 'doctor', ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home } })
    .then((done) => ({ code: 0, stdout: done.stdout }), (failed) => ({ code: failed.code as number, stdout: failed.stdout as string }));
  const report = JSON.parse(result.stdout) as Report;
  return { code: result.code, report, required: requiredOf(report) };
}

/**
 * A macOS app bundle whose executable is this Node (thin, this machine's architecture), with no
 * Resources/bin. `fuses` writes an Electron Framework carrying that fuse wire.
 */
function fakeApp(fuses?: string) {
  const app = path.join(temp('app'), 'Fake.app');
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fake</string></dict></plist>`);
  symlinkSync(process.execPath, path.join(app, 'Contents', 'MacOS', 'Fake'));
  writeFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'), '');
  if (fuses) {
    const framework = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework');
    mkdirSync(framework, { recursive: true });
    const wire = Buffer.concat([Buffer.from('padding dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, fuses.length]), Buffer.from(fuses), Buffer.from('padding')]);
    writeFileSync(path.join(framework, 'Electron Framework'), wire);
  }
  return app;
}

describe.skipIf(process.platform !== 'darwin')('doctor', () => {
  it('exports the current Agent connection from an Electron run UI after reset and diagnoses the UI when Agent is unavailable', async () => {
    const runDir = temp('doctor-electron-agent');
    const checkout = path.resolve('.');
    mkdirSync(runDir, { recursive: true });
    let token = 'first-key';
    let unavailable = false;
    let agentUrl = '';
    const agent = createServer((request, response) => {
      const accepted = request.headers.authorization === `Bearer ${token}`;
      response.writeHead(accepted ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(accepted ? {
        status: 'ok', runtime: { state: 'ready' }, vaultPath: path.join(runDir, 'vault'),
      } : { error: { code: 'unauthorized' } }));
    });
    await listen(agent); agentUrl = serverUrl(agent);
    const profile = path.join(runDir, 'profile');
    const ui = createServer((request, response) => {
      if (request.url === '/api/device/agent/connection') {
        response.writeHead(unavailable ? 409 : 200, { 'content-type': 'application/json' })
          .end(JSON.stringify(unavailable ? { error: { code: 'agent_connection_unavailable' } } : { connection: { url: agentUrl, token } }));
        return;
      }
      const body = request.url === '/api/vault/setup' ? { vault: { state: 'not_ready' } }
        : request.url === '/api/vault/status' ? { state: 'not_ready', vaultPath: null }
          : request.url === '/api/search/status' ? { status: { state: 'unavailable' } }
            : request.url === '/api/health' ? { status: 'unavailable', runtime: { state: 'not_ready', profilePath: profile } } : null;
      response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
    });
    await listen(ui);
    try {
      writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
        kind: 'electron', runDir, checkout, profile, data: 'real', vault: null, pid: process.pid,
        uiUrl: serverUrl(ui), target: {}, ports: { slot: 0 },
      }));
      await startRunMember(runDir);
      token = 'reset-key';
      const reset = await doctor(checkout, { run: runDir });
      expect(reset.report.instance).toMatchObject({ url: agentUrl, connection: 'authenticated-agent-api', health: true });

      unavailable = true;
      const down = await doctor(checkout, { run: runDir });
      expect(down.report.instance).toMatchObject({ url: serverUrl(ui), uiUrl: serverUrl(ui), connection: 'ui-api-agent-unavailable', health: true });
    } finally {
      agent.close(); ui.close();
    }
  });

  it('does not contact a reused Electron UI origin after this run App stopped', async () => {
    const runDir = temp('doctor-electron-stopped');
    const checkout = path.resolve('.');
    const requests: string[] = [];
    const other = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        status: 'ok', runtime: { profilePath: path.join(runDir, 'other-profile') },
      }));
    });
    await listen(other);
    try {
      writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
        kind: 'electron', runDir, checkout, profile: path.join(runDir, 'profile'), data: 'real', vault: null,
        pid: process.pid, uiUrl: serverUrl(other), target: {}, ports: { slot: 0 },
      }));
      const checked = await doctor(checkout, { run: runDir });
      expect(checked.report.instance).toMatchObject({ connection: 'app-not-running', health: false });
      expect(requests).toEqual([]);
    } finally { other.close(); }
  });

  it('checks the UI profile before exporting a connection or reading business data', async () => {
    const runDir = temp('doctor-electron-other-profile');
    const checkout = path.resolve('.');
    const requests: string[] = [];
    const other = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        status: 'ok', runtime: { profilePath: path.join(runDir, 'other-profile') },
      }));
    });
    await listen(other);
    try {
      writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
        kind: 'electron', runDir, checkout, profile: path.join(runDir, 'profile'), data: 'real', vault: null,
        pid: process.pid, uiUrl: serverUrl(other), target: {}, ports: { slot: 0 },
      }));
      await startRunMember(runDir);
      const checked = await doctor(checkout, { run: runDir });
      expect(checked.report.instance).toMatchObject({ connection: 'ui-profile-mismatch', health: false });
      expect(requests).toEqual(['/api/health']);
    } finally { other.close(); }
  });

  it('lists a checkout without resources/bin and a packaged app that does not exist', async () => {
    const { worktree } = repository();
    const app = path.join(worktree, 'release', 'Missing.app');
    const { code, report, required } = await doctorCli(worktree, '--app', app);

    expect(code).toBe(2);
    expect(report.healthy).toBe(false);
    expect(required).toEqual(expect.arrayContaining(['runtimeBin', 'meilisearch', 'app']));
    expect(required.filter((check) => check.startsWith('app'))).toEqual(['app']);
    expect(report.missing.find((item) => item.check === 'runtimeBin')).toMatchObject({ path: path.join(worktree, 'resources', 'bin', 'mac'), fix: expect.stringContaining('download:runtime') });
    expect(report.missing.find((item) => item.check === 'app')).toMatchObject({ path: app, fix: expect.stringContaining('package:mac') });
  });

  it('lists the runtime programs a packaged app lacks', async () => {
    const { worktree } = repository();
    const app = fakeApp('101100011');
    const { report } = await doctor(worktree, { app });
    const missingFromApp = report.missing.map((item) => item.check).filter((check) => check.startsWith('app'));

    expect(report.healthy).toBe(false);
    expect(missingFromApp.sort()).toEqual(['appDeno', 'appMeilisearch', 'appYtdlp']);
    expect(report.missing.find((item) => item.check === 'appMeilisearch')?.path).toBe(path.join(app, 'Contents', 'Resources', 'bin', 'meilisearch'));
  });

  it('reports an app whose fuses keep Playwright from connecting', async () => {
    const { worktree } = repository();
    const open = await doctor(worktree, { app: fakeApp('101100011') });
    const closed = await doctor(worktree, { app: fakeApp('101000011') });
    const unreadable = await doctor(worktree, { app: fakeApp() });

    expect(open.report.missing.map((item) => item.check)).not.toContain('appFuses');
    expect(closed.report.missing.find((item) => item.check === 'appFuses')).toMatchObject({ required: true, fix: expect.stringContaining('EnableNodeCliInspectArguments') });
    expect(unreadable.report.missing.find((item) => item.check === 'appFuses')?.fix).toContain('cannot be read');
  });

  it('names an app reached through a link by its real path', async () => {
    const { desktopTarget } = await import('../../../.claude/skills/verify/scripts/lib/target.mjs');
    const { worktree } = repository();
    const app = fakeApp('101100011');
    const link = path.join(temp('link'), 'Linked.app');
    symlinkSync(app, link);
    const target = desktopTarget({ checkout: worktree, app: link });

    expect(target.app).toBe(app);
    expect(target.executable).toBe(path.join(app, 'Contents', 'MacOS', 'Fake'));
  });

  it('marks Electron prerequisites as not required when no app is given', async () => {
    const { worktree } = repository();
    const { report, required } = await doctor(worktree);
    const optional = report.missing.filter((item) => !item.required).map((item) => item.check);

    expect(optional).toEqual(expect.arrayContaining(['electron', 'electronBuild', 'deno']));
    expect(required).not.toContain('electron');
    expect(required.some((check) => check.startsWith('app'))).toBe(false);
  });

  it('requires Chromium for Web mode only', async () => {
    const { worktree } = repository();
    const chromiumPath = path.join(temp('browsers'), 'Chromium');
    const web = await doctor(worktree, { chromiumPath });
    const packaged = await doctor(worktree, { chromiumPath, app: fakeApp('101100011') });
    const electron = await doctor(worktree, { chromiumPath, electron: true });

    expect(web.required).toContain('chromium');
    for (const desktop of [packaged, electron]) {
      expect(desktop.report.missing.find((item) => item.check === 'chromium')).toMatchObject({ required: false });
    }
    expect(electron.required).toEqual(expect.arrayContaining(['electron', 'electronBuild']));
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function serverUrl(server: Server): string { return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }

async function startRunMember(runDir: string) {
  const server = path.join(runDir, 'server.mts');
  writeFileSync(server, 'setTimeout(() => {}, 30000);\n');
  const child = start(process.execPath, [server, `--xr-verify-run=${runDir}/`]);
  await eventually(() => expect(runProcesses(JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8')))
    .some((member: { holder?: boolean }) => !member.holder)).toBe(true));
  return child;
}

/**
 * A Windows app folder as electron-builder unpacks it: `Fake.exe` (a copy of this Node, so its PE
 * header names this machine's architecture) beside resources/app.asar, with no resources/bin. `fuses`
 * appends that fuse wire to the .exe, where Windows Electron keeps it.
 */
function fakeWindowsApp(fuses?: string) {
  const folder = path.join(temp('app'), 'win-unpacked');
  mkdirSync(path.join(folder, 'resources'), { recursive: true });
  const app = path.join(folder, 'Fake.exe');
  copyFileSync(process.execPath, app);
  writeFileSync(path.join(folder, 'resources', 'app.asar'), '');
  if (fuses) appendFileSync(app, Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, fuses.length]), Buffer.from(fuses)]));
  return app;
}

describe.runIf(process.platform === 'win32')('doctor on Windows', () => {
  it('lists a checkout without resources/bin/win and a packaged .exe that does not exist', async () => {
    const { worktree } = repository();
    const app = path.join(worktree, 'release', 'win-unpacked', 'Missing.exe');
    const { code, report, required } = await doctorCli(worktree, '--app', app);

    expect(code).toBe(2);
    expect(required).toEqual(expect.arrayContaining(['runtimeBin', 'meilisearch', 'app']));
    expect(required.filter((check) => check.startsWith('app'))).toEqual(['app']);
    expect(report.missing.find((item) => item.check === 'runtimeBin')).toMatchObject({ path: path.join(worktree, 'resources', 'bin', 'win'), fix: expect.stringContaining('download:runtime:win') });
    expect(report.missing.find((item) => item.check === 'meilisearch')?.path).toBe(path.join(worktree, 'resources', 'bin', 'win', 'meilisearch.exe'));
    expect(report.missing.find((item) => item.check === 'app')).toMatchObject({ path: app, fix: expect.stringContaining('package:win') });
    expect(report.missing.find((item) => item.check === 'electron')?.path).toBe(path.join(worktree, 'node_modules', 'electron', 'dist', 'electron.exe'));
  });

  it('lists the runtime programs a packaged .exe lacks and reads its fuses and architecture', async () => {
    const { worktree } = repository();
    const app = fakeWindowsApp('101100011');
    const { report } = await doctor(worktree, { app });
    const missingFromApp = report.missing.map((item) => item.check).filter((check) => check.startsWith('app'));

    expect(report.healthy).toBe(false);
    expect(missingFromApp.sort()).toEqual(['appDeno', 'appMeilisearch', 'appYtdlp']);
    expect(report.missing.find((item) => item.check === 'appYtdlp')?.path).toBe(path.join(path.dirname(app), 'resources', 'bin', 'yt-dlp', 'yt-dlp.exe'));
    const closed = await doctor(worktree, { app: fakeWindowsApp('101000011') });
    expect(closed.report.missing.find((item) => item.check === 'appFuses')).toMatchObject({ required: true, fix: expect.stringContaining('EnableNodeCliInspectArguments') });
  });

  it('labels a Node that runs under emulation', async () => {
    const { worktree } = repository();
    const { report } = await doctor(worktree);
    const machine = report.environment;

    expect(machine.platform).toBe('win32');
    expect(machine.emulated).toBe(machine.hostArch !== machine.nodeArch);
    if (machine.emulated) expect(report.checks.platform.value).toContain(`emulated on ${machine.hostArch}`);
  });
});
