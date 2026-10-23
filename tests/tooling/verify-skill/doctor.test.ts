// What doctor reports when a run cannot start: each missing prerequisite in `missing` with its fix,
// and exit code 2. Runs the real CLI on a throwaway checkout that has neither resources/bin nor a
// build, with a throwaway HOME for the slot locks.
import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cleanUp, repository, temp } from './support.js';

const CLI = path.resolve(import.meta.dirname, '../../../.claude/skills/verify/scripts/verify.mjs');
// Lives for the whole file; cleanUp after each test removes only what temp() made.
const home = mkdtempSync(path.join(tmpdir(), 'xr-verify-home-'));
afterEach(cleanUp);
afterAll(() => rmSync(home, { recursive: true, force: true }));

interface Missing { check: string; required: boolean; path?: string; fix: string }

/** Runs doctor in `cwd` and returns its exit code and report. */
async function doctor(cwd: string, ...args: string[]) {
  const result = await promisify(execFile)(process.execPath, [CLI, 'doctor', ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home } })
    .then((done) => ({ code: 0, stdout: done.stdout }), (failed) => ({ code: failed.code as number, stdout: failed.stdout as string }));
  const report = JSON.parse(result.stdout) as {
    healthy: boolean; missing: Missing[]; checks: Record<string, { value?: string }>;
    environment: { platform: string; nodeArch: string; hostArch: string; emulated: boolean };
  };
  return { code: result.code, report, required: report.missing.filter((item) => item.required).map((item) => item.check) };
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
  it('lists a checkout without resources/bin and a packaged app that does not exist', async () => {
    const { worktree } = repository();
    const app = path.join(worktree, 'release', 'Missing.app');
    const { code, report, required } = await doctor(worktree, '--app', app);

    expect(code).toBe(2);
    expect(report.healthy).toBe(false);
    expect(required).toEqual(expect.arrayContaining(['runtimeBin', 'meilisearch', 'app']));
    expect(required.filter((check) => check.startsWith('app'))).toEqual(['app']);
    expect(report.missing.find((item) => item.check === 'runtimeBin')).toMatchObject({ path: path.join(worktree, 'resources', 'bin', 'mac'), fix: expect.stringContaining('download:runtime') });
    expect(report.missing.find((item) => item.check === 'app')).toMatchObject({ path: app, fix: expect.stringContaining('package:mac') });
  }, 30_000);

  it('lists the runtime programs a packaged app lacks', async () => {
    const { worktree } = repository();
    const app = fakeApp('101100011');
    const { code, report } = await doctor(worktree, '--app', app);
    const missingFromApp = report.missing.map((item) => item.check).filter((check) => check.startsWith('app'));

    expect(code).toBe(2);
    expect(missingFromApp.sort()).toEqual(['appDeno', 'appMeilisearch', 'appYtdlp']);
    expect(report.missing.find((item) => item.check === 'appMeilisearch')?.path).toBe(path.join(app, 'Contents', 'Resources', 'bin', 'meilisearch'));
  }, 30_000);

  it('reports an app whose fuses keep Playwright from connecting', async () => {
    const { worktree } = repository();
    const open = await doctor(worktree, '--app', fakeApp('101100011'));
    const closed = await doctor(worktree, '--app', fakeApp('101000011'));
    const unreadable = await doctor(worktree, '--app', fakeApp());

    expect(open.report.missing.map((item) => item.check)).not.toContain('appFuses');
    expect(closed.report.missing.find((item) => item.check === 'appFuses')).toMatchObject({ required: true, fix: expect.stringContaining('EnableNodeCliInspectArguments') });
    expect(unreadable.report.missing.find((item) => item.check === 'appFuses')?.fix).toContain('cannot be read');
  }, 30_000);

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
  }, 30_000);
});

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
    const { code, report, required } = await doctor(worktree, '--app', app);

    expect(code).toBe(2);
    expect(required).toEqual(expect.arrayContaining(['runtimeBin', 'meilisearch', 'app']));
    expect(required.filter((check) => check.startsWith('app'))).toEqual(['app']);
    expect(report.missing.find((item) => item.check === 'runtimeBin')).toMatchObject({ path: path.join(worktree, 'resources', 'bin', 'win'), fix: expect.stringContaining('download:runtime:win') });
    expect(report.missing.find((item) => item.check === 'meilisearch')?.path).toBe(path.join(worktree, 'resources', 'bin', 'win', 'meilisearch.exe'));
    expect(report.missing.find((item) => item.check === 'app')).toMatchObject({ path: app, fix: expect.stringContaining('package:win') });
    expect(report.missing.find((item) => item.check === 'electron')?.path).toBe(path.join(worktree, 'node_modules', 'electron', 'dist', 'electron.exe'));
  }, 60_000);

  it('lists the runtime programs a packaged .exe lacks and reads its fuses and architecture', async () => {
    const { worktree } = repository();
    const app = fakeWindowsApp('101100011');
    const { code, report } = await doctor(worktree, '--app', app);
    const missingFromApp = report.missing.map((item) => item.check).filter((check) => check.startsWith('app'));

    expect(code).toBe(2);
    expect(missingFromApp.sort()).toEqual(['appDeno', 'appMeilisearch', 'appYtdlp']);
    expect(report.missing.find((item) => item.check === 'appYtdlp')?.path).toBe(path.join(path.dirname(app), 'resources', 'bin', 'yt-dlp', 'yt-dlp.exe'));
    const closed = await doctor(worktree, '--app', fakeWindowsApp('101000011'));
    expect(closed.report.missing.find((item) => item.check === 'appFuses')).toMatchObject({ required: true, fix: expect.stringContaining('EnableNodeCliInspectArguments') });
  }, 60_000);

  it('labels a Node that runs under emulation', async () => {
    const { worktree } = repository();
    const { report } = await doctor(worktree);
    const machine = report.environment;

    expect(machine.platform).toBe('win32');
    expect(machine.emulated).toBe(machine.hostArch !== machine.nodeArch);
    if (machine.emulated) expect(report.checks.platform.value).toContain(`emulated on ${machine.hostArch}`);
  }, 60_000);
});
